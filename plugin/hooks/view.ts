import type { EngineInterface, On } from "claude-code";

export const VIEW_TOOL_NAME = "mcp__cc-enhanced__view";
export const VIEW_MAX_LINES = 1_000;
export const VIEW_MAX_CHARS = 100_000;
export const VIEW_READ_CHUNK_BYTES = 4 * 1024 * 1024;

const LF = 0x0a;
// One read of this size holds more text than a rendered range can use.
const RENDER_READ_BYTES = 512 * 1024;
const RANGE_HELP =
	"Use 30:40, 30:, :40, -30: (last 30), 50:+20 (20 lines), or 100::10 (10 lines either side). Line numbers and counts must be positive safe integers; context may be zero.";
const TEXT_ONLY =
	"view supports UTF-8 text only. Use Read for images, PDFs, notebooks, or other nontext content.";
const LARGE_FILES =
	"Files of any size work: one over 4 MiB is read in byte ranges of at most 4 MiB, scanning line feeds from its start through the requested lines, or through its end for tails and open-ended ranges.";
const REGULAR_FILES_ONLY =
	"view reads regular files only; it refuses directories, pipes, sockets, and devices without reading them.";
const TRUNCATION_NOTE = `[view truncated: output is limited to ${VIEW_MAX_LINES} content lines and ${VIEW_MAX_CHARS} characters, including this note. Request a narrower range or use Read with offset/limit.]`;
const READ_DESCRIPTION = `For numbered plain-text ranges or visible whitespace, use ${VIEW_TOOL_NAME} (file_path, range?, show_whitespace?). It supports 30:40, 30:, :40, -30:, 50:+20, and 100::10; .output files default to the last 500 lines. It reads regular UTF-8 text files of any size. Keep using Read for images, PDFs, and notebooks, and when Read permission requires approval.`;

export type ViewRange =
	| { kind: "bounds"; start: number; end?: number }
	| { kind: "tail"; count: number }
	| { kind: "count"; start: number; count: number }
	| { kind: "context"; line: number; context: number };

function rangeNumber(value: string, allowZero = false): number {
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < (allowZero ? 0 : 1)) {
		throw new Error(`Invalid range. ${RANGE_HELP}`);
	}
	return number;
}

export function parseViewRange(
	range: string | undefined,
	filePath: string,
): ViewRange {
	if (range === undefined) {
		return /\.output$/i.test(filePath)
			? { kind: "tail", count: 500 }
			: { kind: "bounds", start: 1 };
	}
	if (range.trim() !== range) {
		throw new Error(`Invalid range. ${RANGE_HELP}`);
	}
	let match = /^-(\d+):$/.exec(range);
	if (match?.[1]) return { kind: "tail", count: rangeNumber(match[1]) };
	match = /^(\d+)::(\d+)$/.exec(range);
	if (match?.[1] && match[2]) {
		return {
			kind: "context",
			line: rangeNumber(match[1]),
			context: rangeNumber(match[2], true),
		};
	}
	match = /^(\d+):\+(\d+)$/.exec(range);
	if (match?.[1] && match[2]) {
		return {
			kind: "count",
			start: rangeNumber(match[1]),
			count: rangeNumber(match[2]),
		};
	}
	match = /^(\d*):(\d*)$/.exec(range);
	if (match && (match[1] || match[2])) {
		const start = match[1] ? rangeNumber(match[1]) : 1;
		const end = match[2] ? rangeNumber(match[2]) : undefined;
		if (end === undefined || end >= start) {
			return end === undefined
				? { kind: "bounds", start }
				: { kind: "bounds", start, end };
		}
	}
	throw new Error(`Invalid range. ${RANGE_HELP}`);
}

export function resolveViewRange(
	range: ViewRange,
	totalLines: number,
): { start: number; end: number } {
	switch (range.kind) {
		case "bounds":
			return {
				start: range.start,
				end: Math.min(range.end ?? totalLines, totalLines),
			};
		case "tail":
			return {
				start: Math.max(1, totalLines - range.count + 1),
				end: totalLines,
			};
		case "count":
			return {
				start: range.start,
				end: Math.min(range.start + range.count - 1, totalLines),
			};
		case "context":
			return {
				start: Math.max(1, range.line - range.context),
				end: Math.min(range.line + range.context, totalLines),
			};
	}
}

function prefixWithinBudget(text: string, length: number): string {
	let end = Math.min(length, text.length);
	const last = text.charCodeAt(end - 1);
	if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
	return text.slice(0, end);
}

