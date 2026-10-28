import type { EngineInterface, On, PromptContextInput } from "claude-code";

const MAX_DRAWING_TEXT = 100_000;
const UNSUPPORTED_CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function absolutePath(value: string): string | undefined {
	const windows = /^[A-Za-z]:[\\/]/.test(value);
	if (!windows && (!value.startsWith("/") || value.startsWith("//"))) return;
	if (value.includes("\0") || (!windows && value.includes("\\"))) return;
	const path = windows ? value.replaceAll("\\", "/").toLowerCase() : value;
	const prefix = windows ? path.slice(0, 3) : "/";
	const parts: string[] = [];
	for (const part of path.slice(prefix.length).split("/")) {
		if (part === "..") parts.pop();
		else if (part && part !== ".") parts.push(part);
	}
	return (prefix + parts.join("/")).normalize("NFC");
}

function inside(path: string, directory: string): boolean {
	return path.startsWith(directory.endsWith("/") ? directory : `${directory}/`);
}

async function configuredFile(
	$: EngineInterface,
	path: string,
): Promise<boolean> {
	const root = absolutePath(await $.session.root());
	if (!root) return false;
	const home = /^[a-z]:\//.test(root)
		? (await $.env.get("USERPROFILE")) || (await $.env.get("HOME"))
		: await $.env.get("HOME");
	const config = absolutePath(
		(await $.env.get("CLAUDE_CONFIG_DIR")) || (home ? `${home}/.claude` : ""),
	);
	const settings = await $.settings.read();
	const requested = settings.plansDirectory;
	const plans =
		typeof requested === "string" && requested
			? (absolutePath(requested) ?? absolutePath(`${root}/${requested}`))
			: undefined;
	// The engine accepts a custom plans directory only inside the project.
	const plansRoot =
		plans && (plans === root || inside(plans, root))
			? plans
			: config && `${config}/plans`;
	if (plansRoot && path.endsWith(".md") && inside(path, plansRoot)) return true;
	if (
		config &&
		inside(path, config) &&
		/^projects\/[^/]+\/memory\/.+/.test(path.slice(config.length + 1))
	) {
		return true;
	}
	// Project settings cannot redirect auto-memory. Actual loaded paths below
	// cover host-specific locations without guessing a project-directory key.
	for (const source of ["policy", "flag", "user"] as const) {
		const value = (await $.settings.read({ source })).autoMemoryDirectory;
		if (value === undefined || value === null) continue;
		if (typeof value !== "string") return false;
		const expanded =
			home && /^~[\\/]/.test(value) ? `${home}/${value.slice(2)}` : value;
		const memory = absolutePath(expanded);
		return memory !== undefined && memory.length > 3 && inside(path, memory);
	}
	return false;
}

function diffSource(
	tool: string,
	output: Record<string, unknown>,
): string | undefined {
	if (output.staged === true || !Array.isArray(output.structuredPatch)) return;
	if (tool === "Write") {
		if (typeof output.content !== "string") return;
		if (output.type === "create") {
			if (!output.content || output.content.length > MAX_DRAWING_TEXT) return;
			const text = output.content.replaceAll("\r\n", "\n");
			const lines = text.split("\n");
			if (text.endsWith("\n")) lines.pop();
			const ending = text.endsWith("\n")
				? ""
				: "\n\\ No newline at end of file";
			return `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}${ending}`;
		}
		if (output.type !== "update" || output.content === output.originalFile)
			return;
	} else if (output.oldString === output.newString) {
		return;
	}
	const hunks: string[] = [];
	let changed = false;
	let length = 0;
	for (const hunk of output.structuredPatch) {
		if (!record(hunk) || !Array.isArray(hunk.lines)) return;
		const { oldStart, oldLines, newStart, newLines } = hunk;
		if (
			![oldStart, oldLines, newStart, newLines].every(
				(value) =>
					typeof value === "number" &&
					Number.isSafeInteger(value) &&
					value >= 0,
			)
		) {
			return;
		}
		const lines: string[] = [];
		let removed = 0;
		let added = 0;
		for (const raw of hunk.lines) {
			if (typeof raw !== "string" || raw.includes("\n")) return;
			const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
			if (line.startsWith("-")) removed++;
			else if (line.startsWith("+")) added++;
			else if (line.startsWith(" ")) {
				removed++;
				added++;
			} else if (line !== "\\ No newline at end of file") return;
			if (line.startsWith("-") || line.startsWith("+")) changed = true;
			length += line.length + 1;
			if (length > MAX_DRAWING_TEXT) return;
			lines.push(line);
		}
		if (removed !== oldLines || added !== newLines) return;
		hunks.push(
			`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@\n${lines.join("\n")}`,
		);
	}
	return changed ? hunks.join("\n") : undefined;
}

