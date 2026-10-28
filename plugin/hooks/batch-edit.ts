import type { EngineInterface, On } from "claude-code";

type BatchEdit = {
	old_string: string;
	new_string: string;
	replace_all?: boolean;
};

type BatchEditInput = {
	file_path: string;
	edits: BatchEdit[];
};

type PlannedEdit = BatchEdit & { replacements: number };

type BatchEditPlan = { edits: PlannedEdit[]; content: string };

type BatchEditOutcome =
	| { result: string; deny?: undefined }
	| { deny: string; result?: undefined };

type BatchEditApi = {
	fs: Pick<EngineInterface["fs"], "read" | "write">;
	tool: Pick<EngineInterface["tool"], "call" | "check">;
};

const BATCH_EDIT_TOOL = "mcp__cc-enhanced__batch_edit";
const EDIT_GUIDANCE = `Use ${BATCH_EDIT_TOOL} to edit a file you have not read, or to make several replacements in one file: it needs no prior Read, matches every old_string against the file's current content, validates the whole sequential batch before calling Edit, and attempts to restore the original bytes if a call fails.`;

export function parseBatchEditInput(value: unknown): BatchEditInput {
	if (
		value === null ||
		typeof value !== "object" ||
		!("file_path" in value) ||
		!("edits" in value)
	) {
		throw new Error("Expected file_path and edits.");
	}
	const path = value.file_path;
	if (
		typeof path !== "string" ||
		path.includes("\0") ||
		!(path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path))
	) {
		throw new Error("file_path must be an absolute path.");
	}
	if (!Array.isArray(value.edits) || value.edits.length === 0) {
		throw new Error("edits must be a nonempty array.");
	}
	const edits = value.edits.map((edit: unknown, index: number) => {
		if (
			edit === null ||
			typeof edit !== "object" ||
			!("old_string" in edit) ||
			!("new_string" in edit) ||
			typeof edit.old_string !== "string" ||
			typeof edit.new_string !== "string" ||
			("replace_all" in edit &&
				edit.replace_all !== undefined &&
				typeof edit.replace_all !== "boolean")
		) {
			throw new Error(
				`Edit ${index + 1}: expected string old_string/new_string and optional boolean replace_all.`,
			);
		}
		return {
			old_string: edit.old_string,
			new_string: edit.new_string,
			replace_all: "replace_all" in edit && edit.replace_all === true,
		};
	});
	return { file_path: path, edits };
}

function normalizeNewlines(text: string): string {
	return text.replaceAll("\r\n", "\n");
}

function countMatches(text: string, needle: string): number {
	let count = 0;
	let offset = text.indexOf(needle);
	while (offset !== -1) {
		count++;
		offset = text.indexOf(needle, offset + needle.length);
	}
	return count;
}

/** Simulate on a private copy; no file or core tool is touched by validation. */
export function planBatchEdits(
	original: string,
	edits: readonly BatchEdit[],
): BatchEditPlan {
	let content = normalizeNewlines(original);
	const planned: PlannedEdit[] = [];
	for (const [index, edit] of edits.entries()) {
		const old_string = normalizeNewlines(edit.old_string);
		const new_string = normalizeNewlines(edit.new_string);
		const fail = (message: string): never => {
			throw new Error(`Edit ${index + 1}: ${message}`);
		};
		if (old_string.length === 0) fail("old_string must be nonempty.");
		if (old_string === new_string) {
			fail("old_string and new_string must differ after CRLF normalization.");
		}
		const unpairedSurrogate =
			/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
		if (
			unpairedSurrogate.test(old_string) ||
			unpairedSurrogate.test(new_string)
		) {
			fail("edit strings must be valid Unicode text.");
		}
		// Stock validates without the leading BOM, but preserves it when writing.
		const visible = content.startsWith("\uFEFF") ? content.slice(1) : content;
		const matches = countMatches(visible, old_string);
		if (matches === 0) fail("old_string was not found.");
		if (matches > 1 && !edit.replace_all) {
			fail(
				`old_string has ${matches} matches; add context or set replace_all.`,
			);
		}
		// Stock also consumes the following newline when deleting a whole line.
		const anchor =
			new_string === "" &&
			!old_string.endsWith("\n") &&
			content.includes(`${old_string}\n`)
				? `${old_string}\n`
				: old_string;
		const replacements = edit.replace_all ? countMatches(content, anchor) : 1;
		content = edit.replace_all
			? content.replaceAll(anchor, () => new_string)
			: content.replace(anchor, () => new_string);
		planned.push({
			old_string,
			new_string,
			replace_all: edit.replace_all === true,
			replacements,
		});
	}
	return { edits: planned, content };
}