function noLinesInRange(totalLines: number): string {
	return `[no lines in the requested range; file has ${totalLines} lines]`;
}

// LF delimits lines; a terminal LF does not invent an extra empty line.
// Scan offsets instead of splitting up to 4 MiB of text into millions of strings.
export function renderViewText(
	text: string,
	range: ViewRange,
	showWhitespace = false,
): string {
	if (text.length === 0) return "[empty file]";
	let totalLines = text.endsWith("\n") ? 0 : 1;
	for (let offset = text.indexOf("\n"); offset !== -1; ) {
		totalLines++;
		offset = text.indexOf("\n", offset + 1);
	}
	const { start, end } = resolveViewRange(range, totalLines);
	if (start > end) return noLinesInRange(totalLines);
	let offset = 0;
	for (let line = 1; line < start; line++) {
		offset = text.indexOf("\n", offset) + 1;
	}
	return renderViewLines(text, offset, start, end, showWhitespace);
}

// Renders lines start..end from `text`, whose `offset` begins line `start`.
// Every rendered row uses more output characters than the text it consumes
// (its number prefix outweighs a dropped CR and its LF), so the output caps
// always truncate before the renderer reaches the end of more than
// VIEW_MAX_CHARS characters of text.
function renderViewLines(
	text: string,
	offset: number,
	start: number,
	end: number,
	showWhitespace: boolean,
): string {
	const width = String(end).length;
	const rows: string[] = [];
	let characters = 0;
	let truncated = false;
	for (let line = start; line <= end; line++) {
		if (rows.length === VIEW_MAX_LINES) {
			truncated = true;
			break;
		}
		const prefix = `${String(line).padStart(width)} │ `;
		const remaining =
			VIEW_MAX_CHARS - characters - (rows.length === 0 ? 0 : 1) - prefix.length;
		if (remaining < 0) {
			truncated = true;
			break;
		}
		const newline = text.indexOf("\n", offset);
		const lineEnd = newline === -1 ? text.length : newline;
		const contentEnd =
			!showWhitespace && newline !== -1 && text.charCodeAt(lineEnd - 1) === 13
				? lineEnd - 1
				: lineEnd;
		const contentLength = contentEnd - offset;
		const showLf = showWhitespace && newline !== -1;
		const complete = contentLength + (showLf ? 1 : 0) <= remaining;
		let cut = offset + Math.min(contentLength, remaining);
		const last = text.charCodeAt(cut - 1);
		if (cut < contentEnd && last >= 0xd800 && last <= 0xdbff) cut--;
		let content = text.slice(offset, cut);
		content = showWhitespace
			? content.replace(/[ \t\r]/g, (character) =>
					character === " " ? "·" : character === "\t" ? "→" : "␍",
				)
			: content.replace(/\r/g, "␍");
		if (complete && showLf) content += "␊";
		const row = prefix + content;
		characters += row.length + (rows.length === 0 ? 0 : 1);
		rows.push(row);
		if (!complete) {
			truncated = true;
			break;
		}
		offset = lineEnd + 1;
	}
	const rendered = rows.join("\n");
	return truncated
		? `${prefixWithinBudget(rendered, VIEW_MAX_CHARS - TRUNCATION_NOTE.length - 1)}\n${TRUNCATION_NOTE}`
		: rendered;
}

export function requiresCoreRead(filePath: string): boolean {
	return /\.(?:avif|bmp|gif|heic|heif|ico|jpe?g|png|svgz?|tiff?|webp|pdf|ipynb)$/i.test(
		filePath,
	);
}

function base64Bytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

// Decodes bytes that end on a character boundary, refusing anything that is
// not plain UTF-8 text. Only the bytes at the file's start can be a PDF.
export function decodeViewBytes(bytes: Uint8Array, atFileStart = true): string {
	let text = new TextDecoder().decode(bytes);
	// The mod decoder strips one leading BOM and has no declared ignoreBOM
	// option. Restore it, at the file's start or at the start of a range that
	// begins with U+FEFF, before checking the exact UTF-8 round trip.
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		text = `\uFEFF${text}`;
	}
	const encoded = new TextEncoder().encode(text);
	if (encoded.length !== bytes.length) throw new Error(TEXT_ONLY);
	for (let index = 0; index < bytes.length; index++) {
		if (encoded[index] !== bytes[index]) throw new Error(TEXT_ONLY);
	}
	// Refuse binary/control data instead of displaying replacement characters
	// or passing through terminal escape sequences as apparent plain text.
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)) {
		throw new Error(TEXT_ONLY);
	}
	if (atFileStart && /^\uFEFF?%PDF-/.test(text)) throw new Error(TEXT_ONLY);
	return text;
}

