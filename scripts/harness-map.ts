#!/usr/bin/env bun
/**
 * Build a self-contained HTML map of the live Claude Code harness.
 *
 * Sources (all read-only):
 * - newest exported-prompts/<label> dir (bundle inventories; never parses cli.js)
 * - the promoted binary via src/promote status (version + live tag roster)
 * - the platform's managed config dir (managed CLAUDE.md, appended system-prompt.md)
 * - project CLAUDE.md, .claude/{skills,agents,workflows,rules,agent-memory*}
 * - ~/.claude/{skills,agents,workflows,output-styles,plugins,agent-memory}
 * - project auto-memory dir (~/.claude/projects/<slug>/memory) with [[link]] graph
 * - ~/.claude.json (MCP server names/transports only) and settings layers
 *
 * Beyond inventory, the page renders full contents: bundle prompt-section text
 * in export order, policy and CLAUDE.md bodies, every skill/agent frontmatter
 * and body, extracted trigger lines, a trigger-mechanism table, a measured
 * context-composition bar, and agent-memory cross-linked to its agents.
 *
 * Secrets policy: env values are never rendered; command/url strings are masked.
 * Output: exported-prompts/harness-map.html (+ .json), gitignored artifacts.
 * The JSON sibling omits body/text/content fields to stay lean.
 *
 * Nothing environment-specific is baked in: paths are platform-derived or
 * flag-overridable (--project, --export-dir, --out), and every narrative line
 * in the output is conditional on what was actually found.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { status } from "../src/promote.js";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");
const home = os.homedir();

/** Upstream managed-policy directory for the current platform. */
function managedConfigDir(): string {
	if (process.platform === "darwin") {
		return "/Library/Application Support/ClaudeCode";
	}
	if (process.platform === "win32") {
		return path.join(
			process.env.PROGRAMDATA ?? "C:\\ProgramData",
			"ClaudeCode",
		);
	}
	return "/etc/claude-code";
}
const managedDir = managedConfigDir();

const BODY_CAP = 20000;

interface HarnessMapOptions {
	exportDir?: string;
	out?: string;
	projectRoot?: string;
}

interface FileDoc {
	label: string;
	filePath: string;
	sizeChars: number;
	headings: string[];
	text: string;
}

interface SkillEntry {
	name: string;
	description: string;
	source: string;
	badges: string[];
	frontmatter: Record<string, string>;
	body: string;
	filePath: string | null;
	trigger: string;
	pathActivated: boolean;
	cached: boolean;
}

interface AgentEntry {
	name: string;
	description: string;
	source: string;
	model?: string;
	frontmatter: Record<string, string>;
	body: string;
	trigger: string;
	memoryAt: string[];
}

interface WorkflowEntry {
	name: string;
	description: string;
	whenToUse: string;
	source: string;
	phaseTitles: string[];
	filePath: string;
}

interface OutputStyleEntry {
	name: string;
	description: string;
	source: string;
	keepCodingInstructions: boolean | null;
	frontmatter: Record<string, string>;
	body: string;
}

interface MemoryEntry {
	name: string;
	fileName: string;
	type: string;
	description: string;
	links: string[];
	sizeChars: number;
	body: string;
}

interface MemoryGraph {
	dirPath: string;
	files: MemoryEntry[];
	edges: Array<{ from: string; to: string }>;
	broken: Array<{ from: string; to: string }>;
	indexSizeChars: number;
}

interface AgentMemoryEntry {
	name: string;
	detail: string;
	agent: string | null;
}

interface AgentMemoryLocation {
	label: string;
	dirPath: string;
	entries: AgentMemoryEntry[];
}

interface RuleFile {
	name: string;
	heading: string;
	body: string;
}

interface RulesLocation {
	label: string;
	dirPath: string;
	files: RuleFile[];
}

interface McpServerEntry {
	name: string;
	scope: string;
	transport: string;
	target: string;
}

interface HookMatcherInfo {
	matcher: string;
	commands: string[];
}

interface SettingsLayerInfo {
	label: string;
	filePath: string;
	exists: boolean;
	sizeBytes: number;
	topKeys: string[];
	envKeys: string[];
	hooks: Array<{ event: string; matchers: HookMatcherInfo[] }>;
	permissionCounts: { allow: number; deny: number; ask: number } | null;
}

interface PromotedInfo {
	buildPath: string;
	version: string;
	patchTags: string[];
	isPatched: boolean;
}

interface ExportInfo {
	dirPath: string;
	label: string;
	generatedAt: string | null;
	counts: Record<string, number>;
}

interface LayerConstituent {
	name: string;
	origin: "upstream" | "ours" | "mixed";
	detail: string;
}

interface LayerCard {
	title: string;
	origin: "upstream" | "ours" | "mixed";
	summary: string;
	constituents: LayerConstituent[];
}

interface BundleSection {
	heading: string;
	content: string;
	sizeChars: number;
}

interface CompositionSegment {
	label: string;
	chars: number;
	kind: "up" | "loc" | "mix";
	approx: boolean;
}

interface TriggerRow {
	mechanism: string;
	when: string;
	surfaces: string;
}

interface HarnessModel {
	generatedAt: string;
	repoRoot: string;
	projectRoot: string;
	policyFilePath: string;
	promoted: PromotedInfo | null;
	exportInfo: ExportInfo | null;
	layers: LayerCard[];
	composition: CompositionSegment[];
	triggerRows: TriggerRow[];
	policyFile: FileDoc | null;
	managedClaudeMd: FileDoc | null;
	projectClaudeMd: FileDoc | null;
	bundleSections: BundleSection[];
	skills: SkillEntry[];
	agents: AgentEntry[];
	workflows: WorkflowEntry[];
	outputStyles: OutputStyleEntry[];
	memory: MemoryGraph | null;
	agentMemory: AgentMemoryLocation[];
	rules: RulesLocation[];
	mcpServers: McpServerEntry[];
	settingsLayers: SettingsLayerInfo[];
}

