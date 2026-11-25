import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginValidateReport } from "claude-code";
import { STRONG_CLAUDEMD_DISCLAIMER } from "../plugin/hooks/policy.js";
import {
	CLAUDE_API_SKIP,
	CLAUDE_API_TRIGGER,
} from "../plugin/hooks/skill-scope.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

/**
 * Copy the shipped plugin, exactly as the marketplace serves it, plus the
 * engine tests that `claude plugin test` runs from a plugin's directory.
 */
async function stagePlugin(destination: string): Promise<void> {
	await fs.cp(path.join(repoRoot, "plugin"), destination, {
		recursive: true,
		filter: (source) =>
			!source.includes(`${path.sep}.claude-plugin${path.sep}types`),
	});
	await fs.cp(
		path.join(repoRoot, "mods", "tests"),
		path.join(destination, "tests"),
		{
			recursive: true,
		},
	);
}

interface ModelRequest {
	model: string;
	stream?: boolean;
	tools?: Array<{
		name: string;
		description?: string;
		input_schema?: Record<string, unknown>;
		defer_loading?: boolean;
	}>;
	system?: string | Array<{ type: "text"; text: string }>;
	messages?: Array<{ role: string; content: unknown }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelRequest(value: unknown): value is ModelRequest {
	if (
		!isRecord(value) ||
		typeof value.model !== "string" ||
		(value.stream !== undefined && typeof value.stream !== "boolean")
	)
		return false;
	if (
		value.tools !== undefined &&
		(!Array.isArray(value.tools) ||
			!value.tools.every(
				(tool) =>
					isRecord(tool) &&
					typeof tool.name === "string" &&
					(tool.description === undefined ||
						typeof tool.description === "string") &&
					(tool.input_schema === undefined || isRecord(tool.input_schema)) &&
					(tool.defer_loading === undefined ||
						typeof tool.defer_loading === "boolean"),
			))
	)
		return false;
	if (
		value.messages !== undefined &&
		(!Array.isArray(value.messages) ||
			!value.messages.every(
				(message) => isRecord(message) && typeof message.role === "string",
			))
	)
		return false;
	return (
		value.system === undefined ||
		typeof value.system === "string" ||
		(Array.isArray(value.system) &&
			value.system.every(
				(block) =>
					isRecord(block) &&
					block.type === "text" &&
					typeof block.text === "string",
			))
	);
}

interface DrivenCall {
	name: string;
	input: Record<string, unknown>;
	verify: (text: string, isError: boolean) => Promise<void>;
}

function findToolResult(
	request: ModelRequest,
	id: string,
): { text: string; isError: boolean } | undefined {
	for (const message of request.messages ?? []) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (
				!isRecord(block) ||
				block.type !== "tool_result" ||
				block.tool_use_id !== id
			)
				continue;
			const text =
				typeof block.content === "string"
					? block.content
					: Array.isArray(block.content)
						? block.content
								.map((part) =>
									isRecord(part) && typeof part.text === "string"
										? part.text
										: JSON.stringify(part),
								)
								.join("\n")
						: JSON.stringify(block.content);
			return { text: text ?? "", isError: block.is_error === true };
		}
	}
	return undefined;
}

function respondToMessages(
	response: ServerResponse,
	request: ModelRequest,
	call?: DrivenCall,
	id?: string,
): void {
	const content = call
		? { type: "tool_use", id, name: call.name, input: call.input }
		: { type: "text", text: "CC_ENHANCED_MODS_OK" };
	const stopReason = call ? "tool_use" : "end_turn";
	const message = {
		id: "msg_mod_verification",
		type: "message",
		role: "assistant",
		model: request.model,
		content: [content],
		stop_reason: stopReason,
		stop_sequence: null,
		usage: { input_tokens: 100, output_tokens: 5 },
	};
	if (!request.stream) {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify(message));
		return;
	}
	response.writeHead(200, { "content-type": "text/event-stream" });
	const events = [
		{
			type: "message_start",
			message: {
				...message,
				content: [],
				stop_reason: null,
				usage: { input_tokens: 100, output_tokens: 0 },
			},
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: call
				? { ...content, input: {} }
				: { type: "text", text: "" },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: call
				? { type: "input_json_delta", partial_json: JSON.stringify(call.input) }
				: { type: "text_delta", text: "CC_ENHANCED_MODS_OK" },
		},
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: stopReason, stop_sequence: null },
			usage: { output_tokens: 5 },
		},
		{ type: "message_stop" },
	];
	for (const event of events)
		response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
	response.end();
}

interface BinaryResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