export function decodeViewText(base64: string): string {
	return decodeViewBytes(base64Bytes(base64));
}

// The length of the prefix of `bytes` that ends on a UTF-8 sequence boundary;
// malformed bytes count as complete so decoding refuses them.
function completeUtf8Length(bytes: Uint8Array): number {
	const length = bytes.length;
	for (let index = length - 1; index >= 0 && index >= length - 4; index--) {
		const byte = bytes[index] ?? 0;
		if ((byte & 0xc0) === 0x80) continue;
		const size = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
		return index + size > length ? index : length;
	}
	return length;
}

// Decodes consecutive byte ranges, carrying a character cut at a range's
// end into the next one.
function utf8Ranges(
	atFileStart: boolean,
): (bytes: Uint8Array, final: boolean) => string {
	let carry = new Uint8Array(0);
	let first = atFileStart;
	return (bytes, final) => {
		let joined = bytes;
		if (carry.length > 0) {
			joined = new Uint8Array(carry.length + bytes.length);
			joined.set(carry);
			joined.set(bytes, carry.length);
		}
		const complete = final ? joined.length : completeUtf8Length(joined);
		carry = joined.slice(complete);
		const text = decodeViewBytes(joined.subarray(0, complete), first);
		first = false;
		return text;
	};
}

function countLineFeeds(bytes: Uint8Array): number {
	let count = 0;
	for (let index = bytes.indexOf(LF); index !== -1; ) {
		count++;
		index = bytes.indexOf(LF, index + 1);
	}
	return count;
}

function rangeLastLine(range: ViewRange): number | undefined {
	switch (range.kind) {
		case "bounds":
			return range.end;
		case "count":
			return range.start + range.count - 1;
		case "context":
			return range.line + range.context;
		case "tail":
			return undefined;
	}
}

/** Reads at most `length` bytes from `offset`; fewer only at the file's end. */
export type ViewByteReader = (
	offset: number,
	length: number,
) => Promise<Uint8Array>;

// Renders a file too large for one read. The first pass reads chunks from the
// start, validating the text and counting line feeds through the last
// requested line, or through the end when the range depends on the total.
// The second pass reads again from the first requested line, only as much as
// the output caps can show. Text validation covers the bytes view read.
export async function renderViewRanges(
	read: ViewByteReader,
	range: ViewRange,
	showWhitespace = false,
): Promise<string> {
	const lastLine = rangeLastLine(range);
	// Line feeds before each chunk; chunk k starts at k * VIEW_READ_CHUNK_BYTES.
	const lineFeedsBefore: number[] = [];
	const validate = utf8Ranges(true);
	let lineFeeds = 0;
	let size = 0;
	let lastByte = LF;
	let ended = false;
	while (!ended && (lastLine === undefined || lineFeeds < lastLine)) {
		const bytes = await read(size, VIEW_READ_CHUNK_BYTES);
		ended = bytes.length < VIEW_READ_CHUNK_BYTES;
		lineFeedsBefore.push(lineFeeds);
		validate(bytes, ended);
		lineFeeds += countLineFeeds(bytes);
		lastByte = bytes[bytes.length - 1] ?? lastByte;
		size += bytes.length;
	}
	if (size === 0) return "[empty file]";
	// Stopping early means the last requested line ended inside the file.
	const totalLines = lineFeeds + (ended && lastByte !== LF ? 1 : 0);
	const { start, end } = resolveViewRange(range, totalLines);
	if (start > end) return noLinesInRange(totalLines);
	let offset = 0;
	if (start > 1) {
		// Find the line feed that ends line start - 1.
		let chunk = lineFeedsBefore.length - 1;
		while (chunk > 0 && (lineFeedsBefore[chunk] ?? 0) >= start - 1) chunk--;
		const chunkOffset = chunk * VIEW_READ_CHUNK_BYTES;
		const bytes = await read(chunkOffset, VIEW_READ_CHUNK_BYTES);
		let index = -1;
		for (let seen = lineFeedsBefore[chunk] ?? 0; seen < start - 1; seen++) {
			index = bytes.indexOf(LF, index + 1);
			if (index === -1) throw new Error("the file changed while view read it.");
		}
		offset = chunkOffset + index + 1;
	}
	const decode = utf8Ranges(offset === 0);
	const lineLimit = Math.min(end - start + 1, VIEW_MAX_LINES);
	let text = "";
	let lines = 0;
	for (;;) {
		const bytes = await read(offset, RENDER_READ_BYTES);
		const final = bytes.length < RENDER_READ_BYTES;
		text += decode(bytes, final);
		lines += countLineFeeds(bytes);
		offset += bytes.length;
		if (final || lines >= lineLimit || text.length > VIEW_MAX_CHARS) break;
	}
	return renderViewLines(text, 0, start, end, showWhitespace);
}

