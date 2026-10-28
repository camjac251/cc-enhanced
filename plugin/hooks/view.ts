import type { EngineInterface, On } from "claude-code";

export const VIEW_TOOL_NAME = "mcp__cc-enhanced__view";
export const VIEW_MAX_LINES = 1_000;
export const VIEW_MAX_CHARS = 100_000;
export const VIEW_READ_LIMIT_BYTES = 4 * 1024 * 1024;

const RANGE_HELP =
	"Use 30:40, 30:, :40, -30: (last 30), 50:+20 (20 lines), or 100::10 (10 lines either side). Line numbers and counts must be positive safe integers; context may be zero.";
const TEXT_ONLY =
	"view supports UTF-8 text only. Use Read for images, PDFs, notebooks, or other nontext content.";
const READ_LIMIT =
	"view can read files up to 4 MiB only; its filesystem API cannot stream a range from a larger file. Use Read with offset/limit for larger text files.";
const TRUNCATION_NOTE = `[view truncated: output is limited to ${VIEW_MAX_LINES} content lines and ${VIEW_MAX_CHARS} characters, including this note. Request a narrower range or use Read with offset/limit.]`;
const READ_DESCRIPTION = `For numbered plain-text ranges or visible whitespace, use ${VIEW_TOOL_NAME} (file_path, range?, show_whitespace?). It supports 30:40, 30:, :40, -30:, 50:+20, and 100::10; .output files default to the last 500 lines. Files must be UTF-8 text no larger than 4 MiB. Keep using Read for larger files, images, PDFs, and notebooks, and when Read permission requires approval.`;

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

// LF delimits lines; a terminal LF does not invent an extra empty line.
// Scan offsets instead of splitting a 4 MiB file into millions of strings.
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
	if (start > end) {
		return `[no lines in the requested range; file has ${totalLines} lines]`;
	}
	const width = String(end).length;
	let offset = 0;
	for (let line = 1; line < start; line++) {
		offset = text.indexOf("\n", offset) + 1;
	}
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

export function decodeViewText(base64: string): string {
	if (base64.length > Math.ceil(VIEW_READ_LIMIT_BYTES / 3) * 4) {
		throw new Error(READ_LIMIT);
	}
	const binary = atob(base64);
	if (binary.length > VIEW_READ_LIMIT_BYTES) throw new Error(READ_LIMIT);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index);
	}
	let text = new TextDecoder().decode(bytes);
	// The mod decoder strips one leading BOM and has no declared ignoreBOM
	// option. Restore it before checking the exact UTF-8 round trip.
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
	if (/^\uFEFF?%PDF-/.test(text)) throw new Error(TEXT_ONLY);
	return text;
}

export async function registerViewTool($: EngineInterface): Promise<void> {
	await $.tool.register({
		name: "view",
		description: `Read UTF-8 text with bat-style line numbers and no color. ${RANGE_HELP} Omit range for the full file (subject to output limits), except .output files default to the last 500 lines. show_whitespace displays space as ·, tab as →, CR as ␍, and LF as ␊. Output is capped at ${VIEW_MAX_LINES} content lines and ${VIEW_MAX_CHARS} characters. ${READ_LIMIT} ${TEXT_ONLY} Read permission must already allow the path; use Read when approval is required.`,
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
		try {
			const range = parseViewRange(e.range, e.file_path);
			const permission = await $.tool.check({
				tool: "Read",
				input: { file_path: e.file_path },
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
			if (requiresCoreRead(e.file_path)) return { deny: TEXT_ONLY };
			let base64: string;
			try {
				({ base64 } = await $.fs.read(e.file_path, { as: "bytes" }));
			} catch (error) {
				return {
					deny: `view could not read the file: ${error instanceof Error ? error.message : String(error)}. ${READ_LIMIT}`,
				};
			}
			return {
				result: renderViewText(
					decodeViewText(base64),
					range,
					e.show_whitespace,
				),
			};
		} catch (error) {
			return {
				deny: `view refused: ${error instanceof Error ? error.message : String(error)}`,
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