async function execBinary(
	binary: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<BinaryResult> {
	const child = spawn(binary, args, {
		cwd,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let bytes = 0;
	const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
	for (const [stream, chunks] of [
		[child.stdout, stdout],
		[child.stderr, stderr],
	] as const) {
		stream.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > 32 * 1024 * 1024) child.kill("SIGKILL");
			else chunks.push(chunk);
		});
	}
	try {
		const [code, signal] = await once(child, "close");
		return {
			code,
			signal,
			stdout: Buffer.concat(stdout).toString(),
			stderr: Buffer.concat(stderr).toString(),
		};
	} finally {
		clearTimeout(timer);
	}
}

async function runBinary(
	binary: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<string> {
	const { code, signal, stdout, stderr } = await execBinary(
		binary,
		args,
		cwd,
		env,
	);
	if (code !== 0)
		throw new Error(
			`Mod verification command failed (${signal ?? code}): ${args.join(" ")}\n${stdout}${stderr}`,
		);
	return stdout;
}

/**
 * The validate report spells names whole and uncleaned, so print a bounded
 * form with control and format characters escaped.
 */
function displayName(name: string): string {
	const printable = name.replace(
		/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
		(char) => `\\u{${(char.codePointAt(0) ?? 0).toString(16)}}`,
	);
	return printable.length > 120 ? `${printable.slice(0, 117)}...` : printable;
}

function hostCovered(host: string, declared: ReadonlySet<string>): boolean {
	if (declared.has(host)) return true;
	for (const entry of declared)
		if (entry.startsWith("*.") && host.endsWith(entry.slice(1))) return true;
	return false;
}

/**
 * Validate the staged plugin with `--strict --json` and hold the report to the
 * repository's rules: a strict pass, every host a part of the plugin names
 * covered by a declared `network.hosts` entry, and no module that forces a
 * rewrite of the descriptions a resumed thread recorded.
 */
async function verifyValidateReport(
	binary: string,
	plugin: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	const args = ["plugin", "validate", plugin, "--strict", "--json"];
	const result = await execBinary(binary, args, cwd, env);
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		parsed = undefined;
	}
	if (!isRecord(parsed) || typeof parsed.success !== "boolean")
		throw new Error(
			`claude plugin validate --strict --json printed no report (${result.signal ?? result.code}):\n${result.stdout}${result.stderr}`,
		);
	const report = parsed as PluginValidateReport;
	const files = [
		...(report.manifest ? [report.manifest] : []),
		...report.contents,
	];
	const problems: string[] = [];
	if (!report.success || !report.strict || result.code !== 0) {
		problems.push(
			`validate did not pass under --strict (success ${report.success}, strict ${report.strict}, exit ${result.signal ?? result.code}).`,
		);
		for (const file of files)
			for (const finding of [...file.errors, ...file.warnings])
				problems.push(`${file.file}: ${finding.path}: ${finding.message}`);
		if (report.directory?.failure) problems.push(report.directory.failure);
	}

	const modules = [];
	for (const file of files) {
		if (file.type !== "hooks") continue;
		if (file.modules === null)
			problems.push(
				`${file.file}: validate could not read the hooks module, so its hosts and prompt-cache use are unchecked.`,
			);
		else modules.push(...file.modules);
	}
	if (modules.length === 0)
		problems.push("validate reported no hooks module for the plugin.");
	for (const module of modules) {
		const name = displayName(module.module);
		if (module.breaksPromptCache)
			problems.push(
				`${name} spells breakPromptCache; a resumed thread must keep the tool descriptions it recorded, so remove it.`,
			);
		if (module.uses.hosts && module.uses.hosts.unread.length > 0)
			problems.push(
				`${name} calls ${module.uses.hosts.unread.map(displayName).join(" and ")} with a URL validate cannot read; spell the host out so network.hosts can cover it.`,
			);
	}

	const hosts = report.hosts;
	const covered: string[] = [];
	if (!hosts) {
		problems.push(
			"validate did not read the plugin's network hosts (report hosts is null).",
		);
	} else {
		// The plugin-wide list covers every part; a stdio server's own list covers that server.
		const pluginDeclared = new Set<string>();
		const serverDeclared = new Map<string, Set<string>>();
		for (const row of hosts.named)
			for (const source of row.sources) {
				if (source.type !== "declared") continue;
				if (source.server === undefined) pluginDeclared.add(row.host);
				else {
					const list = serverDeclared.get(source.server) ?? new Set();
					list.add(row.host);
					serverDeclared.set(source.server, list);
				}
			}
		for (const row of hosts.named) {
			const reaches = row.sources.filter(({ type }) => type !== "declared");
			if (reaches.length === 0) continue;
			const uncovered = reaches.filter(
				(source) =>
					!hostCovered(row.host, pluginDeclared) &&
					!(
						source.type === "mcp" &&
						hostCovered(row.host, serverDeclared.get(source.name) ?? new Set())
					),
			);
			if (uncovered.length === 0) covered.push(displayName(row.host));
			else
				problems.push(
					`${displayName(row.host)} is reached by ${uncovered
						.map((source) =>
							source.type === "module"
								? `module ${displayName(source.path)}`
								: source.type === "hook"
									? `hook ${displayName(source.event)}`
									: source.type === "mcp"
										? `server ${displayName(source.name)}`
										: "an unknown part",
						)
						.join(
							", ",
						)} but no network.hosts entry covers it; add it to plugin.json "network": { "hosts": [...] }.`,
				);
		}
		for (const entry of hosts.unread)
			if (entry.reason === "url")
				problems.push(
					`${entry.kind}${entry.name === undefined ? "" : ` ${displayName(entry.name)}`} reaches a URL validate cannot read, so network.hosts cannot be checked to cover it.`,
				);
	}
	if (problems.length > 0)
		throw new Error(
			`claude plugin validate --strict --json report failed the verifier:\n- ${problems.join("\n- ")}`,
		);
	console.log(
		`Plugin validate: strict pass; modules ${modules.map(({ module }) => displayName(module)).join(", ")}; reached hosts ${covered.length > 0 ? covered.join(", ") : "none"} covered by network.hosts; no module sets breakPromptCache.`,
	);
}