/** Record the engine's actual memory paths in session-local state. */
export async function rememberTranscriptMemory(
	$: EngineInterface,
	input: PromptContextInput,
): Promise<void> {
	if (input.instructionFiles === undefined) return;
	const files: string[] = [];
	const directories: string[] = [];
	for (const file of input.instructionFiles) {
		if (file.kind !== "memory") continue;
		const path = absolutePath(file.path);
		if (!path) continue;
		files.push(path);
		if (!file.parent && /\/MEMORY\.md$/i.test(path)) {
			directories.push(path.slice(0, path.lastIndexOf("/")) || "/");
		}
	}
	await $.state.set(
		{ plugin: "cc-enhanced", key: "memoryPaths" },
		{ files, directories },
	);
}

export function registerTranscriptMods(on: On): void {
	on("prompt.attachment", async ($, e, next) => {
		if (
			e.origin.kind === "engine" &&
			(e.type === "plan_mode" ||
				e.type === "plan_mode_reentry" ||
				e.type === "plan_mode_exit") &&
			record(e.detail) &&
			typeof e.detail.planFilePath === "string"
		) {
			const path = absolutePath(e.detail.planFilePath);
			if (path)
				await $.state.set({ plugin: "cc-enhanced", key: "planFile" }, path);
		}
		return next(e);
	});

	on("ui.render", { component: "ToolGroup" }, (_$, e, next) =>
		next({ ...e, props: { ...e.props, isExpanded: true } }),
	);
	on(
		"ui.render",
		{ component: ["ToolUse", "ToolResult"] },
		async ($, e, next) => {
			const { tool, output, isErrored } = e.props;
			if (tool !== "Edit" && tool !== "Write") return next(e);
			if (
				isErrored ||
				(e.component === "ToolUse" &&
					(e.props.isRunning || e.props.isInterrupted)) ||
				!record(output) ||
				typeof output.filePath !== "string"
			) {
				return next(e);
			}
			const path = absolutePath(output.filePath);
			if (!path) return next(e);
			const source = diffSource(tool, output);
			const label = `${tool} ${output.filePath}`;
			if (
				source === undefined ||
				label.length + source.length > MAX_DRAWING_TEXT ||
				UNSUPPORTED_CONTROL.test(label) ||
				UNSUPPORTED_CONTROL.test(source)
			) {
				return next(e);
			}
			const plan = await $.state.get({
				plugin: "cc-enhanced",
				key: "planFile",
			});
			const memory = await $.state.get({
				plugin: "cc-enhanced",
				key: "memoryPaths",
			});
			if (
				plan.value !== path &&
				!memory.value?.files.includes(path) &&
				!memory.value?.directories.some((directory) =>
					inside(path, directory),
				) &&
				!(await configuredFile($, path))
			) {
				return next(e);
			}
			const { Box, Text, Code } = $.ui.resolve(e);
			// ToolUse carries the completed result even for standalone calls.
			// Those also draw a ToolResult below it; the diff belongs in one row.
			if (e.component === "ToolResult") return Box({ children: [] });
			return Box({
				flexDirection: "column",
				children: [
					Text({ weight: "semibold", children: label }),
					Code({ format: "diff", source, path: output.filePath }),
				],
			});
		},
	);
}