function safeRead(filePath: string): string | null {
	try {
		return fs.readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
}

function safeJson<T>(filePath: string): T | null {
	const raw = safeRead(filePath);
	if (raw === null) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

function listDir(dirPath: string): string[] {
	try {
		return fs.readdirSync(dirPath);
	} catch {
		return [];
	}
}

function statSize(filePath: string): number {
	try {
		return fs.statSync(filePath).size;
	} catch {
		return 0;
	}
}

function approxTokens(chars: number): string {
	return `~${Math.max(1, Math.round(chars / 4)).toLocaleString("en-US")} tok`;
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function slugId(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

function extractHeadings(text: string): string[] {
	return text
		.split("\n")
		.filter((line) => /^#{1,3} \S/.test(line))
		.map((line) => line.replace(/^#+\s*/, "").trim());
}

function readFileDoc(label: string, filePath: string): FileDoc | null {
	const text = safeRead(filePath);
	if (text === null) return null;
	return {
		label,
		filePath,
		sizeChars: text.length,
		headings: extractHeadings(text),
		text,
	};
}

/**
 * Tolerant frontmatter reader: top-level scalars, one nested level as
 * dotted keys, and folded/literal block scalars collapsed to one line.
 */
function parseFrontmatter(text: string): {
	data: Record<string, string>;
	body: string;
} {
	if (!text.startsWith("---")) return { data: {}, body: text };
	const end = text.indexOf("\n---", 3);
	if (end === -1) return { data: {}, body: text };
	const rawBlock = text.slice(text.indexOf("\n") + 1, end);
	const bodyStart = text.indexOf("\n", end + 1);
	const body = bodyStart === -1 ? "" : text.slice(bodyStart + 1);
	const data: Record<string, string> = {};
	const lines = rawBlock.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!match) continue;
		const key = match[1];
		let value = match[2].trim();
		if (/^[|>][+-]?$/.test(value)) {
			const collected: string[] = [];
			while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
				collected.push(lines[i + 1].trim());
				i++;
			}
			value = collected.join(" ");
		} else if (value === "") {
			while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
				const child = lines[i + 1].match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
				if (child) data[`${key}.${child[1]}`] = child[2].trim();
				i++;
			}
			continue;
		}
		if (value !== "") data[key] = value.replace(/^["']|["']$/g, "");
	}
	return { data, body };
}

const TOKEN_LIKE =
	/\b(?=[A-Za-z0-9+/_.-]{28,}\b)(?=\S*\d)[A-Za-z0-9+/_.-]{28,}\b/g;

function maskSensitive(value: string): string {
	return value
		.replace(
			/((?:key|token|secret|password|bearer|auth)[A-Za-z0-9_-]*\s*[=:]\s*)\S+/gi,
			"$1[redacted]",
		)
		.replace(TOKEN_LIKE, "[redacted]");
}

const TRIGGER_HINTS = [
	"Triggers on",
	"Trigger on",
	"Use when",
	"USE WHEN",
	"WHEN ",
	"Fires on",
	"Fires as",
	"Use for",
	"Use before",
	"Use after",
];

/** Pull the activation sentence out of frontmatter or a description. */
function extractTrigger(
	description: string,
	frontmatter: Record<string, string>,
): string {
	for (const [key, value] of Object.entries(frontmatter)) {
		if (/^(when|trigger)/i.test(key) && value !== "") return clip(value, 300);
	}
	for (const hint of TRIGGER_HINTS) {
		const at = description.indexOf(hint);
		if (at !== -1) return clip(description.slice(at), 300);
	}
	return "";
}

function isPathActivated(
	description: string,
	frontmatter: Record<string, string>,
): boolean {
	if (
		Object.keys(frontmatter).some((key) => /path|glob|activation/i.test(key))
	) {
		return true;
	}
	return /path-activat/i.test(description);
}

function findPromoted(): PromotedInfo | null {
	let current: ReturnType<typeof status>["current"];
	try {
		current = status().current;
	} catch {
		return null;
	}
	if (!current) return null;
	const versionFromPath = current.binaryPath.match(/(\d+\.\d+\.\d+)/)?.[1];
	return {
		buildPath: current.binaryPath,
		version: current.version?.version ?? versionFromPath ?? "unknown",
		patchTags: current.version?.patchedTags ?? [],
		isPatched: current.version?.isPatched ?? false,
	};
}

function findExportDir(override?: string): string | null {
	if (override) return path.resolve(override);
	const root = path.join(repoRoot, "exported-prompts");
	let best: string | null = null;
	let bestMtime = 0;
	let bestPatched = false;
	for (const name of listDir(root)) {
		const dirPath = path.join(root, name);
		try {
			const stat = fs.statSync(dirPath);
			if (!stat.isDirectory()) continue;
			const patched = name.endsWith("_patched");
			// A patched export always outranks a clean one; recency breaks ties.
			if (
				(patched && !bestPatched) ||
				(patched === bestPatched && stat.mtimeMs > bestMtime)
			) {
				best = dirPath;
				bestMtime = stat.mtimeMs;
				bestPatched = patched;
			}
		} catch {}
	}
	return best;
}

function readExportInfo(dirPath: string): ExportInfo {
	const manifest = safeJson<{
		label?: string;
		generatedAt?: string;
		counts?: Record<string, number>;
	}>(path.join(dirPath, "manifest.json"));
	return {
		dirPath,
		label: manifest?.label ?? path.basename(dirPath),
		generatedAt: manifest?.generatedAt ?? null,
		counts: manifest?.counts ?? {},
	};
}

function collectBuiltinSkills(exportDir: string): SkillEntry[] {
	const rows = safeJson<
		Array<{
			name?: string;
			description?: string;
			whenToUse?: string;
			userInvocable?: boolean;
			disableModelInvocation?: boolean;
			argumentHint?: string;
			allowedTools?: unknown;
			promptTexts?: string[];
		}>
	>(path.join(exportDir, "skills.json"));
	if (!rows) return [];
	return rows.map((row) => {
		const badges: string[] = [];
		if (row.userInvocable) badges.push("user-invocable");
		if (row.disableModelInvocation) badges.push("model-off");
		const frontmatter: Record<string, string> = {};
		if (row.argumentHint) frontmatter["argument-hint"] = row.argumentHint;
		if (Array.isArray(row.allowedTools) && row.allowedTools.length > 0) {
			frontmatter["allowed-tools"] = row.allowedTools
				.filter((t): t is string => typeof t === "string")
				.join(", ");
		}
		const description = row.description ?? row.whenToUse ?? "";
		return {
			name: row.name ?? "unnamed",
			description,
			source: "built-in",
			badges,
			frontmatter,
			body: (row.promptTexts ?? []).join("\n\n"),
			filePath: null,
			trigger: row.whenToUse ?? extractTrigger(description, {}),
			pathActivated: isPathActivated(description, {}),
			cached: false,
		};
	});
}

function collectSkillDirs(dirPath: string, source: string): SkillEntry[] {
	const entries: SkillEntry[] = [];
	for (const name of listDir(dirPath)) {
		const skillFile = path.join(dirPath, name, "SKILL.md");
		const text = safeRead(skillFile);
		if (text === null) continue;
		const { data, body } = parseFrontmatter(text);
		const description = data.description ?? "";
		entries.push({
			name: data.name ?? name,
			description,
			source,
			badges: [],
			frontmatter: data,
			body,
			filePath: skillFile,
			trigger: extractTrigger(description, data),
			pathActivated: isPathActivated(description, data),
			cached: false,
		});
	}
	return entries;
}

function walkForFiles(
	rootDir: string,
	matcher: (filePath: string) => boolean,
	maxDepth: number,
): string[] {
	const found: string[] = [];
	const visit = (dirPath: string, depth: number): void => {
		if (depth > maxDepth) return;
		for (const name of listDir(dirPath)) {
			if (name === "node_modules" || name === ".git") continue;
			const full = path.join(dirPath, name);
			let stat: fs.Stats;
			try {
				stat = fs.statSync(full);
			} catch {
				continue;
			}
			if (stat.isDirectory()) visit(full, depth + 1);
			else if (matcher(full)) found.push(full);
		}
	};
	visit(rootDir, 0);
	return found;
}

function collectPluginSkills(): SkillEntry[] {
	const pluginsDir = path.join(home, ".claude", "plugins");
	const files = walkForFiles(pluginsDir, (p) => p.endsWith("/SKILL.md"), 6);
	const entries: SkillEntry[] = [];
	for (const filePath of files) {
		const text = safeRead(filePath);
		if (text === null) continue;
		const { data, body } = parseFrontmatter(text);
		const rel = path.relative(pluginsDir, filePath).split(path.sep);
		const skillsIndex = rel.indexOf("skills");
		const pluginLabel =
			skillsIndex > 0 ? rel[skillsIndex - 1] : (rel[0] ?? "plugin");
		const description = data.description ?? "";
		entries.push({
			name: data.name ?? path.basename(path.dirname(filePath)),
			description,
			source: `plugin:${pluginLabel}`,
			badges: [],
			frontmatter: data,
			body,
			filePath,
			trigger: extractTrigger(description, data),
			pathActivated: isPathActivated(description, data),
			cached: rel.includes("cache"),
		});
	}
	return entries;
}

function collectAgentDirs(dirPath: string, source: string): AgentEntry[] {
	const entries: AgentEntry[] = [];
	for (const name of listDir(dirPath)) {
		if (!name.endsWith(".md")) continue;
		const text = safeRead(path.join(dirPath, name));
		if (text === null) continue;
		const { data, body } = parseFrontmatter(text);
		const description = data.description ?? "";
		entries.push({
			name: data.name ?? name.replace(/\.md$/, ""),
			description,
			source,
			model: data.model,
			frontmatter: data,
			body,
			trigger: extractTrigger(description, data),
			memoryAt: [],
		});
	}
	return entries;
}

function collectBuiltinAgents(exportDir: string): AgentEntry[] {
	const rows = safeJson<Array<{ agentType?: string; prompt?: string }>>(
		path.join(exportDir, "agents.json"),
	);
	if (!rows) return [];
	return rows.map((row) => {
		const prompt = row.prompt ?? "";
		return {
			name: row.agentType ?? "unnamed",
			description: clip(prompt.split("\n")[0] ?? "", 240),
			source: "built-in",
			frontmatter: {},
			body: prompt,
			trigger: "",
			memoryAt: [],
		};
	});
}

function collectWorkflowDirs(dirPath: string, source: string): WorkflowEntry[] {
	const entries: WorkflowEntry[] = [];
	for (const name of listDir(dirPath)) {
		if (!name.endsWith(".js")) continue;
		const filePath = path.join(dirPath, name);
		const text = safeRead(filePath);
		if (text === null) continue;
		const metaStart = text.indexOf("export const meta");
		const window =
			metaStart === -1 ? "" : text.slice(metaStart, metaStart + 4000);
		const nameMatch = window.match(/\bname\s*:\s*["'`]([^"'`]+)["'`]/);
		const descMatch = window.match(/\bdescription\s*:\s*["'`]([^"'`]+)["'`]/);
		const whenMatch = window.match(/\bwhenToUse\s*:\s*["'`]([^"'`]+)["'`]/);
		const phaseTitles = [
			...window.matchAll(/\btitle\s*:\s*["'`]([^"'`]+)["'`]/g),
		].map((m) => m[1]);
		entries.push({
			name: nameMatch?.[1] ?? name.replace(/\.js$/, ""),
			description: descMatch?.[1] ?? "",
			whenToUse: whenMatch?.[1] ?? "",
			source,
			phaseTitles,
			filePath,
		});
	}
	return entries;
}

function collectOutputStyles(exportDir: string | null): OutputStyleEntry[] {
	const entries: OutputStyleEntry[] = [];
	if (exportDir) {
		const parsed = safeJson<{
			styles?: Array<{
				name?: string;
				description?: string;
				keepCodingInstructions?: boolean;
				prompt?: string;
			}>;
		}>(path.join(exportDir, "output-styles.json"));
		for (const style of parsed?.styles ?? []) {
			entries.push({
				name: style.name ?? "unnamed",
				description: style.description ?? "",
				source: "built-in",
				keepCodingInstructions: style.keepCodingInstructions ?? null,
				frontmatter: {},
				body: style.prompt ?? "",
			});
		}
	}
	const userDir = path.join(home, ".claude", "output-styles");
	for (const name of listDir(userDir)) {
		if (!name.endsWith(".md")) continue;
		const text = safeRead(path.join(userDir, name));
		if (text === null) continue;
		const { data, body } = parseFrontmatter(text);
		const keepRaw =
			data["keep-coding-instructions"] ?? data.keepCodingInstructions;
		entries.push({
			name: data.name ?? name.replace(/\.md$/, ""),
			description: data.description ?? "",
			source: "user",
			keepCodingInstructions: keepRaw === undefined ? null : keepRaw === "true",
			frontmatter: data,
			body,
		});
	}
	return entries;
}

function collectMemoryGraph(projectRoot: string): MemoryGraph | null {
	const slug = projectRoot.replace(/[\\/:.]/g, "-");
	const dirPath = path.join(home, ".claude", "projects", slug, "memory");
	if (!fs.existsSync(dirPath)) return null;
	const files: MemoryEntry[] = [];
	for (const name of listDir(dirPath)) {
		if (!name.endsWith(".md") || name === "MEMORY.md") continue;
		const text = safeRead(path.join(dirPath, name));
		if (text === null) continue;
		const { data, body } = parseFrontmatter(text);
		const links = [...body.matchAll(/\[\[([A-Za-z0-9_-]+)\]\]/g)].map((m) =>
			m[1].toLowerCase(),
		);
		files.push({
			name: (data.name ?? name.replace(/\.md$/, "")).toLowerCase(),
			fileName: name,
			type: data["metadata.type"] ?? data.type ?? "unknown",
			description: data.description ?? "",
			links: [...new Set(links)],
			sizeChars: text.length,
			body,
		});
	}
	files.sort((a, b) => a.name.localeCompare(b.name));
	const known = new Map<string, string>();
	for (const file of files) {
		known.set(file.name, file.name);
		known.set(file.fileName.replace(/\.md$/, "").toLowerCase(), file.name);
	}
	const edges: Array<{ from: string; to: string }> = [];
	const broken: Array<{ from: string; to: string }> = [];
	for (const file of files) {
		for (const link of file.links) {
			const target = known.get(link);
			if (target && target !== file.name)
				edges.push({ from: file.name, to: target });
			else if (!target) broken.push({ from: file.name, to: link });
		}
	}
	return {
		dirPath,
		files,
		edges,
		broken,
		indexSizeChars: statSize(path.join(dirPath, "MEMORY.md")),
	};
}

function collectAgentMemory(projectRoot: string): AgentMemoryLocation[] {
	const locations: Array<{ label: string; dirPath: string }> = [
		{
			label: "global agent memory",
			dirPath: path.join(home, ".claude", "agent-memory"),
		},
		{
			label: "project agent memory",
			dirPath: path.join(projectRoot, ".claude", "agent-memory"),
		},
		{
			label: "project agent memory (local)",
			dirPath: path.join(projectRoot, ".claude", "agent-memory-local"),
		},
	];
	const found: AgentMemoryLocation[] = [];
	for (const location of locations) {
		if (!fs.existsSync(location.dirPath)) continue;
		const entries: AgentMemoryEntry[] = [];
		for (const name of listDir(location.dirPath)) {
			const full = path.join(location.dirPath, name);
			try {
				const stat = fs.statSync(full);
				if (stat.isDirectory()) {
					const inner = listDir(full);
					entries.push({
						name,
						detail: `${inner.length} file${inner.length === 1 ? "" : "s"}`,
						agent: null,
					});
				} else {
					entries.push({ name, detail: approxTokens(stat.size), agent: null });
				}
			} catch {}
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		found.push({ ...location, entries });
	}
	return found;
}

/** Join agent-memory entries to agents by name, in both directions. */
function linkAgentMemory(
	agents: AgentEntry[],
	locations: AgentMemoryLocation[],
): void {
	const byName = new Map(agents.map((agent) => [agent.name, agent]));
	for (const location of locations) {
		for (const entry of location.entries) {
			const stem = entry.name.replace(/\.md$/, "");
			const agent = byName.get(stem);
			if (agent) {
				entry.agent = stem;
				agent.memoryAt.push(location.label);
			}
		}
	}
}

function collectRules(projectRoot: string): RulesLocation[] {
	const locations: Array<{ label: string; dirPath: string }> = [
		{
			label: "project rules",
			dirPath: path.join(projectRoot, ".claude", "rules"),
		},
		{ label: "global rules", dirPath: path.join(home, ".claude", "rules") },
	];
	const found: RulesLocation[] = [];
	for (const location of locations) {
		if (!fs.existsSync(location.dirPath)) continue;
		const files: RuleFile[] = [];
		for (const name of listDir(location.dirPath)) {
			if (!name.endsWith(".md")) continue;
			const text = safeRead(path.join(location.dirPath, name)) ?? "";
			files.push({
				name,
				heading: extractHeadings(text)[0] ?? "",
				body: text,
			});
		}
		found.push({ ...location, files });
	}
	return found;
}

function describeMcpConfig(config: Record<string, unknown>): {
	transport: string;
	target: string;
} {
	const type = typeof config.type === "string" ? config.type : null;
	const command = typeof config.command === "string" ? config.command : null;
	const url = typeof config.url === "string" ? config.url : null;
	if (command) {
		const args = Array.isArray(config.args)
			? (config.args as unknown[])
					.filter((a) => typeof a === "string")
					.join(" ")
			: "";
		return {
			transport: type ?? "stdio",
			target: maskSensitive(`${path.basename(command)} ${args}`.trim()),
		};
	}
	if (url) {
		try {
			const parsed = new URL(url);
			return { transport: type ?? "http", target: parsed.host };
		} catch {
			return { transport: type ?? "http", target: "[unparsed url]" };
		}
	}
	return { transport: type ?? "unknown", target: "" };
}

function collectMcpServers(projectRoot: string): McpServerEntry[] {
	const entries: McpServerEntry[] = [];
	const claudeJson = safeJson<{
		mcpServers?: Record<string, Record<string, unknown>>;
		projects?: Record<
			string,
			{ mcpServers?: Record<string, Record<string, unknown>> }
		>;
	}>(path.join(home, ".claude.json"));
	const push = (
		scope: string,
		servers: Record<string, Record<string, unknown>> | undefined,
	): void => {
		for (const [name, config] of Object.entries(servers ?? {})) {
			const { transport, target } = describeMcpConfig(config);
			entries.push({ name, scope, transport, target });
		}
	};
	push("user", claudeJson?.mcpServers);
	push(
		"project (user-scoped)",
		claudeJson?.projects?.[projectRoot]?.mcpServers,
	);
	const projectMcp = safeJson<{
		mcpServers?: Record<string, Record<string, unknown>>;
	}>(path.join(projectRoot, ".mcp.json"));
	push("project (.mcp.json)", projectMcp?.mcpServers);
	return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function summarizeSettings(label: string, filePath: string): SettingsLayerInfo {
	const parsed = safeJson<Record<string, unknown>>(filePath);
	if (!parsed) {
		return {
			label,
			filePath,
			exists: fs.existsSync(filePath),
			sizeBytes: statSize(filePath),
			topKeys: [],
			envKeys: [],
			hooks: [],
			permissionCounts: null,
		};
	}
	const env =
		parsed.env && typeof parsed.env === "object"
			? Object.keys(parsed.env as Record<string, unknown>)
			: [];
	const hooks: Array<{ event: string; matchers: HookMatcherInfo[] }> = [];
	if (parsed.hooks && typeof parsed.hooks === "object") {
		for (const [event, groups] of Object.entries(
			parsed.hooks as Record<string, unknown>,
		)) {
			if (!Array.isArray(groups)) continue;
			const matchers: HookMatcherInfo[] = [];
			for (const group of groups) {
				if (!group || typeof group !== "object") continue;
				const record = group as {
					matcher?: unknown;
					hooks?: Array<{ command?: unknown }>;
				};
				const commands = (record.hooks ?? [])
					.map((h) =>
						typeof h.command === "string" ? maskSensitive(h.command) : "",
					)
					.filter((c) => c !== "");
				matchers.push({
					matcher: typeof record.matcher === "string" ? record.matcher : "*",
					commands,
				});
			}
			hooks.push({ event, matchers });
		}
	}
	let permissionCounts: SettingsLayerInfo["permissionCounts"] = null;
	if (parsed.permissions && typeof parsed.permissions === "object") {
		const perms = parsed.permissions as Record<string, unknown>;
		const count = (key: string): number =>
			Array.isArray(perms[key]) ? (perms[key] as unknown[]).length : 0;
		permissionCounts = {
			allow: count("allow"),
			deny: count("deny"),
			ask: count("ask"),
		};
	}
	return {
		label,
		filePath,
		exists: true,
		sizeBytes: statSize(filePath),
		topKeys: Object.keys(parsed).sort(),
		envKeys: env.sort(),
		hooks,
		permissionCounts,
	};
}

function buildLayers(model: HarnessModel): LayerCard[] {
	const counts = model.exportInfo?.counts ?? {};
	const skillCounts = new Map<string, number>();
	for (const skill of model.skills) {
		const bucket = skill.source.startsWith("plugin:") ? "plugin" : skill.source;
		skillCounts.set(bucket, (skillCounts.get(bucket) ?? 0) + 1);
	}
	const chars = (doc: FileDoc): string =>
		`${doc.sizeChars.toLocaleString("en-US")} chars (${approxTokens(doc.sizeChars)})`;
	const prefix: LayerConstituent[] = [];
	if (model.exportInfo) {
		prefix.push({
			name: "Bundle sections",
			origin: "upstream",
			detail: `${counts.sections ?? "?"} section templates, ${counts.tools ?? "?"} tool docs in export`,
		});
	}
	if (model.promoted && model.promoted.patchTags.length > 0) {
		prefix.push({
			name: "In-place patch rewrites",
			origin: "ours",
			detail: `${model.promoted.patchTags.length} patch tags reported by the promoted binary`,
		});
	}
	if (model.policyFile) {
		prefix.push({
			name: "Appended policy file",
			origin: "ours",
			detail: `${model.policyFile.filePath}, ${chars(model.policyFile)}, joined after the built sections`,
		});
	}
	if (prefix.length === 0) {
		prefix.push({
			name: "Nothing found",
			origin: "mixed",
			detail:
				"no prompt export, patched binary, or policy file on this machine",
		});
	}
	const context: LayerConstituent[] = [];
	if (model.managedClaudeMd) {
		context.push({
			name: "Managed CLAUDE.md",
			origin: "ours",
			detail: `${model.managedClaudeMd.filePath}, ${chars(model.managedClaudeMd)}`,
		});
	}
	if (model.projectClaudeMd) {
		context.push({
			name: "Project CLAUDE.md",
			origin: "ours",
			detail: `${model.projectClaudeMd.filePath}, ${chars(model.projectClaudeMd)}`,
		});
	}
	if (model.memory) {
		context.push({
			name: "Auto-memory index",
			origin: "ours",
			detail: `MEMORY.md, ${model.memory.indexSizeChars.toLocaleString("en-US")} chars; ${model.memory.files.length} memory files behind it`,
		});
	}
	if (context.length === 0) {
		context.push({
			name: "Nothing found",
			origin: "mixed",
			detail: "no CLAUDE.md files or auto-memory for this project",
		});
	}
	const hookEvents = model.settingsLayers.reduce(
		(n, layer) => n + layer.hooks.length,
		0,
	);
	return [
		{
			title: "System prompt (cached prefix)",
			origin: model.promoted?.isPatched ? "mixed" : "upstream",
			summary: "Assembled per session from bundle section templates.",
			constituents: prefix,
		},
		{
			title: "First user message: context block",
			origin: "mixed",
			summary:
				"CLAUDE.md chain and the auto-memory index, delivered inside a system-reminder block.",
			constituents: context,
		},
		{
			title: "First user message: capability listings",
			origin: "mixed",
			summary:
				"Skill, agent, and MCP inventories the model can invoke; assembled fresh each session.",
			constituents: [
				{
					name: "Skills",
					origin: "mixed",
					detail: `${skillCounts.get("built-in") ?? 0} built-in, ${skillCounts.get("user") ?? 0} user, ${skillCounts.get("project") ?? 0} project, ${skillCounts.get("plugin") ?? 0} plugin`,
				},
				{
					name: "Agents",
					origin: "mixed",
					detail: `${model.agents.filter((a) => a.source === "built-in").length} built-in, ${model.agents.filter((a) => a.source !== "built-in").length} user/project`,
				},
				{
					name: "MCP servers",
					origin: "ours",
					detail: `${model.mcpServers.length} configured`,
				},
			],
		},
		{
			title: "Per-turn injections",
			origin: "mixed",
			summary:
				"Signals injected while the conversation runs, nearest each decision.",
			constituents: [
				{
					name: "Hook feedback",
					origin: "ours",
					detail: `${hookEvents} hook events across settings layers`,
				},
				{
					name: "System reminders",
					origin: "upstream",
					detail:
						"context updates, recalls, and task notifications from the runtime",
				},
			],
		},
	];
}

/** Measured (and clearly-marked approximate) context sizes per layer. */
function buildComposition(model: HarnessModel): CompositionSegment[] {
	const segments: CompositionSegment[] = [];
	const sectionChars = model.bundleSections.reduce(
		(n, section) => n + section.sizeChars,
		0,
	);
	if (sectionChars > 0) {
		segments.push({
			label: "bundle prompt sections",
			chars: sectionChars,
			kind: "up",
			approx: true,
		});
	}
	if (model.policyFile) {
		segments.push({
			label: "appended policy",
			chars: model.policyFile.sizeChars,
			kind: "loc",
			approx: false,
		});
	}
	if (model.managedClaudeMd) {
		segments.push({
			label: "managed CLAUDE.md",
			chars: model.managedClaudeMd.sizeChars,
			kind: "loc",
			approx: false,
		});
	}
	if (model.projectClaudeMd) {
		segments.push({
			label: "project CLAUDE.md",
			chars: model.projectClaudeMd.sizeChars,
			kind: "loc",
			approx: false,
		});
	}
	if (model.memory) {
		segments.push({
			label: "auto-memory index",
			chars: model.memory.indexSizeChars,
			kind: "loc",
			approx: false,
		});
	}
	const skillListing = model.skills
		.filter((skill) => !skill.cached)
		.reduce(
			(n, skill) => n + skill.name.length + skill.description.length + 6,
			0,
		);
	if (skillListing > 0) {
		segments.push({
			label: "skills listing",
			chars: skillListing,
			kind: "mix",
			approx: true,
		});
	}
	const agentListing = model.agents.reduce(
		(n, agent) => n + agent.name.length + agent.description.length + 6,
		0,
	);
	if (agentListing > 0) {
		segments.push({
			label: "agents listing",
			chars: agentListing,
			kind: "mix",
			approx: true,
		});
	}
	const workflowListing = model.workflows.reduce(
		(n, workflow) =>
			n +
			workflow.name.length +
			(workflow.whenToUse || workflow.description).length +
			6,
		0,
	);
	if (workflowListing > 0) {
		segments.push({
			label: "workflows listing",
			chars: workflowListing,
			kind: "mix",
			approx: true,
		});
	}
	return segments;
}

/** Data-derived rows for the "what fires when" table. */
function buildTriggerRows(model: HarnessModel): TriggerRow[] {
	const rows: TriggerRow[] = [];
	const started: string[] = [];
	if (model.managedClaudeMd) started.push("managed CLAUDE.md");
	if (model.projectClaudeMd) started.push("project CLAUDE.md");
	if (model.memory) {
		started.push(
			`MEMORY.md index (${model.memory.files.length} files behind it)`,
		);
	}
	started.push("skill/agent/MCP listings");
	rows.push({
		mechanism: "Session start",
		when: "Injected into the first user message of every session",
		surfaces: started.join(", "),
	});
	const modelSkills = model.skills.filter(
		(skill) => !skill.cached && !skill.badges.includes("model-off"),
	).length;
	rows.push({
		mechanism: "Description match",
		when: "The model reads listing descriptions and invokes whichever matches the task",
		surfaces: `${modelSkills} skills, ${model.agents.length} agents via the Agent tool`,
	});
	const slashSkills = model.skills.filter(
		(skill) =>
			!skill.cached &&
			(skill.badges.includes("user-invocable") || skill.source !== "built-in"),
	).length;
	rows.push({
		mechanism: "Explicit invocation",
		when: "User types /name or asks for a named workflow",
		surfaces: `${slashSkills} slash-invocable skills, ${model.workflows.length} workflows`,
	});
	const pathSkills = model.skills.filter(
		(skill) => !skill.cached && skill.pathActivated,
	);
	if (pathSkills.length > 0) {
		rows.push({
			mechanism: "Path activation",
			when: "Editing or reading files matching a skill's declared paths surfaces it in the listing",
			surfaces: clip(pathSkills.map((skill) => skill.name).join(", "), 420),
		});
	}
	const eventCounts = new Map<string, number>();
	for (const layer of model.settingsLayers) {
		for (const hook of layer.hooks) {
			eventCounts.set(
				hook.event,
				(eventCounts.get(hook.event) ?? 0) + hook.matchers.length,
			);
		}
	}
	if (eventCounts.size > 0) {
		rows.push({
			mechanism: "Hook events",
			when: "The harness runs configured commands on matching events; output returns as decision-time feedback",
			surfaces: [...eventCounts.entries()]
				.map(([event, n]) => `${event} (${n})`)
				.join(", "),
		});
	}
	const memoryAgents = model.agentMemory.flatMap((location) =>
		location.entries
			.filter((entry) => entry.agent !== null)
			.map((entry) => entry.agent as string),
	);
	if (memoryAgents.length > 0) {
		rows.push({
			mechanism: "Agent spawn",
			when: "An agent's memory directory loads when that agent type runs",
			surfaces: clip([...new Set(memoryAgents)].join(", "), 420),
		});
	}
	if (model.outputStyles.length > 0) {
		rows.push({
			mechanism: "Manual toggle",
			when: "Selected via /output-style or the outputStyle setting; occupies the single style slot",
			surfaces: model.outputStyles.map((style) => style.name).join(", "),
		});
	}
	return rows;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function chip(text: string, kind: string): string {
	return `<span class="chip chip-${kind}">${escapeHtml(text)}</span>`;
}

function originChip(origin: "upstream" | "ours" | "mixed"): string {
	if (origin === "upstream") return chip("upstream", "up");
	if (origin === "ours") return chip("ours", "loc");
	return chip("mixed", "mix");
}

function bodyDetails(summaryLabel: string, text: string): string {
	if (text.trim() === "") return "";
	const clipped = text.length > BODY_CAP;
	const shown = clipped ? text.slice(0, BODY_CAP) : text;
	return `<details><summary>${escapeHtml(summaryLabel)} · ${text.length.toLocaleString("en-US")} chars · ${approxTokens(text.length)}</summary><pre class="body">${escapeHtml(shown)}${clipped ? "\n[truncated for display]" : ""}</pre></details>`;
}

const FM_SKIP = new Set(["name", "description"]);

function fmChips(frontmatter: Record<string, string>): string {
	const chips = Object.entries(frontmatter)
		.filter(([key]) => !FM_SKIP.has(key))
		.map(([key, value]) => chip(`${key}: ${clip(value, 48)}`, "dim"))
		.join("");
	return chips === "" ? "" : `<p class="links">${chips}</p>`;
}

function triggerLine(trigger: string): string {
	return trigger === "" ? "" : `<p class="trigger">${escapeHtml(trigger)}</p>`;
}

function renderMemoryGraphSvg(memory: MemoryGraph): string {
	const nodes = memory.files;
	if (nodes.length === 0) return "";
	const width = 1040;
	const height = 900;
	const cx = width / 2;
	const cy = height / 2 + 6;
	const radius = Math.min(width, height) / 2 - 150;
	const position = new Map<string, { x: number; y: number; angle: number }>();
	nodes.forEach((node, index) => {
		const angle = -Math.PI / 2 + (2 * Math.PI * index) / nodes.length;
		position.set(node.name, {
			x: cx + radius * Math.cos(angle),
			y: cy + radius * Math.sin(angle),
			angle,
		});
	});
	const typeClass = (type: string): string =>
		type === "user" || type === "feedback"
			? "g-loc"
			: type === "reference"
				? "g-ref"
				: "g-proj";
	const edgePaths = memory.edges
		.map((edge) => {
			const from = position.get(edge.from);
			const to = position.get(edge.to);
			if (!from || !to) return "";
			const mx = (from.x + to.x) / 2;
			const my = (from.y + to.y) / 2;
			const qx = mx + (cx - mx) * 0.55;
			const qy = my + (cy - my) * 0.55;
			return `<path d="M ${from.x.toFixed(1)} ${from.y.toFixed(1)} Q ${qx.toFixed(1)} ${qy.toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}" class="g-edge"/>`;
		})
		.join("");
	const nodeMarks = nodes
		.map((node) => {
			const pos = position.get(node.name);
			if (!pos) return "";
			const rightSide = Math.cos(pos.angle) >= 0;
			const lx = pos.x + (rightSide ? 13 : -13);
			const anchor = rightSide ? "start" : "end";
			return `<a href="#mem-${escapeHtml(node.name)}" aria-label="${escapeHtml(node.name)} memory">
<circle cx="${pos.x.toFixed(1)}" cy="${pos.y.toFixed(1)}" r="6.5" class="g-node ${typeClass(node.type)}"/>
<text x="${lx.toFixed(1)}" y="${(pos.y + 4).toFixed(1)}" text-anchor="${anchor}" class="g-label">${escapeHtml(node.name)}</text>
</a>`;
		})
		.join("");
	return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Auto-memory link graph: ${nodes.length} memories, ${memory.edges.length} links" class="memgraph">${edgePaths}${nodeMarks}</svg>`;
}

interface InventoryRow {
	id?: string;
	name: string;
	chips: string;
	desc: string;
	meta?: string;
	size?: number;
	filter: string;
	body: string;
}

function rowHtml(row: InventoryRow): string {
	const idAttr = row.id === undefined ? "" : ` id="${row.id}"`;
	const descLine =
		row.desc === ""
			? ""
			: `<span class="row-desc">${escapeHtml(clip(row.desc, 220))}</span>`;
	const metaLine =
		row.meta === undefined
			? ""
			: `<span class="row-meta">${escapeHtml(row.meta)}</span>`;
	const sizeCol =
		row.size === undefined
			? ""
			: `<span class="row-size">${approxTokens(row.size)}</span>`;
	const head = `<span class="row-name">${escapeHtml(row.name)}</span><span class="row-chips">${row.chips}</span>${descLine}${metaLine}${sizeCol}`;
	const descFull =
		row.desc.length > 220
			? `<p class="row-desc-full">${escapeHtml(row.desc)}</p>`
			: "";
	const inner = `${descFull}${row.body}`;
	if (inner.trim() === "") {
		return `<li class="row row-flat"${idAttr} data-filter="${escapeHtml(row.filter)}"><p class="row-line">${head}</p></li>`;
	}
	return `<li class="row"${idAttr} data-filter="${escapeHtml(row.filter)}"><details><summary>${head}</summary><div class="row-body">${inner}</div></details></li>`;
}

function groupHtml(
	id: string,
	label: string,
	count: number,
	rowsHtml: string,
	open: boolean,
	after = "",
): string {
	return `<details class="group" id="${id}"${open ? " open" : ""}><summary><h3 class="bench">${escapeHtml(label)}</h3><span class="group-count">${count.toLocaleString("en-US")}</span></summary><ul class="rows">${rowsHtml}</ul>${after}</details>`;
}

interface ViewSpec {
	id: string;
	label: string;
	lede: string;
	tools: boolean;
	localNav: Array<[string, string]>;
	inner: string;
}

function viewHtml(spec: ViewSpec): string {
	const localNav =
		spec.localNav.length === 0
			? ""
			: `<nav class="local" aria-label="${escapeHtml(`${spec.label} contents`)}">${spec.localNav
					.map(
						([target, label]) =>
							`<a href="#${target}">${escapeHtml(label)}</a>`,
					)
					.join("")}</nav>`;
	const tools = spec.tools
		? `<div class="view-tools"><button type="button" class="tool" data-open-all>Expand all</button><button type="button" class="tool" data-close-all>Collapse all</button></div>`
		: "";
	return `<section class="view" id="view-${spec.id}" data-view="${spec.id}" aria-labelledby="${spec.id}-h">
<header class="view-head"><div class="view-title"><h2 id="${spec.id}-h">${escapeHtml(spec.label)}</h2>${spec.lede === "" ? "" : `<p class="lede">${escapeHtml(spec.lede)}</p>`}</div>${tools}</header>
${localNav}
${spec.inner}
<p class="no-match" hidden>No matches here for the current filter.</p>
</section>`;
}

function filterablesIn(html: string): number {
	return html.split('data-filter="').length - 1;
}

function skillRowHtml(skill: SkillEntry): string {
	const chips = [
		skill.source.startsWith("plugin:")
			? chip(skill.source.slice(7), "mix")
			: originChip(skill.source === "built-in" ? "upstream" : "ours"),
		...skill.badges.map((badge) => chip(badge, "dim")),
		skill.pathActivated ? chip("path-activated", "loc") : "",
		skill.cached ? chip("cache copy", "dim") : "",
	].join("");
	return rowHtml({
		name: skill.name,
		chips,
		desc: skill.description,
		size: skill.body.length > 0 ? skill.body.length : undefined,
		filter:
			`${skill.name} ${skill.source} ${skill.description} ${skill.trigger}`.toLowerCase(),
		body: `${triggerLine(skill.trigger)}${fmChips(skill.frontmatter)}${bodyDetails("skill body", skill.body)}`,
	});
}

function agentRowHtml(agent: AgentEntry): string {
	const chips = [
		originChip(agent.source === "built-in" ? "upstream" : "ours"),
		agent.model ? chip(agent.model, "dim") : "",
		agent.frontmatter.tools
			? chip(clip(agent.frontmatter.tools, 44), "dim")
			: "",
		...agent.memoryAt.map((label) => chip(`memory: ${label}`, "loc")),
	].join("");
	return rowHtml({
		id: `agent-${slugId(agent.name)}`,
		name: agent.name,
		chips,
		desc: agent.description,
		size: agent.body.length > 0 ? agent.body.length : undefined,
		filter:
			`${agent.name} ${agent.source} ${agent.description} ${agent.trigger}`.toLowerCase(),
		body: `${triggerLine(agent.trigger)}${fmChips(agent.frontmatter)}${bodyDetails("agent prompt", agent.body)}`,
	});
}

function workflowRowHtml(workflow: WorkflowEntry): string {
	const chips = [
		originChip("ours"),
		chip(workflow.source, "dim"),
		workflow.phaseTitles.length > 0
			? chip(
					`${workflow.phaseTitles.length} phase${workflow.phaseTitles.length === 1 ? "" : "s"}`,
					"dim",
				)
			: "",
	].join("");
	const phases =
		workflow.phaseTitles.length > 0
			? `<p class="links">${workflow.phaseTitles.map((title) => chip(title, "dim")).join("")}</p>`
			: "";
	return rowHtml({
		name: workflow.name,
		chips,
		desc: workflow.description,
		filter:
			`${workflow.name} ${workflow.source} ${workflow.description} ${workflow.whenToUse}`.toLowerCase(),
		body: `${triggerLine(workflow.whenToUse)}${phases}<p class="doc-meta"><code>${escapeHtml(workflow.filePath)}</code></p>`,
	});
}

function styleRowHtml(style: OutputStyleEntry): string {
	const keepChip =
		style.keepCodingInstructions === null
			? chip("keep-coding: unset", "warn")
			: style.keepCodingInstructions
				? chip("keeps coding instructions", "dim")
				: chip("drops coding instructions", "warn");
	const chips = [
		originChip(style.source === "built-in" ? "upstream" : "ours"),
		keepChip,
	].join("");
	return rowHtml({
		name: style.name,
		chips,
		desc: style.description,
		size: style.body.length > 0 ? style.body.length : undefined,
		filter: `${style.name} ${style.source} ${style.description}`.toLowerCase(),
		body: `${fmChips(style.frontmatter)}${bodyDetails("style prompt", style.body)}`,
	});
}

function memoryRowHtml(entry: MemoryEntry): string {
	const typeKind =
		entry.type === "user" || entry.type === "feedback"
			? "loc"
			: entry.type === "reference"
				? "up"
				: "mix";
	const links =
		entry.links.length > 0
			? `<p class="links">${entry.links.map((link) => `<a href="#mem-${escapeHtml(link)}">${escapeHtml(link)}</a>`).join(" ")}</p>`
			: "";
	return rowHtml({
		id: `mem-${escapeHtml(entry.name)}`,
		name: entry.name,
		chips: chip(entry.type, typeKind),
		desc: entry.description,
		size: entry.sizeChars,
		filter: `${entry.name} ${entry.type} ${entry.description}`.toLowerCase(),
		body: `${links}${bodyDetails("memory body", entry.body)}`,
	});
}

function docRowHtml(doc: FileDoc): string {
	const headings =
		doc.headings.length === 0
			? ""
			: `<details><summary>${doc.headings.length} headings</summary><ol class="headings">${doc.headings.map((heading) => `<li>${escapeHtml(heading)}</li>`).join("")}</ol></details>`;
	return rowHtml({
		name: doc.label,
		chips: "",
		desc: "",
		meta: doc.filePath,
		size: doc.sizeChars,
		filter: doc.label.toLowerCase(),
		body: `${headings}${bodyDetails("full text", doc.text)}`,
	});
}

function settingsRowHtml(layer: SettingsLayerInfo): string {
	if (!layer.exists) {
		return rowHtml({
			name: layer.label,
			chips: chip("absent", "dim"),
			desc: "",
			meta: layer.filePath,
			filter: layer.label.toLowerCase(),
			body: "",
		});
	}
	const chips = [
		chip(`${(layer.sizeBytes / 1024).toFixed(1)} KB`, "dim"),
		layer.permissionCounts
			? chip(`allow ${layer.permissionCounts.allow}`, "dim")
			: "",
		layer.permissionCounts
			? chip(`ask ${layer.permissionCounts.ask}`, "dim")
			: "",
		layer.permissionCounts
			? chip(`deny ${layer.permissionCounts.deny}`, "dim")
			: "",
	].join("");
	const keys =
		layer.topKeys.length > 0
			? `<p class="links">${layer.topKeys.map((key) => chip(key, "dim")).join("")}</p>`
			: "";
	const env =
		layer.envKeys.length > 0
			? `<details><summary>${layer.envKeys.length} env keys (values withheld)</summary><p class="links">${layer.envKeys.map((key) => chip(key, "dim")).join("")}</p></details>`
			: "";
	const hooks =
		layer.hooks.length === 0
			? ""
			: `<details><summary>${layer.hooks.length} hook event${layer.hooks.length === 1 ? "" : "s"}</summary>${layer.hooks
					.map(
						(hook) =>
							`<p class="hook-event">${escapeHtml(hook.event)}</p><ul class="plain">${hook.matchers
								.map(
									(matcher) =>
										`<li><strong>${escapeHtml(matcher.matcher)}</strong>${matcher.commands.map((command) => `<span class="mono-block">${escapeHtml(command)}</span>`).join("")}</li>`,
								)
								.join("")}</ul>`,
					)
					.join("")}</details>`;
	return rowHtml({
		name: layer.label,
		chips,
		desc: "",
		meta: layer.filePath,
		filter: layer.label.toLowerCase(),
		body: `${keys}${env}${hooks}`,
	});
}

function ruleRowHtml(file: RuleFile): string {
	return rowHtml({
		name: file.name,
		chips: "",
		desc: file.heading,
		size: file.body.length > 0 ? file.body.length : undefined,
		filter: file.name.toLowerCase(),
		body: bodyDetails("rule text", file.body),
	});
}

function renderOverview(model: HarnessModel): ViewSpec {
	const promoted = model.promoted;
	const stages = model.layers
		.map(
			(layer) => `<li class="stage stage-${layer.origin}">
<h4>${escapeHtml(layer.title)} ${originChip(layer.origin)}</h4>
<p class="stage-sum">${escapeHtml(layer.summary)}</p>
<ul class="parts">${layer.constituents
				.map(
					(c) =>
						`<li><span class="dot dot-${c.origin === "upstream" ? "up" : c.origin === "ours" ? "loc" : "mix"}" aria-hidden="true"></span><span class="part-name">${escapeHtml(c.name)}</span><span class="part-detail">${escapeHtml(c.detail)}</span></li>`,
				)
				.join("")}</ul>
</li>`,
		)
		.join("");
	const compTotal = model.composition.reduce((n, s) => n + s.chars, 0);
	const composition =
		compTotal === 0
			? ""
			: `<h3 class="bench" id="composition">Context composition</h3>
<div class="compbar" role="img" aria-label="Context composition by measured size">${model.composition
					.map(
						(segment) =>
							`<div class="seg seg-${segment.kind}" style="flex-grow:${segment.chars}" title="${escapeHtml(`${segment.label}: ${segment.chars.toLocaleString("en-US")} chars`)}"></div>`,
					)
					.join("")}</div>
<ul class="legend">${model.composition
					.map(
						(segment) =>
							`<li><span class="seg seg-${segment.kind}"></span>${escapeHtml(segment.label)} <span class="qty">${segment.chars.toLocaleString("en-US")} chars · ${approxTokens(segment.chars)}${segment.approx ? " · ≈" : ""}</span></li>`,
					)
					.join("")}</ul>
<p class="note">File sizes are measured; ≈ marks sums approximated from export snippets or listing descriptions. Tool schemas and MCP instructions are not counted.</p>`;
	const triggers =
		model.triggerRows.length === 0
			? `<p class="empty">Nothing collected to derive triggers from.</p>`
			: `<div class="scroll" role="region" aria-label="Trigger mechanisms" tabindex="0"><table><thead><tr><th scope="col">Mechanism</th><th scope="col">Fires when</th><th scope="col">Surfaces</th></tr></thead>
<tbody>${model.triggerRows
					.map(
						(row) =>
							`<tr data-filter="${escapeHtml(`${row.mechanism} ${row.surfaces}`.toLowerCase())}"><td class="mono">${escapeHtml(row.mechanism)}</td><td>${escapeHtml(row.when)}</td><td>${escapeHtml(row.surfaces)}</td></tr>`,
					)
					.join("")}</tbody></table></div>`;
	const patchChips = (promoted?.patchTags ?? [])
		.map((tag) => chip(tag, "loc"))
		.join("");
	const roster = promoted
		? promoted.patchTags.length > 0
			? `<p class="doc-meta"><code>${escapeHtml(promoted.buildPath)}</code></p>
<details class="patch-roster"><summary>${promoted.patchTags.length} patch tags reported by the binary</summary><p class="links">${patchChips}</p></details>`
			: `<p class="empty">Promoted binary reports no patch tags.</p>`
		: `<p class="empty">Promoted binary not found.</p>`;
	const localNav: Array<[string, string]> = [["assembly", "assembly"]];
	if (composition !== "") localNav.push(["composition", "composition"]);
	localNav.push(["fires", "what fires when"]);
	localNav.push(["roster", "patch roster"]);
	return {
		id: "overview",
		label: "Overview",
		lede: "",
		tools: false,
		localNav,
		inner: `<h3 class="bench" id="assembly">Prompt assembly, in delivery order</h3>
<ol class="stages">${stages}</ol>
${composition}
<h3 class="bench" id="fires">What fires when</h3>
${triggers}
<h3 class="bench" id="roster">Patch roster</h3>
${roster}`,
	};
}

function renderPromptView(model: HarnessModel): ViewSpec {
	const sections =
		model.bundleSections.length === 0
			? `<p class="empty">No prompt export found; run the prompt export first.</p>`
			: `<p class="note">Section templates from the ${escapeHtml(model.exportInfo?.label ?? "export")} bundle, in export order. The runtime assembles a mode-dependent subset and fills dynamic placeholders.</p>
<ol class="sect">${model.bundleSections
					.map(
						(section, index) =>
							`<li data-filter="${escapeHtml(`${section.heading} ${section.content.slice(0, 400)}`.toLowerCase())}"><div class="sect-line"><span class="sect-no">${String(index + 1).padStart(2, "0")}</span><h4>${escapeHtml(section.heading)}</h4>${chip(approxTokens(section.sizeChars), "dim")}</div>${bodyDetails("template text", section.content)}</li>`,
					)
					.join("")}</ol>`;
	const policy = model.policyFile
		? `<p class="doc-meta"><code>${escapeHtml(model.policyFile.filePath)}</code> · ${model.policyFile.sizeChars.toLocaleString("en-US")} chars · ${approxTokens(model.policyFile.sizeChars)}</p>
${model.policyFile.headings.length > 0 ? `<details><summary>${model.policyFile.headings.length} headings</summary><ol class="headings">${model.policyFile.headings.map((heading) => `<li>${escapeHtml(heading)}</li>`).join("")}</ol></details>` : ""}
${bodyDetails("full text", model.policyFile.text)}`
		: `<p class="empty">No appended policy file found at <code>${escapeHtml(model.policyFilePath)}</code>.</p>`;
	const contextDocs = [model.managedClaudeMd, model.projectClaudeMd].filter(
		(doc): doc is FileDoc => doc !== null,
	);
	const context =
		contextDocs.length === 0
			? `<p class="empty">No CLAUDE.md files found.</p>`
			: `<ul class="rows rows-solo">${contextDocs.map(docRowHtml).join("")}</ul>`;
	const styles =
		model.outputStyles.length === 0
			? `<p class="empty">No output styles found.</p>`
			: `<ul class="rows rows-solo">${model.outputStyles.map(styleRowHtml).join("")}</ul>`;
	const localNav: Array<[string, string]> = [
		["prompt-sections", `sections ${model.bundleSections.length}`],
		["prompt-policy", "policy"],
		["prompt-context", "context files"],
		["prompt-styles", `styles ${model.outputStyles.length}`],
	];
	const ledeParts = [
		`${model.bundleSections.length} bundle section templates`,
		model.policyFile ? "the appended policy" : "no appended policy",
		`${contextDocs.length} context file${contextDocs.length === 1 ? "" : "s"}`,
		`${model.outputStyles.length} output style${model.outputStyles.length === 1 ? "" : "s"}`,
	];
	return {
		id: "prompt",
		label: "Prompt",
		lede: `Every literal prompt text the harness delivers: ${ledeParts.join(", ")}.`,
		tools: true,
		localNav,
		inner: `<h3 class="bench" id="prompt-sections">Bundle sections</h3>
${sections}
<h3 class="bench" id="prompt-policy">Appended policy</h3>
${policy}
<h3 class="bench" id="prompt-context">Context files</h3>
${context}
<h3 class="bench" id="prompt-styles">Output styles</h3>
${styles}`,
	};
}

function renderSkillsView(model: HarnessModel): ViewSpec {
	const byName = (a: SkillEntry, b: SkillEntry): number =>
		a.name.localeCompare(b.name);
	const byBucket = new Map<string, SkillEntry[]>();
	for (const skill of model.skills) {
		const bucket = skill.source.startsWith("plugin:") ? "plugin" : skill.source;
		const group = byBucket.get(bucket) ?? [];
		group.push(skill);
		byBucket.set(bucket, group);
	}
	const order = ["built-in", "user", "project", "plugin"];
	const buckets = [
		...order.filter((bucket) => byBucket.has(bucket)),
		...[...byBucket.keys()].filter((bucket) => !order.includes(bucket)).sort(),
	];
	const localNav: Array<[string, string]> = [];
	const groups = buckets
		.map((bucket) => {
			const group = byBucket.get(bucket) ?? [];
			const listed = group.filter((skill) => !skill.cached).sort(byName);
			const cached = group.filter((skill) => skill.cached).sort(byName);
			const id = `grp-skills-${slugId(bucket)}`;
			const after =
				cached.length === 0
					? ""
					: `<details class="subfold"><summary>${cached.length} cache ${cached.length === 1 ? "copy" : "copies"}, not in the session listing</summary><ul class="rows">${cached.map(skillRowHtml).join("")}</ul></details>`;
			localNav.push([id, `${bucket} ${listed.length}`]);
			return groupHtml(
				id,
				bucket,
				listed.length,
				listed.map(skillRowHtml).join(""),
				listed.length <= 24,
				after,
			);
		})
		.join("");
	const listedTotal = model.skills.filter((skill) => !skill.cached).length;
	const cachedTotal = model.skills.length - listedTotal;
	const lede =
		cachedTotal > 0
			? `${listedTotal} skills in the session listing, plus ${cachedTotal} plugin cache copies kept folded. Groups over 24 start collapsed.`
			: `${listedTotal} skills in the session listing. Groups over 24 start collapsed.`;
	return {
		id: "skills",
		label: "Skills",
		lede,
		tools: true,
		localNav,
		inner: groups === "" ? `<p class="empty">No skills found.</p>` : groups,
	};
}

function renderAgentsView(model: HarnessModel): ViewSpec {
	const byName = (a: AgentEntry, b: AgentEntry): number =>
		a.name.localeCompare(b.name);
	const localNav: Array<[string, string]> = [];
	const groups = ["built-in", "user", "project"]
		.map((source) => {
			const group = model.agents.filter((agent) => agent.source === source);
			if (group.length === 0) return "";
			const id = `grp-agents-${slugId(source)}`;
			localNav.push([id, `${source} ${group.length}`]);
			return groupHtml(
				id,
				source,
				group.length,
				group.sort(byName).map(agentRowHtml).join(""),
				group.length <= 24,
			);
		})
		.join("");
	const withMemory = model.agents.filter(
		(agent) => agent.memoryAt.length > 0,
	).length;
	const lede =
		withMemory > 0
			? `${model.agents.length} agents invocable through the Agent tool; ${withMemory} carry persistent agent memory.`
			: `${model.agents.length} agents invocable through the Agent tool.`;
	return {
		id: "agents",
		label: "Agents",
		lede,
		tools: true,
		localNav,
		inner: groups === "" ? `<p class="empty">No agents found.</p>` : groups,
	};
}

function renderWorkflowsView(model: HarnessModel): ViewSpec {
	const rows = model.workflows
		.sort(
			(a, b) =>
				a.source.localeCompare(b.source) || a.name.localeCompare(b.name),
		)
		.map(workflowRowHtml)
		.join("");
	const globalCount = model.workflows.filter(
		(workflow) => workflow.source === "global",
	).length;
	const projectCount = model.workflows.length - globalCount;
	return {
		id: "workflows",
		label: "Workflows",
		lede: `${model.workflows.length} deterministic orchestrations: ${globalCount} global, ${projectCount} project.`,
		tools: true,
		localNav: [],
		inner:
			rows === ""
				? `<p class="empty">No workflows found.</p>`
				: `<ul class="rows rows-solo">${rows}</ul>`,
	};
}

function renderMemoryView(model: HarnessModel): ViewSpec {
	const memory = model.memory;
	const localNav: Array<[string, string]> = [];
	let inner = "";
	if (memory) {
		const locCount = memory.files.filter(
			(file) => file.type === "user" || file.type === "feedback",
		).length;
		const refCount = memory.files.filter(
			(file) => file.type === "reference",
		).length;
		const projCount = memory.files.length - locCount - refCount;
		const key = `<p class="graph-key"><span class="dot dot-up" aria-hidden="true"></span>project ${projCount}<span class="dot dot-loc" aria-hidden="true"></span>user/feedback ${locCount}<span class="dot dot-mix" aria-hidden="true"></span>reference ${refCount}<span class="key-links">${memory.edges.length} links</span></p>`;
		const broken =
			memory.broken.length > 0
				? `<div class="callout warn"><strong>${memory.broken.length} broken link${memory.broken.length === 1 ? "" : "s"}:</strong> ${memory.broken
						.map((b) => `${escapeHtml(b.from)} → ${escapeHtml(b.to)}`)
						.join(" · ")}</div>`
				: "";
		localNav.push(["mem-graph", "link graph"]);
		localNav.push(["mem-files", `memories ${memory.files.length}`]);
		inner += `<h3 class="bench" id="mem-graph">Link graph</h3>
${key}
<div class="graph-wrap">${renderMemoryGraphSvg(memory)}</div>
${broken}
<h3 class="bench" id="mem-files">Memories</h3>
<p class="doc-meta"><code>${escapeHtml(memory.dirPath)}</code> · index ${memory.indexSizeChars.toLocaleString("en-US")} chars</p>
<ul class="rows rows-solo">${memory.files.map(memoryRowHtml).join("")}</ul>`;
	} else {
		inner += `<p class="empty">No auto-memory directory found for this project.</p>`;
	}
	if (model.agentMemory.length === 0) {
		inner += `<h3 class="bench" id="agent-memory">Agent memory</h3>
<p class="empty">No agent-memory directories found.</p>`;
	} else {
		localNav.push(["agent-memory", "agent memory"]);
		inner += `<h3 class="bench" id="agent-memory">Agent memory</h3>
<p class="note">Each entry loads into context when its agent type is spawned, not at session start.</p>
${model.agentMemory
	.map(
		(
			location,
		) => `<h4 class="bench-sub">${escapeHtml(location.label)} <span class="qty">${location.entries.length}</span></h4>
<p class="doc-meta"><code>${escapeHtml(location.dirPath)}</code></p>
<ul class="plain">${location.entries
			.map(
				(entry) =>
					`<li data-filter="${escapeHtml(entry.name.toLowerCase())}"><strong>${escapeHtml(entry.name)}</strong><span class="plain-qty">${escapeHtml(entry.detail)}</span>${entry.agent ? `<span>loads when <a href="#agent-${slugId(entry.agent)}">${escapeHtml(entry.agent)}</a> runs</span>` : `<span>no matching agent definition found</span>`}</li>`,
			)
			.join("")}</ul>`,
	)
	.join("")}`;
	}
	const agentMemoryCount = model.agentMemory.reduce(
		(n, location) => n + location.entries.length,
		0,
	);
	const lede = memory
		? `${memory.files.length} auto-memories with ${memory.edges.length} links, and ${agentMemoryCount} agent-memory entries.`
		: `No auto-memory directory for this project; ${agentMemoryCount} agent-memory entries.`;
	return {
		id: "memory",
		label: "Memory",
		lede,
		tools: true,
		localNav,
		inner,
	};
}

function renderConfigView(model: HarnessModel): ViewSpec {
	const settings = `<ul class="rows rows-solo">${model.settingsLayers.map(settingsRowHtml).join("")}</ul>`;
	const mcp =
		model.mcpServers.length === 0
			? `<p class="empty">No MCP servers configured.</p>`
			: `<div class="scroll" role="region" aria-label="MCP servers" tabindex="0"><table><thead><tr><th scope="col">Server</th><th scope="col">Scope</th><th scope="col">Transport</th><th scope="col">Target (masked)</th></tr></thead>
<tbody>${model.mcpServers
					.map(
						(server) =>
							`<tr data-filter="${escapeHtml(`${server.name} ${server.scope} ${server.transport}`.toLowerCase())}"><td>${escapeHtml(server.name)}</td><td>${escapeHtml(server.scope)}</td><td>${escapeHtml(server.transport)}</td><td class="mono">${escapeHtml(server.target)}</td></tr>`,
					)
					.join("")}</tbody></table></div>`;
	const rules =
		model.rules.length === 0
			? `<p class="empty">No rules directories found.</p>`
			: model.rules
					.map(
						(
							location,
						) => `<h4 class="bench-sub">${escapeHtml(location.label)} <span class="qty">${location.files.length}</span></h4>
<p class="doc-meta"><code>${escapeHtml(location.dirPath)}</code></p>
${location.files.length === 0 ? `<p class="empty">No rule files in this directory.</p>` : `<ul class="rows rows-solo">${location.files.map(ruleRowHtml).join("")}</ul>`}`,
					)
					.join("");
	const existing = model.settingsLayers.filter((layer) => layer.exists).length;
	const ruleCount = model.rules.reduce(
		(n, location) => n + location.files.length,
		0,
	);
	return {
		id: "config",
		label: "Config",
		lede: `${existing} of ${model.settingsLayers.length} settings layers present, ${model.mcpServers.length} MCP servers, ${ruleCount} rule files.`,
		tools: true,
		localNav: [
			["config-settings", "settings & hooks"],
			["config-mcp", `mcp ${model.mcpServers.length}`],
			["config-rules", "rules"],
		],
		inner: `<h3 class="bench" id="config-settings">Settings layers &amp; hooks</h3>
${settings}
<h3 class="bench" id="config-mcp">MCP servers</h3>
${mcp}
<h3 class="bench" id="config-rules">Rules</h3>
${rules}`,
	};
}

function renderHtml(model: HarnessModel): string {
	const promoted = model.promoted;
	const specs: ViewSpec[] = [
		renderOverview(model),
		renderPromptView(model),
		renderSkillsView(model),
		renderAgentsView(model),
		renderWorkflowsView(model),
		renderMemoryView(model),
		renderConfigView(model),
	];
	const viewsHtml = specs.map(viewHtml).join("\n\n");
	const navList = specs
		.map((spec) => {
			const total =
				spec.id === "overview" ? "" : String(filterablesIn(spec.inner));
			return `<li><a href="#/${spec.id}" data-nav="${spec.id}"><span class="nav-label">${escapeHtml(spec.label)}</span><span class="nav-count" data-total="${total}">${total}</span></a></li>`;
		})
		.join("");
	const verSub = promoted
		? promoted.isPatched
			? `patched · ${promoted.patchTags.length} tags live`
			: "clean binary"
		: "no promoted binary";
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Harness Map · ${escapeHtml(promoted?.version ?? "unknown")}</title>
<style>
:root {
	color-scheme: light dark;
	--chassis: oklch(97% 0.003 250);
	--plate: oklch(99.1% 0.002 250);
	--well: oklch(94.6% 0.005 250);
	--ink: oklch(23% 0.015 255);
	--ink-2: oklch(44% 0.015 255);
	--ink-3: oklch(64% 0.012 255);
	--seam: oklch(87.5% 0.007 250);
	--seam-2: oklch(92% 0.005 250);
	--upstream: oklch(44% 0.085 212);
	--upstream-wash: oklch(93% 0.03 212);
	--ours: oklch(46% 0.105 72);
	--ours-wash: oklch(93.5% 0.045 82);
	--mixed-wash: oklch(92.5% 0.008 255);
	--alert: oklch(47% 0.15 30);
	--alert-wash: oklch(94% 0.03 35);
	--sans: system-ui, -apple-system, "Segoe UI", "Noto Sans", sans-serif;
	--mono: "Berkeley Mono", ui-monospace, "Cascadia Code", "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
	--ease: cubic-bezier(0.16, 1, 0.3, 1);
}
@media (prefers-color-scheme: dark) {
	:root {
		--chassis: oklch(16.5% 0.01 255);
		--plate: oklch(20% 0.012 255);
		--well: oklch(13.5% 0.01 255);
		--ink: oklch(89% 0.006 250);
		--ink-2: oklch(68% 0.01 250);
		--ink-3: oklch(50% 0.01 250);
		--seam: oklch(29% 0.012 255);
		--seam-2: oklch(24% 0.012 255);
		--upstream: oklch(76% 0.085 210);
		--upstream-wash: oklch(28% 0.045 215);
		--ours: oklch(79% 0.105 82);
		--ours-wash: oklch(28.5% 0.05 78);
		--mixed-wash: oklch(26.5% 0.01 255);
		--alert: oklch(72% 0.13 30);
		--alert-wash: oklch(27% 0.05 30);
	}
}
* { box-sizing: border-box; }
body {
	margin: 0; background: var(--chassis); color: var(--ink);
	font-family: var(--sans); font-size: 16px; line-height: 1.55;
}
::selection { background: var(--upstream-wash); color: var(--ink); }
input { caret-color: var(--upstream); }
:focus-visible { outline: 2px solid var(--upstream); outline-offset: 2px; border-radius: 2px; }
a { color: var(--upstream); text-underline-offset: 3px; text-decoration-thickness: 1px; }
a:hover { text-decoration-thickness: 2px; }
[id] { scroll-margin-top: 16px; }
[hidden] { display: none !important; }
.visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.skip { position: absolute; left: -999px; top: 10px; z-index: 20; background: var(--plate); color: var(--ink); border: 1px solid var(--seam); border-radius: 4px; padding: 10px 16px; }
.skip:focus-visible { left: 10px; }
.scroll { overflow-x: auto; }
.scroll, pre.body, .rail { scrollbar-width: thin; scrollbar-color: var(--seam) transparent; }
.scroll::-webkit-scrollbar, pre.body::-webkit-scrollbar { height: 9px; width: 9px; }
.scroll::-webkit-scrollbar-thumb, pre.body::-webkit-scrollbar-thumb { background: var(--seam); border-radius: 4px; }
.empty { color: var(--ink-2); font-style: italic; margin: 8px 0; }
.note { color: var(--ink-2); margin: 8px 0 12px; max-width: 72ch; }
.frame { display: grid; grid-template-columns: 252px minmax(0, 1fr); gap: 44px; max-width: 1560px; margin: 0 auto; padding: 28px 36px 96px; }
.rail { position: sticky; top: 24px; align-self: start; max-height: calc(100vh - 48px); overflow-y: auto; padding-right: 2px; }
.mark { font-family: var(--mono); font-size: 13px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--ink-2); margin: 0 0 2px; }
.ver { font-family: var(--mono); font-size: 26px; font-weight: 700; margin: 0; font-variant-numeric: tabular-nums; }
.ver-sub { font-family: var(--mono); font-size: 13px; color: var(--ink-2); margin: 3px 0 18px; }
.ver-sub.is-patched { color: var(--ours); }
.filterbox { margin: 0 0 16px; }
#filter { width: 100%; font-family: var(--mono); font-size: 16px; background: var(--well); color: var(--ink); border: 1px solid var(--seam); border-radius: 4px; padding: 9px 10px; min-height: 40px; }
#filter::placeholder { color: var(--ink-2); }
.filter-status { font-family: var(--mono); font-size: 13px; color: var(--ink-2); margin: 7px 0 0; min-height: 18px; }
.rail nav ul { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--seam); }
.rail nav a { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 8px; min-height: 40px; color: var(--ink-2); text-decoration: none; border-bottom: 1px solid var(--seam-2); }
.rail nav a:hover { color: var(--ink); background: var(--plate); }
.rail nav a[aria-current="true"] { color: var(--ink); background: var(--plate); box-shadow: inset 2px 0 0 var(--upstream); }
.nav-label { font-size: 16px; }
.nav-count { font-family: var(--mono); font-size: 13px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.rail nav a[aria-current="true"] .nav-count { color: var(--upstream); }
.rail nav li.has-match .nav-count { color: var(--ours); font-weight: 700; }
main { min-width: 0; }
.masthead { margin: 4px 0 34px; }
h1 { font-size: 30px; line-height: 1.15; letter-spacing: -0.015em; margin: 0 0 8px; font-weight: 700; }
.meta { font-family: var(--mono); font-size: 13px; color: var(--ink-2); margin: 0; overflow-wrap: anywhere; }
.meta b { color: var(--ink); font-weight: 600; }
.view { margin: 0 0 64px; }
.js .view { display: none; margin: 0 0 48px; }
.js .view.active { display: block; }
.view-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px 24px; flex-wrap: wrap; border-bottom: 2px solid var(--ink); padding-bottom: 12px; margin-bottom: 16px; }
h2 { font-size: 25px; letter-spacing: -0.01em; margin: 0; line-height: 1.2; }
.lede { margin: 6px 0 0; color: var(--ink-2); max-width: 78ch; }
.view-tools { display: flex; gap: 8px; }
.tool { font-family: var(--mono); font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-2); background: var(--plate); border: 1px solid var(--seam); border-radius: 4px; padding: 6px 12px; min-height: 34px; cursor: pointer; }
.tool:hover { color: var(--ink); border-color: var(--ink-3); }
.tool:active { transform: translateY(1px); }
.local { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 0 0 18px; font-family: var(--mono); font-size: 13px; }
.local a { color: var(--ink-2); text-decoration: none; border-bottom: 1px solid var(--seam); padding: 2px 0; }
.local a:hover { color: var(--upstream); border-bottom-color: var(--upstream); }
.bench { font-family: var(--mono); font-size: 13px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-2); margin: 34px 0 12px; display: flex; align-items: center; gap: 12px; }
.bench::after { content: ""; flex: 1; border-top: 1px solid var(--seam); }
.local + .bench, .view-head + .bench { margin-top: 10px; }
.bench-sub { font-family: var(--mono); font-size: 13px; font-weight: 600; color: var(--ink); margin: 20px 0 4px; }
.qty, .plain-qty, .key-links { font-family: var(--mono); font-size: 13px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.chip { display: inline-block; font-family: var(--mono); font-size: 13px; line-height: 1.4; padding: 1px 7px; border-radius: 3px; border: 1px solid transparent; white-space: nowrap; }
.chip-up { background: var(--upstream-wash); color: var(--upstream); }
.chip-loc { background: var(--ours-wash); color: var(--ours); }
.chip-mix { background: var(--mixed-wash); color: var(--ink-2); }
.chip-dim { border-color: var(--seam); color: var(--ink-2); background: transparent; }
.chip-warn { background: var(--alert-wash); color: var(--alert); }
.stages { list-style: none; margin: 0; padding: 0 0 0 26px; position: relative; max-width: 940px; }
.stages::before { content: ""; position: absolute; left: 7px; top: 10px; bottom: 10px; width: 2px; background: var(--seam); }
.stage { position: relative; padding: 2px 0 22px; }
.stage:last-child { padding-bottom: 4px; }
.stage::before { content: ""; position: absolute; left: -25px; top: 7px; width: 10px; height: 10px; border-radius: 50%; background: var(--chassis); border: 3px solid var(--ink-3); }
.stage-upstream::before { border-color: var(--upstream); }
.stage-ours::before { border-color: var(--ours); }
.stage h4 { font-size: 18px; margin: 0 0 4px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.stage-sum { margin: 0 0 10px; color: var(--ink-2); max-width: 70ch; }
.parts { list-style: none; margin: 0; padding: 0; border: 1px solid var(--seam); border-radius: 4px; background: var(--plate); }
.parts li { display: flex; align-items: baseline; gap: 10px; padding: 8px 12px; }
.parts li + li { border-top: 1px solid var(--seam-2); }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; align-self: center; }
.dot-up { background: var(--upstream); }
.dot-loc { background: var(--ours); }
.dot-mix { background: var(--ink-3); }
.part-name { font-family: var(--mono); font-size: 13px; font-weight: 600; white-space: nowrap; }
.part-detail { font-family: var(--mono); font-size: 13px; color: var(--ink-2); overflow-wrap: anywhere; }
.compbar { display: flex; height: 30px; border: 1px solid var(--seam); border-radius: 4px; overflow: hidden; margin: 10px 0; max-width: 940px; }
.compbar .seg { min-width: 3px; }
.compbar .seg + .seg { border-left: 2px solid var(--chassis); }
.seg-up { background: var(--upstream); }
.seg-loc { background: var(--ours); }
.seg-mix { background: var(--ink-3); }
.legend { list-style: none; margin: 0 0 4px; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 22px; }
.legend li { display: flex; align-items: baseline; gap: 8px; }
.legend .seg { width: 11px; height: 11px; border-radius: 2px; align-self: center; flex: none; }
table { width: 100%; border-collapse: collapse; background: var(--plate); border: 1px solid var(--seam); min-width: 640px; }
th, td { text-align: left; padding: 9px 12px; border-top: 1px solid var(--seam-2); font-size: 16px; vertical-align: top; }
thead th { font-family: var(--mono); font-size: 13px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-2); border-top: none; border-bottom: 1px solid var(--seam); font-weight: 600; }
td.mono { font-family: var(--mono); font-size: 13px; }
summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 8px; font-family: var(--mono); font-size: 13px; color: var(--upstream); min-height: 32px; }
summary::-webkit-details-marker { display: none; }
summary::before { content: ""; flex: none; width: 7px; height: 7px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(-45deg); margin: 0 2px; opacity: 0.8; }
details[open] > summary::before { transform: rotate(45deg); }
pre.body { font-family: var(--mono); font-size: 13px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--well); border: 1px solid var(--seam-2); border-radius: 4px; padding: 12px 14px; max-height: 480px; overflow: auto; margin: 8px 0 0; max-width: 880px; }
details.group { margin: 0 0 14px; border: 1px solid var(--seam); border-radius: 4px; background: var(--plate); }
details.group > summary { padding: 10px 14px; min-height: 46px; gap: 12px; }
details.group > summary:hover { background: var(--well); }
details.group[open] > summary { border-bottom: 1px solid var(--seam-2); }
details.group > summary .bench { margin: 0; color: var(--ink); }
details.group > summary .bench::after { content: none; }
.group-count { font-family: var(--mono); font-size: 13px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
details.subfold { border-top: 1px solid var(--seam-2); }
details.subfold > summary { padding: 9px 14px; min-height: 40px; color: var(--ink-2); }
details.subfold > summary:hover { background: var(--well); color: var(--ink); }
ul.rows { list-style: none; margin: 0; padding: 0; }
ul.rows.rows-solo { border: 1px solid var(--seam); border-radius: 4px; background: var(--plate); margin: 10px 0 4px; }
.row + .row { border-top: 1px solid var(--seam-2); }
.row { content-visibility: auto; contain-intrinsic-block-size: auto 46px; }
.row summary, .row-line { display: flex; align-items: center; gap: 10px; padding: 9px 14px; min-height: 46px; margin: 0; }
.row summary:hover { background: var(--well); }
.row-line { padding-left: 35px; }
.row-name { font-family: var(--mono); font-size: 14px; font-weight: 600; color: var(--ink); flex: none; max-width: 330px; overflow-wrap: anywhere; }
.row-chips { flex: none; display: flex; flex-wrap: wrap; gap: 4px; max-width: 42%; }
.row-desc { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-2); font-size: 16px; font-family: var(--sans); }
.row-meta { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: 13px; color: var(--ink-2); }
.row-size { flex: none; margin-left: auto; font-family: var(--mono); font-size: 13px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.row-body { padding: 2px 16px 16px 35px; border-top: 1px solid var(--seam-2); font-family: var(--sans); }
.row-body > p:first-child { margin-top: 10px; }
.row-desc-full { margin: 10px 0 0; color: var(--ink-2); max-width: 78ch; font-size: 16px; }
ol.sect { list-style: none; margin: 8px 0 0; padding: 0; max-width: 980px; }
ol.sect > li { border-top: 1px solid var(--seam-2); padding: 8px 0; }
.sect-line { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.sect-no { font-family: var(--mono); font-size: 13px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
ol.sect h4 { font-family: var(--mono); font-size: 14px; margin: 0; font-weight: 600; }
ol.headings { font-family: var(--mono); font-size: 13px; margin: 8px 0 0; padding-left: 30px; }
ol.headings li { padding: 2px 0; }
.doc-meta { font-family: var(--mono); font-size: 13px; color: var(--ink-2); margin: 4px 0 10px; overflow-wrap: anywhere; }
.doc-meta code { font: inherit; }
.mono-block { display: block; font-family: var(--mono); font-size: 13px; color: var(--ink-2); margin: 4px 0 0; overflow-wrap: anywhere; }
.hook-event { font-family: var(--mono); font-size: 13px; font-weight: 700; margin: 14px 0 0; }
ul.plain { list-style: none; margin: 4px 0 0; padding: 0; }
ul.plain li { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: baseline; border-top: 1px solid var(--seam-2); padding: 7px 2px; }
ul.plain li:first-child { border-top: none; }
ul.plain li strong { font-family: var(--mono); font-size: 13px; font-weight: 600; }
ul.plain li span { color: var(--ink-2); }
.links { margin: 10px 0 0; display: flex; flex-wrap: wrap; gap: 4px 8px; }
.links a { font-family: var(--mono); font-size: 13px; }
.trigger { font-family: var(--mono); font-size: 13px; color: var(--ours); margin: 10px 0 0; max-width: 96ch; overflow-wrap: anywhere; }
.callout { border: 1px solid transparent; border-radius: 4px; padding: 10px 14px; margin: 12px 0; max-width: 980px; }
.callout.warn { background: var(--alert-wash); color: var(--alert); }
.graph-wrap { border: 1px solid var(--seam); border-radius: 4px; background: var(--plate); padding: 8px; overflow-x: auto; }
.graph-key { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; margin: 0 0 10px; font-family: var(--mono); font-size: 13px; color: var(--ink-2); }
.graph-key .dot { margin-left: 12px; }
.graph-key .dot:first-child { margin-left: 0; }
.key-links { margin-left: 14px; }
.memgraph { display: block; min-width: 720px; width: 100%; max-width: 1040px; height: auto; margin: 0 auto; }
.g-edge { fill: none; stroke: var(--ink-3); stroke-width: 1; opacity: 0.35; }
.g-node { stroke: var(--plate); stroke-width: 1.5; }
.g-node.g-proj { fill: var(--upstream); }
.g-node.g-ref { fill: var(--ink-3); }
.g-node.g-loc { fill: var(--ours); }
.g-label { font-family: var(--mono); font-size: 13px; fill: var(--ink); }
.memgraph a:hover .g-label, .memgraph a:focus .g-label { fill: var(--upstream); }
.patch-roster { margin-top: 10px; }
.no-match { color: var(--ink-2); font-style: italic; border: 1px dashed var(--seam); border-radius: 4px; padding: 14px 16px; margin: 10px 0; }
@media (prefers-reduced-motion: no-preference) {
	:root { interpolate-size: allow-keywords; }
	summary::before { transition: transform 160ms var(--ease); }
	.row > details::details-content { block-size: 0; overflow-y: clip; transition: block-size 220ms var(--ease), content-visibility 220ms allow-discrete; }
	.row > details[open]::details-content { block-size: auto; }
	.tool { transition: color 120ms ease-out, border-color 120ms ease-out; }
	.rail nav a { transition: background-color 120ms ease-out, color 120ms ease-out; }
	.row summary, details.group > summary, details.subfold > summary { transition: background-color 120ms ease-out; }
	.local a { transition: color 120ms ease-out, border-color 120ms ease-out; }
}
@media (max-width: 1080px) {
	.frame { grid-template-columns: 1fr; gap: 0; padding: 20px 18px 72px; }
	.rail { position: static; max-height: none; margin-bottom: 26px; overflow-y: visible; }
	.rail nav ul { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 4px; border-top: none; }
	.rail nav a { border: 1px solid var(--seam-2); border-radius: 4px; }
}
@media (max-width: 760px) {
	.row-desc { display: none; }
	.row-name { max-width: none; }
	.view-head { align-items: flex-start; }
	table { min-width: 560px; }
}
@media print {
	.rail, .view-tools, .no-match, .skip { display: none !important; }
	.js .view { display: block !important; }
	.frame { display: block; padding: 0; }
	pre.body { max-height: none; overflow: visible; }
}
</style>
</head>
<body>
<!--
direction contract · service datasheet
THESIS: one document, seven addressable views; the manifest rail answers "how many
things do we have" before a single click. Refuses the glowing-console rut.
OWN-WORLD: paper chassis / graphite night pass, borders only, system grotesque plus
mono for measurement; teal marks upstream, amber marks ours. Tokens: chassis, plate,
well, seam, ink, upstream, ours, alert.
STORY: land on assembly spine and measured composition, then drill into folded
inventories through the rail; one filter reaches every view.
FIRST VIEWPORT: rail (wordmark, version, patch state, filter, counted nav) beside
masthead and the assembly spine with its composition meter.
FORM: engineering datasheet; chosen from a seven-candidate derivation, rut named.
FINISH: verified by regeneration, structural checks, and rubric critique.
-->
<a class="skip" href="#main">Skip to content</a>
<div class="frame">
<div class="rail">
<p class="mark">Harness map</p>
<p class="ver">${escapeHtml(promoted?.version ?? "?")}</p>
<p class="ver-sub${promoted?.isPatched ? " is-patched" : ""}">${escapeHtml(verSub)}</p>
<div class="filterbox" role="search">
<label class="visually-hidden" for="filter">Filter all inventories</label>
<input id="filter" type="search" placeholder="Filter everything…" autocomplete="off" spellcheck="false">
<p class="filter-status" id="filter-status" aria-live="polite"></p>
</div>
<nav aria-label="Views">
<ul>${navList}</ul>
</nav>
</div>
<main id="main">
<header class="masthead">
<h1>Claude Code harness, mapped</h1>
<p class="meta">Generated ${escapeHtml(model.generatedAt)} · export <b>${escapeHtml(model.exportInfo?.label ?? "none found")}</b> · binary <b>${escapeHtml(path.basename(promoted?.buildPath ?? "none"))}</b></p>
</header>

${viewsHtml}
</main>
</div>
<script>
(function () {
	var doc = document;
	doc.documentElement.className += " js";
	var views = Array.prototype.slice.call(doc.querySelectorAll("section.view"));
	var navLinks = Array.prototype.slice.call(doc.querySelectorAll("[data-nav]"));
	var byName = {};
	views.forEach(function (view) { byName[view.getAttribute("data-view")] = view; });
	function activate(name) {
		if (!byName[name]) name = "overview";
		views.forEach(function (view) {
			view.classList.toggle("active", view.getAttribute("data-view") === name);
		});
		navLinks.forEach(function (link) {
			if (link.getAttribute("data-nav") === name) link.setAttribute("aria-current", "true");
			else link.removeAttribute("aria-current");
		});
	}
	function revealAncestors(el) {
		var node = el.parentElement;
		while (node) {
			if (node.tagName === "DETAILS" && !node.open) node.open = true;
			node = node.parentElement;
		}
	}
	function route() {
		var hash = location.hash || "";
		if (hash.indexOf("#/") === 0) {
			activate(hash.slice(2) || "overview");
			window.scrollTo({ top: 0, behavior: "auto" });
			return;
		}
		if (hash.length > 1) {
			var el;
			try { el = doc.getElementById(decodeURIComponent(hash.slice(1))); } catch (error) { el = null; }
			if (el) {
				var view = el.closest("section.view");
				if (view) activate(view.getAttribute("data-view"));
				revealAncestors(el);
				var top = el.getBoundingClientRect().top + window.scrollY - 16;
				window.scrollTo({ top: top, behavior: "auto" });
				return;
			}
		}
		activate("overview");
	}
	window.addEventListener("hashchange", route);
	route();
	Array.prototype.forEach.call(doc.querySelectorAll("[data-open-all]"), function (btn) {
		btn.addEventListener("click", function () {
			Array.prototype.forEach.call(btn.closest("section.view").querySelectorAll("details"), function (d) { d.open = true; });
		});
	});
	Array.prototype.forEach.call(doc.querySelectorAll("[data-close-all]"), function (btn) {
		btn.addEventListener("click", function () {
			Array.prototype.forEach.call(btn.closest("section.view").querySelectorAll("details"), function (d) { d.open = false; });
		});
	});
	var input = doc.getElementById("filter");
	var status = doc.getElementById("filter-status");
	var IDLE = "press / to filter · Esc clears";
	if (status) status.textContent = IDLE;
	if (!input) return;
	var records = Array.prototype.slice.call(doc.querySelectorAll("[data-filter]")).map(function (el) {
		var view = el.closest("section.view");
		return {
			el: el,
			text: el.getAttribute("data-filter") || "",
			view: view ? view.getAttribute("data-view") : "",
			fold: el.closest("details.group, details.subfold")
		};
	});
	var totals = {};
	records.forEach(function (record) { totals[record.view] = (totals[record.view] || 0) + 1; });
	var folds = Array.prototype.slice.call(doc.querySelectorAll("details.group, details.subfold"));
	var savedOpen = null;
	function apply() {
		var query = input.value.trim().toLowerCase();
		var filtering = query !== "";
		if (filtering && savedOpen === null) {
			savedOpen = folds.map(function (fold) { return fold.open; });
		}
		var perView = {};
		var total = 0;
		var openFolds = [];
		records.forEach(function (record) {
			var hit = !filtering || record.text.indexOf(query) !== -1;
			record.el.hidden = filtering && !hit;
			if (filtering && hit) {
				total += 1;
				perView[record.view] = (perView[record.view] || 0) + 1;
				if (record.fold && openFolds.indexOf(record.fold) === -1) openFolds.push(record.fold);
			}
		});
		folds.forEach(function (fold, index) {
			if (filtering) fold.open = openFolds.indexOf(fold) !== -1;
			else if (savedOpen) fold.open = savedOpen[index];
		});
		if (!filtering) savedOpen = null;
		navLinks.forEach(function (link) {
			var name = link.getAttribute("data-nav");
			var countEl = link.querySelector(".nav-count");
			if (!countEl) return;
			var base = countEl.getAttribute("data-total") || "";
			var matches = perView[name] || 0;
			if (filtering) countEl.textContent = base === "" ? String(matches) : matches + "/" + base;
			else countEl.textContent = base;
			var item = link.parentElement;
			if (item) item.classList.toggle("has-match", filtering && matches > 0);
		});
		views.forEach(function (view) {
			var name = view.getAttribute("data-view");
			var msg = view.querySelector(".no-match");
			if (msg) msg.hidden = !(filtering && (totals[name] || 0) > 0 && !(perView[name] > 0));
		});
		if (status) {
			status.textContent = filtering
				? total + (total === 1 ? " match" : " matches") + " across all views"
				: IDLE;
		}
	}
	input.addEventListener("input", apply);
	input.addEventListener("keydown", function (event) {
		if (event.key === "Escape" && input.value !== "") {
			input.value = "";
			apply();
		}
	});
	window.addEventListener("keydown", function (event) {
		if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
		var target = event.target;
		if (target === input) return;
		var tag = target && target.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
		if (target && target.isContentEditable) return;
		event.preventDefault();
		input.focus();
	});
})();
</script>
</body>
</html>
`;
}

function buildModel(options: HarnessMapOptions): HarnessModel {
	const projectRoot = path.resolve(options.projectRoot ?? repoRoot);
	const policyFilePath =
		process.env.CLAUDE_CODE_APPEND_SYSTEM_PROMPT_FILE ??
		path.join(managedDir, "system-prompt.md");
	const exportDir = findExportDir(options.exportDir);
	const exportInfo = exportDir ? readExportInfo(exportDir) : null;
	const skills: SkillEntry[] = [
		...(exportDir ? collectBuiltinSkills(exportDir) : []),
		...collectSkillDirs(path.join(home, ".claude", "skills"), "user"),
		...collectSkillDirs(path.join(projectRoot, ".claude", "skills"), "project"),
		...collectPluginSkills(),
	];
	const agents: AgentEntry[] = [
		...(exportDir ? collectBuiltinAgents(exportDir) : []),
		...collectAgentDirs(path.join(home, ".claude", "agents"), "user"),
		...collectAgentDirs(path.join(projectRoot, ".claude", "agents"), "project"),
	];
	const workflows: WorkflowEntry[] = [
		...collectWorkflowDirs(path.join(home, ".claude", "workflows"), "global"),
		...collectWorkflowDirs(
			path.join(projectRoot, ".claude", "workflows"),
			"project",
		),
	];
	const bundleSections: BundleSection[] = exportDir
		? (
				safeJson<Array<{ heading?: string; snippets?: string[] }>>(
					path.join(exportDir, "system", "sections.json"),
				) ?? []
			)
				.map((row) => {
					const content = (row.snippets ?? []).join("\n\n");
					return {
						heading: row.heading ?? "",
						content,
						sizeChars: content.length,
					};
				})
				.filter((row) => row.heading !== "")
		: [];
	const agentMemory = collectAgentMemory(projectRoot);
	linkAgentMemory(agents, agentMemory);
	const model: HarnessModel = {
		generatedAt: new Date().toISOString(),
		repoRoot,
		projectRoot,
		policyFilePath,
		promoted: findPromoted(),
		exportInfo,
		layers: [],
		composition: [],
		triggerRows: [],
		policyFile: readFileDoc("Appended policy", policyFilePath),
		managedClaudeMd: readFileDoc(
			"Managed CLAUDE.md",
			path.join(managedDir, "CLAUDE.md"),
		),
		projectClaudeMd: readFileDoc(
			"Project CLAUDE.md",
			path.join(projectRoot, "CLAUDE.md"),
		),
		bundleSections,
		skills,
		agents,
		workflows,
		outputStyles: collectOutputStyles(exportDir),
		memory: collectMemoryGraph(projectRoot),
		agentMemory,
		rules: collectRules(projectRoot),
		mcpServers: collectMcpServers(projectRoot),
		settingsLayers: [
			summarizeSettings(
				"Managed settings",
				path.join(managedDir, "managed-settings.json"),
			),
			summarizeSettings(
				"User settings",
				path.join(home, ".claude", "settings.json"),
			),
			summarizeSettings(
				"User settings (local)",
				path.join(home, ".claude", "settings.local.json"),
			),
			summarizeSettings(
				"Project settings",
				path.join(projectRoot, ".claude", "settings.json"),
			),
			summarizeSettings(
				"Project settings (local)",
				path.join(projectRoot, ".claude", "settings.local.json"),
			),
		],
	};
	model.layers = buildLayers(model);
	model.composition = buildComposition(model);
	model.triggerRows = buildTriggerRows(model);
	return model;
}

async function main(): Promise<void> {
	const argv = await yargs(hideBin(process.argv))
		.option("export-dir", {
			type: "string",
			describe: "Prompt export directory (default: newest patched export)",
		})
		.option("out", {
			type: "string",
			describe: "Output HTML path (default: exported-prompts/harness-map.html)",
		})
		.option("project", {
			type: "string",
			describe: "Project root whose context to map (default: this repo)",
		})
		.strict()
		.parse();
	const options: HarnessMapOptions = {
		exportDir: argv["export-dir"],
		out: argv.out,
		projectRoot: argv.project,
	};
	const model = buildModel(options);
	const outPath = path.resolve(
		options.out ?? path.join(repoRoot, "exported-prompts", "harness-map.html"),
	);
	fs.mkdirSync(path.dirname(outPath), { recursive: true });
	fs.writeFileSync(outPath, renderHtml(model));
	const jsonPath = outPath.replace(/\.html$/, ".json");
	// Bodies stay out of the JSON sibling; they are for the page, not the model.
	const leanJson = JSON.stringify(
		model,
		(key, value) =>
			key === "body" || key === "text" || key === "content" ? undefined : value,
		"\t",
	);
	fs.writeFileSync(jsonPath, `${leanJson}\n`);
	const memory = model.memory;
	console.log(`Harness map: ${outPath}`);
	console.log(`Model JSON:  ${jsonPath}`);
	console.log(
		[
			`version=${model.promoted?.version ?? "?"}`,
			`patchTags=${model.promoted?.patchTags.length ?? 0}`,
			`skills=${model.skills.length}`,
			`agents=${model.agents.length}`,
			`workflows=${model.workflows.length}`,
			`sections=${model.bundleSections.length}`,
			`memories=${memory?.files.length ?? 0} (links=${memory?.edges.length ?? 0}, broken=${memory?.broken.length ?? 0})`,
			`mcp=${model.mcpServers.length}`,
		].join("  "),
	);
}

await main();