function firstDifferentLine(left: string, right: string): number {
	const a = left.split("\n");
	const b = right.split("\n");
	let line = 0;
	while (line < a.length && line < b.length && a[line] === b[line]) line++;
	return line + 1;
}

/**
 * Compare the mod API declarations the target binary wrote beside the staged
 * mod with the verbatim copy in `types/`. The staged copy starts without
 * generated types, so any file found here was written by the target binary.
 * The built-in tool inputs file follows the session's environment and the
 * account's server-side feature gates: which tools exist (Glob and Grep among
 * them) and their fields both differ between the verifier's local key and a
 * signed-in session. Here it must only exist; refresh it from a signed-in
 * launch.
 */
async function verifyGeneratedDeclarations(plugin: string): Promise<void> {
	const generated = path.join(plugin, ".claude-plugin", "types");
	const read = async (folder: string): Promise<Buffer | undefined> => {
		try {
			return await fs.readFile(path.join(generated, folder, "index.d.ts"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return undefined;
		}
	};
	const api = await read("claude-code");
	const tools = await read("claude-code-tools");
	const problems: string[] = [];
	if (api === undefined) {
		problems.push(
			"the launch wrote no .claude-plugin/types/claude-code/index.d.ts.",
		);
	}
	if (tools === undefined) {
		problems.push(
			"the launch wrote no .claude-plugin/types/claude-code-tools/index.d.ts.",
		);
	}
	const header =
		api?.toString("utf8").split("\n", 1)[0] ?? "no generated version line";
	const expected = await fs.readFile(
		path.join(repoRoot, "types", "claude-code.d.ts"),
	);
	if (api !== undefined && !api.equals(expected)) {
		problems.push(
			`types/claude-code.d.ts differs from the generated .claude-plugin/types/claude-code/index.d.ts (first difference at line ${firstDifferentLine(api.toString("utf8"), expected.toString("utf8"))}).`,
		);
	}
	if (problems.length > 0)
		throw new Error(
			`Mod API declarations are stale for this binary (generated header: ${JSON.stringify(header)}):\n- ${problems.join("\n- ")}\nRefresh types/claude-code.d.ts and types/claude-code-tools.d.ts verbatim from a signed-in --plugin-dir launch of this binary with CLAUDE_CODE_PLUGIN_DIR_WATCH=1, check the version header, then rerun.`,
		);
	console.log(
		`Plugin mods: generated mod API declarations match types/claude-code.d.ts byte for byte (${header}); the built-in tool inputs were generated.`,
	);
}

function toolContracts(request: ModelRequest) {
	return (request.tools ?? [])
		.map(({ name, description, input_schema, defer_loading }) => ({
			name,
			description,
			input_schema,
			defer_loading,
		}))
		.sort((left, right) => left.name.localeCompare(right.name));
}

async function verifyResumedToolDescriptions(
	scratch: string,
	configDir: string,
	capture: (args: string[]) => Promise<ModelRequest>,
	current: ModelRequest,
): Promise<void> {
	const id = randomUUID();
	const plugin = path.join(scratch, `resume-overlay-${id}`);
	const oldDescription = "CC_ENHANCED_RECORDED_DESCRIPTION";
	const retainedSection = "CC_ENHANCED_RECORDED_SECTION";
	await fs.mkdir(path.join(plugin, ".claude-plugin"), { recursive: true });
	await fs.mkdir(path.join(plugin, "hooks"));
	await fs.writeFile(
		path.join(plugin, ".claude-plugin", "plugin.json"),
		JSON.stringify({
			name: "cc-resume-overlay",
			version: "0.0.1",
			description: "Isolated recorded-description probe",
			author: { name: "cc-enhanced" },
		}),
	);
	await fs.writeFile(
		path.join(plugin, "hooks", "hooks.json"),
		'{"modules":["./register.js"]}',
	);
	const entry = path.join(plugin, "hooks", "register.js");
	await fs.writeFile(
		entry,
		[
			"export function register(on) {",
			"for (const tool of ['Bash','Agent','TodoWrite']) on('tool.describe',{tool},async($,e,next)=>{const result=await next(e);return e.provider.plugin==='engine'&&e.provider.tier==='core'?{...result,description:result.description+'\\nCC_ENHANCED_RECORDED_DESCRIPTION'}:result});",
			"on('prompt.section',{name:'session_guidance'},async($,e,next)=>{const result=await next(e);return result.text===null?result:{...result,text:result.text+'\\nCC_ENHANCED_RECORDED_SECTION'}});",
			"}",
		].join("\n"),
	);
	const seed = await capture([
		"--plugin-dir",
		plugin,
		"--session-id",
		id,
		"-p",
		"Seed the isolated resume probe.",
	]);
	assert(
		seed.tools
			?.find(({ name }) => name === "Bash")
			?.description?.includes(oldDescription),
		"Seed request did not carry the old descriptor",
	);
	const files = await fs.readdir(configDir, { recursive: true });
	const journalPath = files.find(
		(file) => path.basename(file) === `${id}.jsonl`,
	);
	assert(journalPath, "Seeded resume session was not persisted");
	const journal = await fs.readFile(path.join(configDir, journalPath), "utf8");
	const hasSnapshot = journal
		.split("\n")
		.filter(Boolean)
		.some((line) => {
			const row: unknown = JSON.parse(line);
			return (
				isRecord(row) &&
				row.type === "attachment" &&
				isRecord(row.attachment) &&
				row.attachment.type === "prompt_snapshot" &&
				JSON.stringify(row.attachment).includes(oldDescription)
			);
		});
	assert(
		hasSnapshot,
		"Seeded prompt snapshot did not record the old descriptor",
	);
	// Keep plugin identity fixed while removing only its artificial old wording.
	await fs.writeFile(
		entry,
		"export function register(on) { on('tool.describe', {tool:'Bash'}, ($,e,next)=>next(e)); }\n",
	);
	for (const attempt of [1, 2]) {
		const resumed = await capture([
			"--plugin-dir",
			plugin,
			"--resume",
			id,
			"-p",
			"Continue the isolated resume probe.",
		]);
		// A resumed thread keeps its recorded descriptions, as it keeps recorded
		// sections, so the prompt cache survives; the mod does not force a rewrite.
		const withoutDescriptions = (request: ModelRequest) =>
			toolContracts(request).map(({ description: _, ...contract }) => contract);
		assert.deepEqual(
			withoutDescriptions(resumed),
			withoutDescriptions(current),
			"Resume must keep tool schemas, inventory, and placement",
		);
		assert(
			resumed.tools
				?.find(({ name }) => name === "Bash")
				?.description?.includes(oldDescription),
			"Resume did not keep the recorded tool description",
		);
		const system =
			typeof resumed.system === "string"
				? resumed.system
				: (resumed.system ?? []).map((block) => block.text).join("\n");
		assert(
			system.includes(retainedSection),
			"Resume unexpectedly rewrote recorded system sections",
		);
		console.log(
			`Plugin mods: persisted resume ${attempt} kept recorded descriptors and sections with unchanged tools.`,
		);
	}
}

/** Validate the standalone plugin, then optionally drive a stock client against a local Messages endpoint. */
export async function verifyMods(
	binary: string,
	options: { live: boolean },
): Promise<void> {
	const scratch = await fs.mkdtemp(
		path.join(os.tmpdir(), "cc-mod-verification-"),
	);
	const resolvedBinary = path.resolve(binary);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		CLAUDE_CONFIG_DIR: path.join(scratch, "config"),
		ANTHROPIC_API_KEY: "local-mod-verification",
		DISABLE_AUTOUPDATER: "1",
		// Stock passes must not turn into Code Mode from the maintainer's shell.
		CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "0",
	};
	for (const key of [
		"ANTHROPIC_AUTH_TOKEN",
		"CLAUDE_CODE_OAUTH_TOKEN",
		"CLAUDE_CODE_USE_BEDROCK",
		"CLAUDE_CODE_USE_VERTEX",
		"CLAUDE_CODE_USE_FOUNDRY",
		"CLAUDE_CODE_ENABLE_TASKS",
		"CLAUDE_CODE_PLUGIN_DIRS",
		"CLAUDE_CODE_PLUGIN_DIR_WATCH",
		"CC_ENHANCED_DISABLE",
		"CC_ENHANCED_SUBAGENT_PROMPT_FILE",
		"CC_ENHANCED_AGENT_ROUTING_CONFIG",
	])
		delete env[key];
	try {
		const plugin = path.join(scratch, "plugin");
		await stagePlugin(plugin);
		await verifyValidateReport(resolvedBinary, plugin, scratch, env);
		console.log(
			await runBinary(resolvedBinary, ["plugin", "test", plugin], scratch, env),
		);
		if (!options.live) return;

		await fs.writeFile(
			path.join(scratch, "CLAUDE.md"),
			"CC_ENHANCED_INSTRUCTION_SENTINEL: preserve this file verbatim.\n",
		);
		const requests: ModelRequest[] = [];
		let serverError: Error | undefined;
		let drivenCalls: DrivenCall[] = [];
		const verifiedCalls = new Set<number>();
		const server = createServer(async (request, response) => {
			try {
				const chunks: Buffer[] = [];
				let length = 0;
				for await (const chunk of request) {
					const bytes = Buffer.from(chunk);
					length += bytes.length;
					if (length > 32 * 1024 * 1024)
						throw new Error("Unexpectedly large verification request");
					chunks.push(bytes);
				}
				if (request.url?.startsWith("/v1/messages/count_tokens")) {
					response.writeHead(200, { "content-type": "application/json" });
					response.end('{"input_tokens":100}');
					return;
				}
				if (
					request.method !== "POST" ||
					!request.url?.startsWith("/v1/messages")
				) {
					response.writeHead(404);
					response.end();
					return;
				}
				const payload: unknown = JSON.parse(Buffer.concat(chunks).toString());
				assert(
					isModelRequest(payload),
					"Stock client sent an invalid Messages request",
				);
				requests.push(payload);
				if (payload.tools?.some(({ name }) => name === "Bash")) {
					for (const [index, call] of drivenCalls.entries()) {
						if (verifiedCalls.has(index)) continue;
						const id = `toolu_cc_mod_${index}`;
						const result = findToolResult(payload, id);
						if (!result) {
							respondToMessages(response, payload, call, id);
							return;
						}
						await call.verify(result.text, result.isError);
						verifiedCalls.add(index);
					}
				}
				respondToMessages(response, payload);
			} catch (error) {
				serverError = error instanceof Error ? error : new Error(String(error));
				response.writeHead(400);
				response.end(
					JSON.stringify({
						type: "error",
						error: {
							type: "invalid_request_error",
							message: serverError.message,
						},
					}),
				);
			}
		});
		const listening = once(server, "listening");
		server.listen(0, "127.0.0.1");
		await listening;
		try {
			const address = server.address();
			assert(address && typeof address !== "string");
			const captureTurn = async (
				turnArgs: string[],
				legacyTodo: boolean,
				forkAvailable: boolean,
				calls: DrivenCall[] = [],
				extraEnv: NodeJS.ProcessEnv = {},
			): Promise<ModelRequest> => {
				requests.length = 0;
				serverError = undefined;
				drivenCalls = calls;
				verifiedCalls.clear();
				const output = await runBinary(
					resolvedBinary,
					[
						"--setting-sources",
						"project",
						"--strict-mcp-config",
						"--mcp-config",
						'{"mcpServers":{}}',
						"--plugin-dir",
						plugin,
						"--tools",
						// Some environments offer Glob and Grep, and stock prompt text names
						// them when present, so the live check covers that wording.
						"Bash,Read,Edit,TodoWrite,Agent,TaskCreate,TaskGet,TaskList,TaskUpdate,NotebookEdit,Glob,Grep",
						"--permission-mode",
						"acceptEdits",
						"--allowedTools",
						"Read,Edit,NotebookEdit,mcp__cc-enhanced__view,mcp__cc-enhanced__batch_edit",
						"--model",
						"claude-sonnet-4-6",
						"--output-format",
						"json",
						...turnArgs,
					],
					scratch,
					{
						...env,
						CLAUDE_CODE_ENABLE_TASKS: legacyTodo ? "0" : undefined,
						CLAUDE_CODE_FORK_SUBAGENT: forkAvailable ? "1" : "0",
						ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
						HTTP_PROXY: "",
						HTTPS_PROXY: "",
						ALL_PROXY: "",
						NO_PROXY: "127.0.0.1,localhost",
						...extraEnv,
					},
				);
				if (serverError) throw serverError;
				const result: unknown = JSON.parse(output);
				assert(isRecord(result), "Stock client did not return a result object");
				assert.equal(
					result.is_error,
					false,
					`Stock client turn failed: ${output}`,
				);
				assert.equal(
					result.result,
					"CC_ENHANCED_MODS_OK",
					"Stock client did not consume the local response",
				);
				assert.equal(
					verifiedCalls.size,
					calls.length,
					"Not all driven tool calls returned results",
				);
				const request = requests.find((request) =>
					request.tools?.some(({ name }) => name === "Bash"),
				);
				assert(request, "No model request carried the stock tool definitions");
				return request;
			};

			// Headless launches write declarations beside a --plugin-dir mod only
			// with the watch variable. Clear any earlier copy so the files checked
			// are this launch's own.
			await fs.rm(path.join(plugin, ".claude-plugin", "types"), {
				recursive: true,
				force: true,
			});
			await captureTurn(
				[
					"--no-session-persistence",
					"-p",
					"Reply with the local verification marker.",
				],
				false,
				false,
				[],
				{ CLAUDE_CODE_PLUGIN_DIR_WATCH: "1" },
			);
			await verifyGeneratedDeclarations(plugin);

			for (const legacyTodo of [false, true]) {
				for (const forkAvailable of [false, true]) {
					const capture = (args: string[]) =>
						captureTurn(args, legacyTodo, forkAvailable);
					const request = await capture([
						"--no-session-persistence",
						"-p",
						"Reply with the local verification marker.",
					]);
					const tools = request.tools;
					assert(tools, "No model request carried the tool definitions");
					const bash =
						tools.find(({ name }) => name === "Bash")?.description ?? "";
					assert(
						!bash.includes("IMPORTANT: Avoid using this tool to run"),
						"Bash retained stock dedicated-tool guidance",
					);
					assert(
						!bash.includes(
							"Communication: Output text directly (NOT echo/printf)",
						),
						"Bash retained stock communication guidance",
					);
					// Stock can omit search rows entirely when dedicated search tools are unavailable.
					assert(
						bash.includes(
							"IMPORTANT: Prefer dedicated symbol/semantic tools and modern CLI utilities",
						),
						`Bash guidance was not transformed:\n${bash}`,
					);
					if (bash.startsWith("Executes a given bash command")) {
						// Stock states the exact `cd` rule; the mod must leave it intact.
						assert(
							bash.includes(
								"Shell state does not persist. The shell environment is initialized from the user's profile",
							),
							"Bash lost the stock working-directory rule",
						);
					}
					const todo = tools.find(
						({ name }) => name === "TodoWrite",
					)?.description;
					if (legacyTodo) {
						assert(todo, "Stock client did not offer TodoWrite");
						assert(
							todo.includes(
								"Reach for it when the user hands you multiple related tasks",
							),
							"TodoWrite description was not transformed",
						);
						assert(
							!todo.includes("How do I print 'Hello World' in Python?"),
							"TodoWrite retained stock examples",
						);
					} else {
						assert.equal(
							todo,
							undefined,
							"Default task mode unexpectedly offered TodoWrite",
						);
						for (const name of [
							"TaskCreate",
							"TaskUpdate",
							"TaskGet",
							"TaskList",
						]) {
							assert(
								tools.some((tool) => tool.name === name),
								`Default task mode did not offer ${name}`,
							);
						}
					}
					const agent = tools.find(({ name }) => name === "Agent")?.description;
					assert(agent, "Stock client did not offer Agent");
					if (forkAvailable) {
						assert(
							agent.includes('pass `subagent_type: "fork"` to fork yourself.'),
							"Agent lost explicit fork selection",
						);
						assert(
							!agent.includes("## When not to use"),
							"Fork mode gained an unavailable lookup paragraph",
						);
					} else {
						assert(
							agent.includes("Serena or Probe search_code (exact: true)"),
							"Agent symbol routing was not transformed",
						);
						assert(
							!agent.includes('pass `subagent_type: "fork"` to fork yourself.'),
							"Agent advertised an unavailable fork",
						);
					}
					for (const name of ["statusline-setup", "claude-code-guide"]) {
						assert(
							!agent.includes(name),
							`Hidden built-in agent ${name} was offered`,
						);
					}
					for (const name of [
						"mcp__cc-enhanced__batch_edit",
						"mcp__cc-enhanced__view",
					]) {
						const offeredTool:
							| NonNullable<ModelRequest["tools"]>[number]
							| undefined = tools.find((candidate) => candidate.name === name);
						assert(offeredTool, `${name} was not offered`);
						assert(
							offeredTool.input_schema && offeredTool.description,
							`${name} lacks its schema or description`,
						);
						assert.notEqual(
							offeredTool.defer_loading,
							true,
							`${name} was incorrectly deferred`,
						);
					}
					assert(
						tools
							.find(({ name }) => name === "Read")
							?.description?.includes("mcp__cc-enhanced__view"),
						"Read lacks view routing",
					);
					assert(
						tools
							.find(({ name }) => name === "Edit")
							?.description?.includes("mcp__cc-enhanced__batch_edit"),
						"Edit lacks batch routing",
					);
					const system =
						typeof request.system === "string"
							? request.system
							: (request.system ?? []).map(({ text }) => text).join("\n");
					const delegation = system
						.split("\n")
						.find((line) =>
							line.includes("For broad codebase exploration or research"),
						);
					if (delegation)
						assert(
							delegation.includes("Otherwise choose by intent:"),
							"Session delegation was not transformed",
						);
					const context = (request.messages ?? [])
						.flatMap(({ content }) =>
							typeof content === "string"
								? [content]
								: Array.isArray(content)
									? content
											.filter(isRecord)
											.map((block) =>
												typeof block.text === "string" ? block.text : "",
											)
									: [],
						)
						.join("\n");
					assert(
						context.includes(STRONG_CLAUDEMD_DISCLAIMER),
						"CLAUDE.md instruction policy block was not sent",
					);
					assert(
						JSON.stringify(request).includes(
							"CC_ENHANCED_INSTRUCTION_SENTINEL: preserve this file verbatim.",
						),
						`CLAUDE.md content was changed or omitted; rendered sources: ${context.match(/Contents of [^\n]+/g)?.join("; ") ?? "none"}`,
					);
					if (context.includes("- claude-api:")) {
						assert(
							context.includes(CLAUDE_API_TRIGGER) &&
								context.includes(CLAUDE_API_SKIP),
							"Claude API skill listing was not narrowed",
						);
					}
					console.log(
						`Plugin mods: ${legacyTodo ? "legacy TodoWrite" : "default tasks"}, fork ${forkAvailable ? "enabled" : "disabled"}; transformed descriptions, tools, instructions, and agent visibility passed.`,
					);
					await verifyResumedToolDescriptions(
						scratch,
						path.join(scratch, "config"),
						capture,
						request,
					);
				}
			}

			const editPath = path.join(scratch, "batch.txt");
			const original = "\uFEFFalpha\r\nbeta\r\n";
			const edited = "\uFEFFdelta\r\nbeta\r\n";
			const notebookPath = path.join(scratch, "probe.ipynb");
			const notebook =
				'{"cells":[{"cell_type":"code","id":"probe","source":["original"],"metadata":{},"outputs":[],"execution_count":null}],"metadata":{},"nbformat":4,"nbformat_minor":5}\n';
			await fs.writeFile(editPath, original);
			await fs.writeFile(notebookPath, notebook);
			// An Edit deny rule must hold for batch_edit too: its own core Edit calls
			// skip deny rules, so the batch is decided where the model's call is.
			const protectedPath = path.join(scratch, "protected.txt");
			await fs.writeFile(protectedPath, "keep\n");
			await fs.mkdir(path.join(scratch, ".claude"), { recursive: true });
			await fs.writeFile(
				path.join(scratch, ".claude", "settings.json"),
				JSON.stringify({ permissions: { deny: [`Edit(/${protectedPath})`] } }),
			);
			await captureTurn(
				[
					"--no-session-persistence",
					"-p",
					"Exercise the supplied local verification tool sequence.",
				],
				true,
				false,
				[
					{
						name: "mcp__cc-enhanced__batch_edit",
						input: {
							file_path: editPath,
							edits: [
								{ old_string: "alpha\nbeta", new_string: "gamma\nbeta" },
								{ old_string: "gamma", new_string: "delta" },
							],
						},
						async verify(text, isError) {
							assert.equal(
								isError,
								false,
								`batch_edit on a never-read file failed: ${text}`,
							);
							assert.equal(
								await fs.readFile(editPath, "utf8"),
								edited,
								"batch_edit did not preserve BOM/CRLF or sequential edits",
							);
							assert.match(
								text,
								/1[.):]|edit 1/i,
								"batch_edit omitted a per-edit summary",
							);
							assert.match(
								text,
								/2[.):]|edit 2/i,
								"batch_edit omitted the second edit summary",
							);
						},
					},
					{
						name: "mcp__cc-enhanced__batch_edit",
						input: {
							file_path: editPath,
							edits: [
								{ old_string: "delta", new_string: "must-not-apply" },
								{ old_string: "missing", new_string: "invalid" },
							],
						},
						async verify(text, isError) {
							assert.equal(
								isError,
								true,
								"Invalid batch did not return an error",
							);
							assert.match(
								text,
								/edit 2/i,
								"Invalid batch did not identify the failed edit",
							);
							assert.equal(
								await fs.readFile(editPath, "utf8"),
								edited,
								"Invalid batch changed the file",
							);
						},
					},
					{
						name: "mcp__cc-enhanced__batch_edit",
						input: {
							file_path: protectedPath,
							edits: [{ old_string: "keep", new_string: "must-not-apply" }],
						},
						async verify(text, isError) {
							assert.equal(
								isError,
								true,
								"batch_edit ran past an Edit deny rule",
							);
							assert.match(
								text,
								/denied/i,
								"batch_edit did not report the Edit denial",
							);
							assert.equal(
								await fs.readFile(protectedPath, "utf8"),
								"keep\n",
								"batch_edit changed a file an Edit deny rule protects",
							);
						},
					},
					{
						name: "mcp__cc-enhanced__view",
						input: { file_path: editPath, range: "1:2", show_whitespace: true },
						async verify(text, isError) {
							assert.equal(isError, false, `view failed: ${text}`);
							assert.match(
								text,
								/1\s+│.*delta␍␊/,
								"view omitted numbered CRLF content",
							);
							assert.match(
								text,
								/2\s+│.*beta␍␊/,
								"view omitted the second requested line",
							);
						},
					},
					{
						name: "Grep",
						input: {
							pattern: "CC_ENHANCED_INSTRUCTION_SENTINEL",
							path: scratch,
						},
						async verify(text, isError) {
							assert.equal(
								isError,
								true,
								"Disabled Grep did not return an error",
							);
							assert.match(
								text,
								/Disabled by cc-enhanced/,
								"Disabled Grep did not return the routing message",
							);
							assert(
								!text.includes("CLAUDE.md"),
								"Disabled Grep still searched the workspace",
							);
						},
					},
					{
						name: "Read",
						input: { file_path: notebookPath },
						async verify(text, isError) {
							assert.equal(isError, false, `Notebook Read failed: ${text}`);
						},
					},
					{
						name: "NotebookEdit",
						input: {
							notebook_path: notebookPath,
							cell_id: "probe",
							new_source: "replaced-by-notebook-edit",
							edit_mode: "replace",
						},
						async verify(text, isError) {
							assert.equal(isError, false, `NotebookEdit failed: ${text}`);
							const savedText = await fs.readFile(notebookPath, "utf8");
							let saved: unknown;
							try {
								saved = JSON.parse(savedText);
							} catch {
								assert.fail(`NotebookEdit saved invalid JSON:\n${savedText}`);
							}
							assert(
								isRecord(saved) && Array.isArray(saved.cells),
								"NotebookEdit left an invalid notebook",
							);
							const cell = saved.cells.find(
								(candidate: unknown) =>
									isRecord(candidate) && candidate.id === "probe",
							);
							assert(isRecord(cell), "NotebookEdit dropped the probe cell");
							const source = Array.isArray(cell.source)
								? cell.source.join("")
								: cell.source;
							assert.equal(
								source,
								"replaced-by-notebook-edit",
								"NotebookEdit did not save the new cell source",
							);
						},
					},
				],
			);
			assert.equal(
				await fs.readFile(path.join(scratch, "CLAUDE.md"), "utf8"),
				"CC_ENHANCED_INSTRUCTION_SENTINEL: preserve this file verbatim.\n",
				"Instruction hook changed the file",
			);
			console.log(
				"Plugin mods: driven batch_edit on a never-read file, all-or-nothing validation failure, Edit deny rule, view, disabled Grep, and NotebookEdit replacing a cell passed.",
			);
		} finally {
			const closed = once(server, "close");
			server.closeAllConnections();
			server.close();
			await closed;
		}
	} finally {
		await fs.rm(scratch, { recursive: true, force: true });
	}
}