class ViewReadError extends Error {}

function readFailure(error: unknown): ViewReadError {
	return new ViewReadError(
		`view could not read the file: ${error instanceof Error ? error.message : String(error)}.`,
	);
}

export async function registerViewTool($: EngineInterface): Promise<void> {
	await $.tool.register({
		name: "view",
		description: `Read UTF-8 text with bat-style line numbers and no color. ${RANGE_HELP} Omit range for the full file (subject to output limits), except .output files default to the last 500 lines. show_whitespace displays space as ·, tab as →, CR as ␍, and LF as ␊. Output is capped at ${VIEW_MAX_LINES} content lines and ${VIEW_MAX_CHARS} characters. ${LARGE_FILES} ${REGULAR_FILES_ONLY} ${TEXT_ONLY} Read permission must already allow the path; use Read when approval is required.`,
		inputSchema: {
			type: "object",
			properties: {
				file_path: { type: "string", minLength: 1 },
				range: { type: "string", description: RANGE_HELP },
				show_whitespace: { type: "boolean", default: false },
			},
			required: ["file_path"],
			additionalProperties: false,
		},
		isDeferred: false,
	});
}

export function registerViewMods(on: On): void {
	on("tool.call", { tool: VIEW_TOOL_NAME }, async ($, e) => {
		if (
			typeof e.file_path !== "string" ||
			e.file_path.length === 0 ||
			e.file_path.includes("\0")
		) {
			return {
				deny: "view requires a nonempty file_path without NUL characters.",
			};
		}
		if (e.range !== undefined && typeof e.range !== "string") {
			return { deny: `Invalid range. ${RANGE_HELP}` };
		}
		if (
			e.show_whitespace !== undefined &&
			typeof e.show_whitespace !== "boolean"
		) {
			return { deny: "show_whitespace must be a boolean." };
		}
		const filePath = e.file_path;
		const showWhitespace = e.show_whitespace;
		try {
			const range = parseViewRange(e.range, filePath);
			const permission = await $.tool.check({
				tool: "Read",
				input: { file_path: filePath },
			});
			// check is a query, not a permission dialog; ask is not authorization.
			if (permission.decision !== "allow") {
				return {
					deny:
						permission.decision === "ask"
							? `Read permission requires approval. Use Read to request it; view did not access the file.${permission.reason ? ` ${permission.reason}` : ""}`
							: `Read permission denied; view did not access the file.${permission.reason ? ` ${permission.reason}` : ""}`,
				};
			}
			if (requiresCoreRead(filePath)) return { deny: TEXT_ONLY };
			// A read of a named pipe or device could block or consume its data.
			const stat = await $.fs.stat(filePath).catch((error: unknown) => {
				throw readFailure(error);
			});
			if (stat.kind !== "file") {
				return {
					deny: `${REGULAR_FILES_ONLY} ${filePath} is ${stat.kind === "dir" ? "a directory" : "not a regular file"}; view did not read it.`,
				};
			}
			if (stat.size <= VIEW_READ_CHUNK_BYTES) {
				const { base64 } = await $.fs
					.read(filePath, { as: "bytes" })
					.catch((error: unknown) => {
						throw readFailure(error);
					});
				return {
					result: renderViewText(decodeViewText(base64), range, showWhitespace),
				};
			}
			return {
				result: await renderViewRanges(
					async (offset, length) => {
						const { base64 } = await $.fs
							.read(filePath, { as: "bytes", offset, length })
							.catch((error: unknown) => {
								throw readFailure(error);
							});
						return base64Bytes(base64);
					},
					range,
					showWhitespace,
				),
			};
		} catch (error) {
			return {
				deny:
					error instanceof ViewReadError
						? error.message
						: `view refused: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	});

	on("tool.describe", { tool: "Read" }, async (_$, e, next) => {
		const result = await next(e);
		if (
			e.provider.plugin !== "engine" ||
			e.provider.tier !== "core" ||
			result.description.includes(READ_DESCRIPTION)
		) {
			return result;
		}
		return {
			...result,
			description: `${result.description}\n\n${READ_DESCRIPTION}`,
		};
	});
}
