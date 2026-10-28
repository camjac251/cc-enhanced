import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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

async function runBinary(
	binary: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<string> {
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
		if (code !== 0)
			throw new Error(
				`Mod verification command failed (${signal ?? code}): ${args.join(" ")}\n${Buffer.concat(stdout).toString()}${Buffer.concat(stderr).toString()}`,
			);
		return Buffer.concat(stdout).toString();
	} finally {
		clearTimeout(timer);
	}
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
		assert.deepEqual(
			toolContracts(resumed),
			toolContracts(current),
			"Resume must refresh descriptions without changing schemas, inventory, or placement",
		);
		assert(
			!JSON.stringify(resumed.tools).includes(oldDescription),
			"Resume reused recorded stale tool descriptions",
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
			`Plugin mods: persisted resume ${attempt} refreshed descriptors and retained recorded sections.`,
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
	};
	for (const key of [
		"ANTHROPIC_AUTH_TOKEN",
		"CLAUDE_CODE_OAUTH_TOKEN",
		"CLAUDE_CODE_USE_BEDROCK",
		"CLAUDE_CODE_USE_VERTEX",
		"CLAUDE_CODE_USE_FOUNDRY",
		"CLAUDE_CODE_ENABLE_TASKS",
		"CLAUDE_CODE_PLUGIN_DIRS",
		"CC_ENHANCED_DISABLE",
		"CC_ENHANCED_SUBAGENT_PROMPT_FILE",
		"CC_ENHANCED_AGENT_ROUTING_CONFIG",
	])
		delete env[key];
	try {
		const plugin = path.join(scratch, "plugin");
		await stagePlugin(plugin);
		console.log(
			await runBinary(
				resolvedBinary,
				["plugin", "validate", plugin, "--strict"],
				scratch,
				env,
			),
		);
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
						"Bash,Read,Edit,TodoWrite,Agent,TaskCreate,TaskGet,TaskList,TaskUpdate,NotebookEdit",
						"--permission-mode",
						"acceptEdits",
						"--allowedTools",
						"Read,Edit,mcp__cc-enhanced__view,mcp__cc-enhanced__batch_edit",
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
						"CLAUDE.md wrapper was not strengthened",
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
			const notebookPath = path.join(scratch, "denied.ipynb");
			const notebook =
				'{"cells":[{"cell_type":"code","id":"probe","source":["original"],"metadata":{},"outputs":[],"execution_count":null}],"metadata":{},"nbformat":4,"nbformat_minor":5}\n';
			await fs.writeFile(editPath, original);
			await fs.writeFile(notebookPath, notebook);
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
						name: "NotebookEdit",
						input: {
							notebook_path: notebookPath,
							cell_id: "probe",
							new_source: "must-not-apply",
							edit_mode: "replace",
						},
						async verify(text, isError) {
							assert.equal(
								isError,
								true,
								"Disabled tool did not return an error",
							);
							assert.match(
								text,
								/Disabled by cc-enhanced/,
								"Disabled tool did not return the routing message",
							);
							assert.equal(
								await fs.readFile(notebookPath, "utf8"),
								notebook,
								"Disabled tool changed its target",
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
				"Plugin mods: driven batch_edit on a never-read file, all-or-nothing validation failure, view, and denied tool passed.",
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