/** Text writes can restore only UTF-8 that survives an exact byte roundtrip. */
export function decodeBatchEditOriginal(base64: string): string {
	const binary = atob(base64);
	const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	let text = new TextDecoder().decode(bytes);
	// The sandbox decoder strips one BOM and does not expose ignoreBOM.
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		text = `\uFEFF${text}`;
	}
	const encoded = new TextEncoder().encode(text);
	if (
		encoded.length !== bytes.length ||
		encoded.some((byte, index) => byte !== bytes[index]) ||
		text.includes("\0")
	) {
		throw new Error(
			"Only roundtrippable UTF-8 text files without NUL bytes are supported.",
		);
	}
	return text;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function restoreOriginal(
	$: BatchEditApi,
	path: string,
	original: string,
	base64: string,
): Promise<string> {
	try {
		if ((await $.fs.read(path, { as: "bytes" })).base64 === base64) {
			return "Rollback not needed: original bytes are unchanged.";
		}
	} catch {
		// A failed edit may have grown beyond the read ceiling; the saved original
		// still fits the write ceiling, so attempt restoration even if unreadable.
	}
	try {
		await $.fs.write(path, original);
		if ((await $.fs.read(path, { as: "bytes" })).base64 !== base64) {
			return "Rollback failed: restored bytes did not match the original. Inspect the file before retrying.";
		}
		return "Rollback succeeded: original bytes restored (including BOM and line endings).";
	} catch (error) {
		return `Rollback failed: ${errorMessage(error)} Inspect the file before retrying.`;
	}
}

export async function executeBatchEdit(
	$: BatchEditApi,
	input: unknown,
): Promise<BatchEditOutcome> {
	let request: BatchEditInput;
	let original: string;
	let base64: string;
	let plan: BatchEditPlan;
	try {
		request = parseBatchEditInput(input);
		const permission = await $.tool.check({
			tool: "Read",
			input: { file_path: request.file_path },
		});
		if (permission.decision !== "allow") {
			return {
				deny: `Batch edit rejected: Read permission is ${permission.decision}${permission.reason ? ` (${permission.reason})` : ""}. No edits applied.`,
			};
		}
		({ base64 } = await $.fs.read(request.file_path, { as: "bytes" }));
		original = decodeBatchEditOriginal(base64);
		plan = planBatchEdits(original, request.edits);
	} catch (error) {
		return {
			deny: `Batch edit rejected: ${errorMessage(error)} No edits applied.`,
		};
	}

	const summary: string[] = [];
	for (const [index, edit] of plan.edits.entries()) {
		try {
			const answer = await $.tool.call({
				tool: "Edit",
				file_path: request.file_path,
				old_string: edit.old_string,
				new_string: edit.new_string,
				replace_all: edit.replace_all,
			});
			if (answer.deny !== undefined) throw new Error(answer.deny);
			if (answer.isError) {
				throw new Error(answer.text ?? "Core Edit returned an error.");
			}
			if (
				answer.result !== null &&
				typeof answer.result === "object" &&
				"staged" in answer.result &&
				answer.result.staged === true
			) {
				throw new Error("Core Edit staged the change instead of applying it.");
			}
			summary.push(
				`${index + 1}. Replaced ${edit.replacements} occurrence${edit.replacements === 1 ? "" : "s"}.`,
			);
		} catch (error) {
			const rollback = await restoreOriginal(
				$,
				request.file_path,
				original,
				base64,
			);
			return {
				deny: [
					`Batch edit failed at edit ${index + 1}: ${errorMessage(error)}`,
					...summary.map((line) => `${line} (Before rollback.)`),
					`${index + 1}. Failed; later edits were not run.`,
					rollback,
				].join("\n"),
			};
		}
	}
	return { result: [`Updated ${request.file_path}:`, ...summary].join("\n") };
}

export async function registerBatchEditTool($: EngineInterface): Promise<void> {
	await $.tool.register({
		name: "batch_edit",
		description:
			"Apply one or more ordered exact replacements to one existing absolute-path UTF-8 text file. No prior Read is needed: edits are matched against the file's current content, and all of them are simulated before any core Edit runs; later edits see earlier changes. Each old_string must be nonempty and unique unless replace_all is true, and must differ from new_string. CRLF is normalized for matching. If a core Edit fails, attempt byte-exact restoration and report the rollback outcome. This is compensating rollback, not an atomic filesystem transaction.",
		isDeferred: false,
		inputSchema: {
			type: "object",
			properties: {
				file_path: { type: "string", description: "Absolute file path." },
				edits: {
					type: "array",
					minItems: 1,
					items: {
						type: "object",
						properties: {
							old_string: { type: "string", minLength: 1 },
							new_string: { type: "string" },
							replace_all: { type: "boolean" },
						},
						required: ["old_string", "new_string"],
						additionalProperties: false,
					},
				},
			},
			required: ["file_path", "edits"],
			additionalProperties: false,
		},
	});
}

export function registerBatchEditMods(on: On): void {
	on("tool.describe", { tool: "Edit" }, async (_$, e, next) => {
		const result = await next(e);
		if (
			e.provider.plugin !== "engine" ||
			e.provider.tier !== "core" ||
			result.description.includes(BATCH_EDIT_TOOL)
		) {
			return result;
		}
		return {
			...result,
			description: `${result.description}\n\n${EDIT_GUIDANCE}`,
		};
	});

	on("tool.call", { tool: BATCH_EDIT_TOOL }, ($, e) => executeBatchEdit($, e));
}
