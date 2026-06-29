import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as parser from "@babel/parser";
import * as t from "@babel/types";
import chalk from "chalk";
import * as Diff from "diff";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { generator, traverse } from "./babel.js";
import { parse } from "./loader.js";

type SurfaceKind =
	| "cli-flag"
	| "env-var"
	| "object-key"
	| "object-label"
	| "regex"
	| "settings-write"
	| "slash-command"
	| "system-reminder"
	| "template"
	| "url"
	| "user-message"
	| "literal";

type FocusMode =
	| "all"
	| "commands"
	| "env"
	| "inventory"
	| "release"
	| "removals"
	| "rewrites"
	| "prompts"
	| "settings"
	| "patches";

interface BundleMetadata {
	file: string;
	bytes: number;
	lineCount: number;
	commentVersions: string[];
	embeddedVersions: string[];
	buildTimes: string[];
	gitShas: string[];
}

interface SurfaceContext {
	line: number | null;
	usage: string;
	ast: string;
	objectLabels: string[];
}

interface SurfaceEntry {
	kind: SurfaceKind;
	value: string;
	count: number;
	contexts: SurfaceContext[];
}

interface BundleFacts {
	metadata: BundleMetadata;
	surfaces: Map<string, SurfaceEntry>;
	inventory: BundleInventory;
}

interface BundleDiffOptions {
	includeBuildMetadata: boolean;
	minLength: number;
	contextLimit: number;
	cache: boolean;
	cacheDir: string;
	config: DiffConfig;
}

interface SurfaceChange extends SurfaceEntry {
	delta: number;
}

interface BundleDiffReport {
	old: BundleMetadata;
	new: BundleMetadata;
	totals: {
		oldUnique: number;
		newUnique: number;
		added: number;
		removed: number;
		countChanged: number;
	};
	addedByKind: Record<SurfaceKind, number>;
	removedByKind: Record<SurfaceKind, number>;
	added: SurfaceChange[];
	removed: SurfaceChange[];
	countChanged: SurfaceChange[];
	sections: SurfaceSections;
	addedClusters: SurfaceCluster[];
	removedClusters: SurfaceCluster[];
	clusters: SurfaceCluster[];
	prefixRewrites: PrefixRewrite[];
	rewriteCandidates: RewriteCandidate[];
	addedCapabilities: CapabilityCandidate[];
	removedCapabilities: CapabilityCandidate[];
	commandCandidates: CommandCandidate[];
	inventory: InventoryDiff;
	releaseSummary: ReleaseSummary;
	patchRelevance: PatchRelevance[];
	promptExport?: PromptExportCheck;
}

interface InventoryContext {
	line: number | null;
	ast: string;
}

interface InventoryEntry {
	value: string;
	count: number;
	contexts: InventoryContext[];
}

interface BundleInventory {
	commands: Map<string, InventoryEntry>;
	routes: Map<string, InventoryEntry>;
	sqlTables: Map<string, InventoryEntry>;
	sqlIndexes: Map<string, InventoryEntry>;
}

type InventoryKind = keyof BundleInventory;

interface InventoryChange extends InventoryEntry {
	kind: InventoryKind;
	delta: number;
}

interface InventoryDiff {
	added: InventoryChange[];
	removed: InventoryChange[];
	countChanged: InventoryChange[];
}

type ReleaseSummarySectionKey =
	| "features"
	| "infrastructure"
	| "authSecurity"
	| "hardening"
	| "behaviorChanges"
	| "noise";

interface ReleaseSummaryItem {
	title: string;
	confidence: "high" | "medium" | "low";
	evidence: string[];
	lines: number[];
}

type ReleaseSummary = Record<ReleaseSummarySectionKey, ReleaseSummaryItem[]>;

interface SurfaceCluster {
	lineStart: number;
	lineEnd: number;
	score: number;
	changes: SurfaceChange[];
}

type SurfaceSectionKey =
	| "commands"
	| "flags"
	| "env"
	| "routes"
	| "settings"
	| "reminders"
	| "labels"
	| "messages";

interface SurfaceSection {
	added: SurfaceChange[];
	removed: SurfaceChange[];
	countChanged: SurfaceChange[];
}

type SurfaceSections = Record<SurfaceSectionKey, SurfaceSection>;

interface RewriteCandidate {
	score: number;
	oldChange: SurfaceChange;
	newChange: SurfaceChange;
	sharedTokens: string[];
}

interface RewriteSurfaceData {
	change: SurfaceChange;
	tokens: Set<string>;
	prefix: string | null;
}

interface PrefixRewrite {
	oldPrefix: string;
	newPrefix: string;
	score: number;
	matches: number;
	removedCount: number;
	addedCount: number;
	samples: RewriteCandidate[];
}

interface CapabilityCandidate {
	token: string;
	score: number;
	changes: SurfaceChange[];
}

interface CommandCandidate {
	command: string;
	change: "added" | "removed";
	confidence: "high" | "medium";
	line: number | null;
	descriptions: string[];
	flags: string[];
	prompts: string[];
}

interface PatchRelevance {
	tag: string;
	confidence: "none" | "review" | "medium" | "high";
	directRemoved: PatchAnchorHit[];
	rewrites: PatchRewriteHit[];
	countChanged: PatchAnchorHit[];
}

interface PatchAnchorHit {
	anchor: string;
	change: SurfaceChange;
}

interface PatchRewriteHit {
	anchor: string;
	rewrite: RewriteCandidate;
}

interface PromptExportCheck {
	dir: string;
	filesScanned: number;
	error?: string;
	bundleOnlyPromptLike: SurfaceChange[];
}

interface DiffConfig {
	ignoreTokens: string[];
	ignorePrefixes: string[];
	highSignalTokens: string[];
}

interface MatrixDiffReport {
	bundles: BundleMetadata[];
	pairs: BundleDiffReport[];
	latestOnlyAdditions: SurfaceChange[];
}

const HIGH_SIGNAL_LABEL_KEYS = new Set([
	"command",
	"commandName",
	"description",
	"displayName",
	"event",
	"id",
	"kind",
	"label",
	"name",
	"source",
	"title",
	"tool",
	"toolName",
	"type",
]);

const SURFACE_KIND_ORDER: Record<SurfaceKind, number> = {
	"object-label": 100,
	"cli-flag": 95,
	"slash-command": 90,
	"settings-write": 88,
	"env-var": 85,
	url: 80,
	"system-reminder": 78,
	template: 70,
	"user-message": 60,
	regex: 50,
	"object-key": 40,
	literal: 10,
};

const SURFACE_KINDS: SurfaceKind[] = [
	"cli-flag",
	"env-var",
	"object-key",
	"object-label",
	"regex",
	"settings-write",
	"slash-command",
	"system-reminder",
	"template",
	"url",
	"user-message",
	"literal",
];

const SURFACE_SECTION_KEYS: SurfaceSectionKey[] = [
	"commands",
	"flags",
	"env",
	"routes",
	"settings",
	"reminders",
	"labels",
	"messages",
];

const SURFACE_SECTION_TITLES: Record<SurfaceSectionKey, string> = {
	commands: "Commands / subcommands",
	flags: "Flags",
	env: "Environment variables",
	routes: "Slash commands / endpoints",
	settings: "Settings writes",
	reminders: "System reminders",
	labels: "Product labels / IDs",
	messages: "Prompts, logs, and user text",
};

const INVENTORY_TITLES: Record<InventoryKind, string> = {
	commands: "Declared commands",
	routes: "HTTP routes / endpoints",
	sqlTables: "SQL tables",
	sqlIndexes: "SQL indexes",
};

const RELEASE_SUMMARY_TITLES: Record<ReleaseSummarySectionKey, string> = {
	features: "Likely Features",
	infrastructure: "Infrastructure / Schema",
	authSecurity: "Auth / Security",
	hardening: "Hardening / Bug-Fix Hints",
	behaviorChanges: "Behavior Changes / Removals",
	noise: "Likely Noise / False Positives",
};

const RELEASE_SUMMARY_KEYS: ReleaseSummarySectionKey[] = [
	"features",
	"infrastructure",
	"authSecurity",
	"hardening",
	"behaviorChanges",
	"noise",
];

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(SOURCE_DIR);
const CACHE_SCHEMA_VERSION = 8;
const DEFAULT_CACHE_DIR = path.join(REPO_ROOT, ".cache", "bundle-diff");
const DEFAULT_DIFF_CONFIG: DiffConfig = {
	ignoreTokens: [],
	ignorePrefixes: [],
	highSignalTokens: [],
};

const ROUTE_COLLECTION_NAME_PATTERN =
	/(?:^|_)(?:api)?(?:routes?|endpoints?|uris?)(?:_|$)|(?:routes?|endpoints?|uris?)$/i;
const ROUTE_STRONG_KEY_PATTERN = /(?:endpoint|route|uri)$/i;
const ROUTE_WEAK_PATH_KEY_PATTERN = /(?:^path$|path$)/i;
const ROUTE_METHOD_NAMES = new Set([
	"all",
	"delete",
	"get",
	"head",
	"options",
	"patch",
	"post",
	"put",
	"route",
	"use",
]);

const FOCUS_MODES: FocusMode[] = [
	"all",
	"commands",
	"env",
	"inventory",
	"release",
	"removals",
	"rewrites",
	"prompts",
	"settings",
	"patches",
];

const TOKEN_STOPWORDS = new Set([
	"about",
	"after",
	"again",
	"all",
	"also",
	"and",
	"any",
	"are",
	"available",
	"before",
	"being",
	"cannot",
	"claude",
	"code",
	"current",
	"default",
	"delete",
	"did",
	"disabled",
	"does",
	"done",
	"each",
	"enabled",
	"error",
	"failed",
	"file",
	"files",
	"for",
	"from",
	"has",
	"have",
	"help",
	"into",
	"item",
	"items",
	"json",
	"last",
	"new",
	"not",
	"now",
	"old",
	"only",
	"optional",
	"name",
	"null",
	"path",
	"placeholder",
	"project",
	"read",
	"run",
	"session",
	"set",
	"skip",
	"state",
	"status",
	"the",
	"this",
	"text",
	"tool",
	"token",
	"use",
	"user",
	"value",
	"was",
	"when",
	"will",
	"with",
	"would",
	"you",
	"your",
]);

async function main() {
	await yargs(hideBin(process.argv))
		.scriptName("bun run diff")
		.command(
			["$0 <old> <new>", "bundle <old> <new>"],
			"Compare two minified JS bundles by stable feature surfaces",
			(yargs) => {
				return yargs
					.positional("old", { type: "string", demandOption: true })
					.positional("new", { type: "string", demandOption: true })
					.option("limit", {
						alias: "l",
						type: "number",
						default: 20,
						description: "Maximum rows per output section",
					})
					.option("min-length", {
						type: "number",
						default: 3,
						description: "Minimum literal length unless high-signal",
					})
					.option("include-build-metadata", {
						type: "boolean",
						default: false,
						description:
							"Include semver, build timestamps, and git hashes as changed surfaces",
					})
					.option("cache", {
						type: "boolean",
						default: true,
						description:
							"Cache extracted bundle facts under .cache/bundle-diff; pass --no-cache to force a reparse",
					})
					.option("cache-dir", {
						type: "string",
						description: "Override bundle diff cache directory",
					})
					.option("config", {
						type: "string",
						description:
							"Optional JSON config with ignoreTokens, ignorePrefixes, highSignalTokens",
					})
					.option("focus", {
						type: "string",
						choices: FOCUS_MODES,
						default: "all",
						description:
							"Show a focused report section (commands, env, inventory, release, removals, rewrites, prompts, settings, patches)",
					})
					.option("markdown", {
						type: "boolean",
						default: false,
						description: "Emit a markdown report",
					})
					.option("prompt-export", {
						type: "string",
						description:
							"Compare added prompt-like bundle surfaces with an exported prompt artifact directory",
					})
					.option("json", {
						type: "boolean",
						default: false,
						description: "Emit JSON instead of human-readable output",
					});
			},
			(argv) => runBundleDiff(argv),
		)
		.command(
			"matrix <bundles..>",
			"Compare adjacent bundles and summarize latest-only surfaces",
			(yargs) => {
				return yargs
					.positional("bundles", {
						type: "string",
						array: true,
						demandOption: true,
						description: "Bundle paths in chronological order",
					})
					.option("limit", {
						alias: "l",
						type: "number",
						default: 20,
						description: "Maximum rows per output section",
					})
					.option("cache", {
						type: "boolean",
						default: true,
						description:
							"Cache extracted bundle facts under .cache/bundle-diff; pass --no-cache to force a reparse",
					})
					.option("cache-dir", {
						type: "string",
						description: "Override bundle diff cache directory",
					})
					.option("config", {
						type: "string",
						description:
							"Optional JSON config with ignoreTokens, ignorePrefixes, highSignalTokens",
					})
					.option("markdown", {
						type: "boolean",
						default: false,
						description: "Emit a markdown report",
					})
					.option("json", {
						type: "boolean",
						default: false,
						description: "Emit JSON instead of human-readable output",
					});
			},
			(argv) => runMatrixDiff(argv),
		)
		.command(
			["ast <original> <patched>", "diff <original> <patched>"],
			"Compare two JS files by identifiable AST nodes",
			(yargs) => {
				return yargs
					.positional("original", { type: "string", demandOption: true })
					.positional("patched", { type: "string", demandOption: true })
					.option("context", { alias: "c", type: "number", default: 2 });
			},
			(argv) => runAstDiff(argv),
		)
		.help()
		.strict()
		.parse();
}

function parseFile(filePath: string) {
	const code = fs.readFileSync(filePath, "utf-8");
	return {
		code,
		ast: parse(code),
	};
}

function extractMetadata(file: string, code: string): BundleMetadata {
	return {
		file,
		bytes: Buffer.byteLength(code),
		lineCount: code.split("\n").length,
		commentVersions: uniqueMatches(code, /^\/\/\s*Version:\s*([^\n]+)/gm),
		embeddedVersions: uniqueMatches(code, /\bVERSION\s*:\s*["']([^"']+)["']/g),
		buildTimes: uniqueMatches(code, /\bBUILD_TIME\s*:\s*["']([^"']+)["']/g),
		gitShas: uniqueMatches(code, /\bGIT_SHA\s*:\s*["']([^"']+)["']/g),
	};
}

function uniqueMatches(code: string, pattern: RegExp): string[] {
	const values = new Set<string>();
	for (const match of code.matchAll(pattern)) values.add(match[1]);
	return [...values].sort();
}

const INVENTORY_KINDS: InventoryKind[] = [
	"commands",
	"routes",
	"sqlTables",
	"sqlIndexes",
];

function createEmptyInventory(): BundleInventory {
	return {
		commands: new Map(),
		routes: new Map(),
		sqlTables: new Map(),
		sqlIndexes: new Map(),
	};
}

function addInventoryEntry(
	inventory: BundleInventory,
	kind: InventoryKind,
	rawValue: string,
	nodePath: any,
	contextLimit: number,
): void {
	const value = normalizeInventoryValue(rawValue);
	if (!value) return;
	const bucket = inventory[kind];
	const existing = bucket.get(value);
	const context = buildInventoryContext(nodePath);
	if (existing) {
		existing.count += 1;
		if (existing.contexts.length < contextLimit)
			existing.contexts.push(context);
		return;
	}
	bucket.set(value, { value, count: 1, contexts: [context] });
}

function normalizeInventoryValue(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function buildInventoryContext(nodePath: any): InventoryContext {
	return {
		line: nodePath.node.loc?.start.line ?? null,
		ast: generateAstBreadcrumbs(nodePath),
	};
}

function extractCommandName(node: t.CallExpression): string | null {
	const callee = node.callee;
	if (!t.isMemberExpression(callee)) return null;
	const property = callee.property;
	const isCommand =
		(t.isIdentifier(property) && property.name === "command") ||
		(t.isStringLiteral(property) && property.value === "command");
	if (!isCommand) return null;
	const [firstArg] = node.arguments;
	if (!t.isStringLiteral(firstArg)) return null;
	return firstArg.value;
}

function commandAliasForInitializer(
	node: t.Node | null | undefined,
	commandAliases: Map<string, string>,
): string | null {
	if (!node) return null;
	if (t.isCallExpression(node)) return extractCommandPath(node, commandAliases);
	if (t.isMemberExpression(node)) {
		const object = node.object;
		if (t.isIdentifier(object)) return commandAliases.get(object.name) ?? null;
	}
	return null;
}

function extractCommandPath(
	node: t.CallExpression,
	commandAliases: Map<string, string>,
): string | null {
	const direct = extractDirectCommandPath(node, commandAliases);
	if (direct) return direct;
	const callee = node.callee;
	if (!t.isMemberExpression(callee)) return null;
	if (t.isCallExpression(callee.object)) {
		return extractCommandPath(callee.object, commandAliases);
	}
	if (t.isIdentifier(callee.object)) {
		return commandAliases.get(callee.object.name) ?? null;
	}
	return null;
}

function extractDirectCommandPath(
	node: t.CallExpression,
	commandAliases: Map<string, string>,
): string | null {
	const name = extractCommandName(node);
	if (!name) return null;
	const callee = node.callee;
	if (!t.isMemberExpression(callee)) return name;
	if (t.isIdentifier(callee.object)) {
		const parent = commandAliases.get(callee.object.name);
		return parent ? `${parent} ${name}` : name;
	}
	if (t.isCallExpression(callee.object)) {
		const parent = extractCommandPath(callee.object, commandAliases);
		return parent ? `${parent} ${name}` : name;
	}
	return name;
}

function isLikelyRouteValue(
	value: string,
	nodePath: any,
	objectKey?: string,
): boolean {
	const normalized = normalizeInventoryValue(value);
	if (!looksLikeRoute(normalized)) return false;
	if (hasKnownRoutePrefix(normalized)) return true;
	if (objectKey && isLikelyRouteObjectKey(objectKey, normalized, nodePath))
		return true;
	if (isRouteRegistrationCallContext(nodePath)) return true;
	if (isRouteCollectionContext(nodePath)) return true;
	return isRouteComparisonContext(nodePath);
}

function isLikelyRouteKey(value: string, nodePath: any): boolean {
	const normalized = normalizeInventoryValue(value);
	if (!looksLikeRoute(normalized)) return false;
	return (
		hasKnownRoutePrefix(normalized) ||
		isRouteRegistrationCallContext(nodePath) ||
		isRouteCollectionContext(nodePath) ||
		isRouteObjectContext(nodePath)
	);
}

function looksLikeRoute(value: string): boolean {
	const route = value.startsWith("${}/") ? value.slice(3) : value;
	return /^\/(?:\.well-known\/)?[A-Za-z0-9][A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(
		route,
	);
}

function hasKnownRoutePrefix(value: string): boolean {
	const route = value.startsWith("${}/") ? value.slice(3) : value;
	return /^\/(?:v\d+|api|oauth|\.well-known|healthz|readyz|status|protocol|device|managed|user)(?:\/|$)/i.test(
		route,
	);
}

function isLikelyRouteObjectKey(
	key: string,
	value: string,
	nodePath: any,
): boolean {
	if (ROUTE_STRONG_KEY_PATTERN.test(key)) return true;
	if (!ROUTE_WEAK_PATH_KEY_PATTERN.test(key)) return false;
	return (
		hasKnownRoutePrefix(value) ||
		isRouteRegistrationCallContext(nodePath) ||
		isRouteCollectionContext(nodePath) ||
		isRouteObjectContext(nodePath)
	);
}

function isRouteRegistrationCallContext(nodePath: any): boolean {
	let current = nodePath;
	while (current?.parentPath) {
		const parent = current.parentPath.node;
		if (t.isCallExpression(parent)) {
			const index = parent.arguments.indexOf(current.node);
			if (index === 0 && isRouteRegistrationCallee(parent.callee)) {
				return true;
			}
		}
		if (
			!t.isTemplateLiteral(parent) &&
			!t.isStringLiteral(parent) &&
			!t.isArrayExpression(parent) &&
			!t.isObjectProperty(parent) &&
			!t.isObjectExpression(parent) &&
			!t.isMemberExpression(parent)
		) {
			return false;
		}
		current = current.parentPath;
	}
	return false;
}

function isRouteRegistrationCallee(
	callee: t.Expression | t.V8IntrinsicIdentifier,
): boolean {
	const name = calleeName(callee);
	return name ? ROUTE_METHOD_NAMES.has(name) : false;
}

function calleeName(
	callee: t.Expression | t.V8IntrinsicIdentifier,
): string | null {
	if (t.isIdentifier(callee)) return callee.name;
	if (!t.isMemberExpression(callee)) return null;
	const property = callee.property;
	if (t.isIdentifier(property)) return property.name;
	if (t.isStringLiteral(property)) return property.value;
	return null;
}

function isRouteCollectionContext(nodePath: any): boolean {
	let current = nodePath;
	while (current?.parentPath) {
		const parent = current.parentPath.node;
		if (
			t.isVariableDeclarator(parent) &&
			parent.init === current.node &&
			t.isIdentifier(parent.id) &&
			isRouteCollectionName(parent.id.name)
		) {
			return true;
		}
		if (
			t.isAssignmentExpression(parent) &&
			parent.right === current.node &&
			routeCollectionTargetName(parent.left)
		) {
			return true;
		}
		if (t.isObjectProperty(parent) && parent.value === current.node) {
			const key = objectKeyToString(parent.key);
			if (key && isRouteCollectionName(key)) return true;
		}
		current = current.parentPath;
	}
	return false;
}

function routeCollectionTargetName(left: t.Node): string | null {
	if (t.isIdentifier(left) && isRouteCollectionName(left.name))
		return left.name;
	if (!t.isMemberExpression(left)) return null;
	const property = left.property;
	const name = t.isIdentifier(property)
		? property.name
		: t.isStringLiteral(property)
			? property.value
			: null;
	return name && isRouteCollectionName(name) ? name : null;
}

function isRouteCollectionName(name: string): boolean {
	return ROUTE_COLLECTION_NAME_PATTERN.test(name);
}

function isRouteObjectContext(nodePath: any): boolean {
	let current = nodePath.parentPath;
	while (current) {
		if (t.isObjectExpression(current.node)) {
			const keys = new Set<string>();
			let hasHttpMethod = false;
			for (const property of current.node.properties) {
				if (!t.isObjectProperty(property)) continue;
				const key = objectKeyToString(property.key);
				if (key) keys.add(key);
				const value = labelValueToString(property.value);
				if (
					key?.toLowerCase() === "method" &&
					value &&
					ROUTE_METHOD_NAMES.has(value.toLowerCase())
				) {
					hasHttpMethod = true;
				}
			}
			return (
				hasHttpMethod ||
				[...keys].some((key) => ROUTE_STRONG_KEY_PATTERN.test(key)) ||
				isRouteCollectionContext(current)
			);
		}
		current = current.parentPath;
	}
	return false;
}

function isRouteComparisonContext(nodePath: any): boolean {
	let current = nodePath.parentPath;
	while (current) {
		const node = current.node;
		if (
			t.isBinaryExpression(node) &&
			["===", "!==", "==", "!="].includes(node.operator)
		) {
			return true;
		}
		if (
			!t.isTemplateLiteral(node) &&
			!t.isStringLiteral(node) &&
			!t.isMemberExpression(node)
		) {
			return false;
		}
		current = current.parentPath;
	}
	return false;
}

function addSqlInventoryFromText(
	text: string,
	nodePath: any,
	addInventory: (kind: InventoryKind, rawValue: string, nodePath: any) => void,
): void {
	for (const match of text.matchAll(
		/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w.]+"?)/gi,
	)) {
		addInventory("sqlTables", stripSqlIdentifier(match[1]), nodePath);
	}
	for (const match of text.matchAll(
		/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w.]+"?)/gi,
	)) {
		addInventory("sqlIndexes", stripSqlIdentifier(match[1]), nodePath);
	}
}

function stripSqlIdentifier(value: string): string {
	return value.replace(/^"|"$/g, "");
}

function extractBundleFacts(
	file: string,
	options: BundleDiffOptions,
): BundleFacts {
	if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
	if (options.cache) {
		const cached = readCachedBundleFacts(file, options);
		if (cached) return cached;
	}

	let code = fs.readFileSync(file, "utf-8");
	const metadata = extractMetadata(file, code);
	const ast = parse(code);
	code = "";
	const surfaces = new Map<string, SurfaceEntry>();
	const inventory = createEmptyInventory();
	const commandAliases = new Map<string, string>();

	const addSurface = (
		rawValue: string,
		usage: string,
		nodePath: any,
		forcedKind?: SurfaceKind,
	) => {
		const normalized = normalizeSurfaceValue(
			rawValue,
			options.includeBuildMetadata,
		);
		if (!normalized) return;

		const kind = forcedKind ?? classifySurface(normalized, usage);
		if (!shouldKeepSurface(normalized, kind, options.minLength)) return;
		if (shouldIgnoreSurfaceByConfig(normalized, options.config)) return;

		const id = `${kind}\0${normalized}`;
		const existing = surfaces.get(id);
		const context = buildSurfaceContext(nodePath, usage);
		if (existing) {
			existing.count += 1;
			if (existing.contexts.length < options.contextLimit) {
				existing.contexts.push(context);
			}
			return;
		}

		surfaces.set(id, {
			kind,
			value: normalized,
			count: 1,
			contexts: [context],
		});
	};

	const addInventory = (
		kind: InventoryKind,
		rawValue: string,
		nodePath: any,
	) => {
		addInventoryEntry(
			inventory,
			kind,
			rawValue,
			nodePath,
			options.contextLimit,
		);
	};

	const addReminderAndRemainder = (
		text: string,
		nodePath: any,
		remainderUsage: string,
		remainderKind?: SurfaceKind,
	): boolean => {
		const reminders = extractSystemReminderBlocks(text);
		if (reminders.length === 0) return false;
		for (const reminder of reminders) {
			addSurface(reminder, "system-reminder", nodePath, "system-reminder");
		}
		const remainder = stripReminderBlocks(text);
		if (remainder)
			addSurface(remainder, remainderUsage, nodePath, remainderKind);
		return true;
	};

	traverse(ast, {
		VariableDeclarator(nodePath: any) {
			if (!t.isIdentifier(nodePath.node.id)) return;
			const commandPath = commandAliasForInitializer(
				nodePath.node.init,
				commandAliases,
			);
			if (commandPath) commandAliases.set(nodePath.node.id.name, commandPath);
		},
		AssignmentExpression(nodePath: any) {
			if (!t.isIdentifier(nodePath.node.left)) return;
			const commandPath = commandAliasForInitializer(
				nodePath.node.right,
				commandAliases,
			);
			if (commandPath) commandAliases.set(nodePath.node.left.name, commandPath);
		},
		ObjectMethod(nodePath: any) {
			const key = objectKeyToString(nodePath.node.key);
			if (key) addSurface(key, "object-method-key", nodePath, "object-key");
		},
		ObjectProperty(nodePath: any) {
			const key = objectKeyToString(nodePath.node.key);
			if (key) {
				addSurface(key, "object-property-key", nodePath, "object-key");
				if (isLikelyRouteKey(key, nodePath))
					addInventory("routes", key, nodePath);

				const labelValue = labelValueToString(nodePath.node.value);
				if (labelValue && HIGH_SIGNAL_LABEL_KEYS.has(key)) {
					addSurface(
						`${key}=${labelValue}`,
						"object-label",
						nodePath,
						"object-label",
					);
				}
				if (key === "command" && labelValue) {
					addInventory("commands", labelValue, nodePath);
				}
				if (labelValue && isLikelyRouteValue(labelValue, nodePath, key)) {
					addInventory("routes", labelValue, nodePath);
				}
				if (labelValue)
					addSqlInventoryFromText(labelValue, nodePath, addInventory);
			}
		},
		RegExpLiteral(nodePath: any) {
			addSurface(
				`/${nodePath.node.pattern}/${nodePath.node.flags}`,
				"regex",
				nodePath,
				"regex",
			);
		},
		StringLiteral(nodePath: any) {
			if (isLikelyRouteValue(nodePath.node.value, nodePath)) {
				addInventory("routes", nodePath.node.value, nodePath);
			}
			addSqlInventoryFromText(nodePath.node.value, nodePath, addInventory);
			if (isObjectPropertyKey(nodePath)) return;
			if (addReminderAndRemainder(nodePath.node.value, nodePath, "string")) {
				return;
			}
			addSurface(nodePath.node.value, "string", nodePath);
		},
		TemplateLiteral(nodePath: any) {
			const shape = templateShape(nodePath.node);
			if (isLikelyRouteValue(shape, nodePath))
				addInventory("routes", shape, nodePath);
			addSqlInventoryFromText(shape, nodePath, addInventory);
			if (addReminderAndRemainder(shape, nodePath, "template", "template")) {
				return;
			}
			addSurface(shape, "template", nodePath, "template");
			for (const quasi of nodePath.node.quasis) {
				const chunk = quasi.value.cooked ?? quasi.value.raw;
				if (addReminderAndRemainder(chunk, nodePath, "template-chunk")) {
					continue;
				}
				addSurface(chunk, "template-chunk", nodePath);
			}
		},
		CallExpression(nodePath: any) {
			const commandPath = extractDirectCommandPath(
				nodePath.node,
				commandAliases,
			);
			if (commandPath) addInventory("commands", commandPath, nodePath);
			for (const write of extractSettingsWrites(nodePath.node)) {
				addSurface(write, "settings-write", nodePath, "settings-write");
			}
		},
	});

	const facts = {
		metadata,
		surfaces,
		inventory,
	};
	if (options.cache) writeCachedBundleFacts(file, options, facts);
	return facts;
}

function readCachedBundleFacts(
	file: string,
	options: BundleDiffOptions,
): BundleFacts | null {
	const cachePath = getBundleFactsCachePath(file, options);
	if (!fs.existsSync(cachePath)) return null;
	try {
		const raw = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as {
			metadata: BundleMetadata;
			surfaces: [string, SurfaceEntry][];
			inventory?: Partial<Record<InventoryKind, [string, InventoryEntry][]>>;
		};
		return {
			metadata: raw.metadata,
			surfaces: new Map(raw.surfaces),
			inventory: deserializeInventory(raw.inventory),
		};
	} catch {
		return null;
	}
}

function writeCachedBundleFacts(
	file: string,
	options: BundleDiffOptions,
	facts: BundleFacts,
): void {
	const cachePath = getBundleFactsCachePath(file, options);
	try {
		fs.mkdirSync(path.dirname(cachePath), { recursive: true });
		fs.writeFileSync(
			cachePath,
			JSON.stringify(
				{
					metadata: facts.metadata,
					surfaces: [...facts.surfaces.entries()],
					inventory: serializeInventory(facts.inventory),
				},
				null,
				2,
			),
		);
	} catch {
		// Cache writes are an optimization; read-only worktrees should still diff.
	}
}

function serializeInventory(
	inventory: BundleInventory,
): Record<InventoryKind, [string, InventoryEntry][]> {
	return {
		commands: [...inventory.commands.entries()],
		routes: [...inventory.routes.entries()],
		sqlTables: [...inventory.sqlTables.entries()],
		sqlIndexes: [...inventory.sqlIndexes.entries()],
	};
}

function deserializeInventory(
	raw: Partial<Record<InventoryKind, [string, InventoryEntry][]>> | undefined,
): BundleInventory {
	const inventory = createEmptyInventory();
	if (!raw) return inventory;
	for (const kind of INVENTORY_KINDS) {
		inventory[kind] = new Map(raw[kind] ?? []);
	}
	return inventory;
}

function getBundleFactsCachePath(
	file: string,
	options: BundleDiffOptions,
): string {
	const stat = fs.statSync(file);
	const key = hashText(
		JSON.stringify({
			schema: CACHE_SCHEMA_VERSION,
			file: path.resolve(file),
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			includeBuildMetadata: options.includeBuildMetadata,
			minLength: options.minLength,
			config: options.config,
		}),
	);
	return path.join(options.cacheDir, `${key}.json`);
}

function normalizeSurfaceValue(
	value: string,
	includeBuildMetadata: boolean,
): string | null {
	const trimmed = value.replace(/\s+/g, " ").trim();
	if (!trimmed) return null;
	if (includeBuildMetadata) return trimmed;

	const normalized = trimmed
		.replace(
			/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g,
			"<build-time>",
		)
		.replace(/\b[0-9a-f]{40}\b/gi, "<git-sha>")
		.replace(/\bv?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/g, "<semver>");

	if (
		normalized === "<build-time>" ||
		normalized === "<git-sha>" ||
		normalized === "<semver>"
	) {
		return normalized;
	}

	return normalized;
}

function shouldIgnoreSurfaceByConfig(
	value: string,
	config: DiffConfig,
): boolean {
	const stripped = stripObjectLabelKey(value).toLowerCase();
	for (const prefix of config.ignorePrefixes) {
		const normalizedPrefix = prefix.toLowerCase();
		if (
			stripped.startsWith(normalizedPrefix) ||
			stripped.startsWith(`[${normalizedPrefix}]`)
		) {
			return true;
		}
	}

	if (config.ignoreTokens.length === 0) return false;
	const tokens = new Set(tokenizeSurface(value));
	return config.ignoreTokens.some((token) => tokens.has(token.toLowerCase()));
}

function loadDiffConfig(configPath?: string): DiffConfig {
	const resolvedPath =
		configPath ??
		(fs.existsSync(path.join(REPO_ROOT, "bundle-diff.config.json"))
			? path.join(REPO_ROOT, "bundle-diff.config.json")
			: null);
	if (!resolvedPath) return DEFAULT_DIFF_CONFIG;

	let raw: string;
	try {
		raw = fs.readFileSync(resolvedPath, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Failed to read bundle diff config ${resolvedPath}: ${message}`,
		);
	}

	let parsed: Partial<DiffConfig>;
	try {
		parsed = JSON.parse(raw) as Partial<DiffConfig>;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Invalid JSON in bundle diff config ${resolvedPath}: ${message}`,
		);
	}

	return {
		ignoreTokens: normalizeStringArray(parsed.ignoreTokens),
		ignorePrefixes: normalizeStringArray(parsed.ignorePrefixes),
		highSignalTokens: normalizeStringArray(parsed.highSignalTokens),
	};
}

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => String(item).trim())
		.filter((item) => item.length > 0);
}

function hashText(value: string): string {
	return crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function classifySurface(value: string, usage: string): SurfaceKind {
	if (usage === "template") return "template";
	if (/^https?:\/\//.test(value)) return "url";
	if (/^--?[a-zA-Z][a-zA-Z0-9-]*(?:=.*)?$/.test(value)) return "cli-flag";
	if (/^\/[a-zA-Z][a-zA-Z0-9:_-]*(?:\s|$)/.test(value)) {
		return "slash-command";
	}
	if (/^[A-Z][A-Z0-9_]{2,}$/.test(value) && /_/.test(value)) return "env-var";
	if (/\s/.test(value) || value.length >= 40) return "user-message";
	return "literal";
}

function shouldKeepSurface(
	value: string,
	kind: SurfaceKind,
	minLength: number,
): boolean {
	if (kind !== "object-key" && kind !== "literal") return true;
	if (kind === "object-key" && HIGH_SIGNAL_LABEL_KEYS.has(value)) return true;
	if (value.length < minLength) return false;
	if (/^[A-Za-z_$][A-Za-z0-9_$]?$/.test(value)) return false;
	return true;
}

function isObjectPropertyKey(nodePath: any): boolean {
	const parent = nodePath.parentPath?.node;
	return t.isObjectProperty(parent) && parent.key === nodePath.node;
}

function objectKeyToString(node: t.Node): string | null {
	if (t.isIdentifier(node)) return node.name;
	if (t.isStringLiteral(node)) return node.value;
	if (t.isNumericLiteral(node)) return String(node.value);
	return null;
}

function labelValueToString(node: t.Node): string | null {
	if (t.isStringLiteral(node)) return node.value;
	if (t.isNumericLiteral(node)) return String(node.value);
	if (t.isBooleanLiteral(node)) return node.value ? "true" : "false";
	if (t.isTemplateLiteral(node)) return templateShape(node);
	return null;
}

function templateShape(node: t.TemplateLiteral): string {
	let result = "";
	for (let i = 0; i < node.quasis.length; i++) {
		result += node.quasis[i].value.cooked ?? node.quasis[i].value.raw;
		if (i < node.expressions.length) result += "${}";
	}
	return result;
}

const SYSTEM_REMINDER_PATTERN =
	/<system-reminder>\s*([\s\S]*?)\s*<\/system-reminder>/g;

function stripReminderBlocks(value: string): string {
	return value
		.replace(SYSTEM_REMINDER_PATTERN, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function extractSystemReminderBlocks(value: string): string[] {
	const reminders: string[] = [];
	for (const match of value.matchAll(SYSTEM_REMINDER_PATTERN)) {
		const body = match[1].replace(/\s+/g, " ").trim();
		if (body) reminders.push(`<system-reminder> ${body} </system-reminder>`);
	}
	return reminders;
}

function extractSettingsWrites(node: t.CallExpression): string[] {
	const [scopeArg, updateArg] = node.arguments;
	if (!t.isStringLiteral(scopeArg)) return [];
	if (!t.isObjectExpression(updateArg)) return [];
	if (!isSettingsScope(scopeArg.value)) return [];

	const writes: string[] = [];
	for (const property of updateArg.properties) {
		if (!t.isObjectProperty(property)) continue;
		const key = objectKeyToString(property.key);
		if (!key) continue;
		writes.push(`${scopeArg.value}.${key}`);
	}
	return writes;
}

function isSettingsScope(value: string): boolean {
	return /^[A-Za-z][A-Za-z0-9]*(?:Settings|Config)$/.test(value);
}

function buildSurfaceContext(nodePath: any, usage: string): SurfaceContext {
	return {
		line: nodePath.node.loc?.start.line ?? null,
		usage,
		ast: generateAstBreadcrumbs(nodePath),
		objectLabels: nearestObjectLabels(nodePath),
	};
}

function generateAstBreadcrumbs(nodePath: any): string {
	const parts: string[] = [];
	let current = nodePath.parentPath;
	while (current) {
		parts.unshift(current.node.type);
		current = current.parentPath;
	}
	return parts.slice(-5).join(" > ");
}

function nearestObjectLabels(nodePath: any): string[] {
	let current = nodePath;
	while (current) {
		if (t.isObjectExpression(current.node)) {
			const labels: string[] = [];
			for (const property of current.node.properties) {
				if (!t.isObjectProperty(property)) continue;
				const key = objectKeyToString(property.key);
				if (!key || !HIGH_SIGNAL_LABEL_KEYS.has(key)) continue;
				const value = labelValueToString(property.value);
				if (!value) continue;
				labels.push(`${key}=${truncateForDisplay(value, 70)}`);
				if (labels.length >= 3) break;
			}
			return labels;
		}
		current = current.parentPath;
	}
	return [];
}

function buildBundleDiffReport(
	oldFacts: BundleFacts,
	newFacts: BundleFacts,
	options: BundleDiffOptions,
	promptExportDir?: string,
): BundleDiffReport {
	const added: SurfaceChange[] = [];
	const removed: SurfaceChange[] = [];
	const countChanged: SurfaceChange[] = [];

	for (const [id, entry] of newFacts.surfaces.entries()) {
		const oldEntry = oldFacts.surfaces.get(id);
		if (!oldEntry) {
			added.push({ ...entry, delta: entry.count });
		} else if (oldEntry.count !== entry.count) {
			countChanged.push({ ...entry, delta: entry.count - oldEntry.count });
		}
	}

	for (const [id, entry] of oldFacts.surfaces.entries()) {
		if (!newFacts.surfaces.has(id)) {
			removed.push({ ...entry, delta: -entry.count });
		}
	}

	sortChanges(added);
	sortChanges(removed);
	sortChanges(countChanged);

	const addedClusters = buildClusters(added);
	const removedClusters = buildClusters(removed);
	const prefixRewrites = buildPrefixRewrites(removed, added);
	const rewriteCandidates = buildRewriteCandidates(removed, added, {
		includeCrossPrefix: false,
	});
	const commandCandidates = buildCommandCandidates(
		added,
		removed,
		countChanged,
	);

	const inventory = buildInventoryDiff(oldFacts.inventory, newFacts.inventory);
	const report: BundleDiffReport = {
		old: oldFacts.metadata,
		new: newFacts.metadata,
		totals: {
			oldUnique: oldFacts.surfaces.size,
			newUnique: newFacts.surfaces.size,
			added: added.length,
			removed: removed.length,
			countChanged: countChanged.length,
		},
		addedByKind: countByKind(added),
		removedByKind: countByKind(removed),
		added,
		removed,
		countChanged,
		sections: buildSurfaceSections(added, removed, countChanged),
		addedClusters,
		removedClusters,
		clusters: addedClusters,
		prefixRewrites,
		rewriteCandidates,
		addedCapabilities: buildCapabilityCandidates(added, options.config),
		removedCapabilities: buildCapabilityCandidates(removed, options.config),
		commandCandidates,
		inventory,
		releaseSummary: buildReleaseSummary({
			added,
			removed,
			inventory,
			commandCandidates,
			rewriteCandidates,
		}),
		patchRelevance: buildPatchRelevance(
			added,
			removed,
			countChanged,
			rewriteCandidates,
		),
	};
	if (promptExportDir) {
		report.promptExport = buildPromptExportCheck(promptExportDir, added);
	}
	return report;
}

function sortChanges(changes: SurfaceChange[]): void {
	changes.sort((a, b) => {
		const kindDelta = SURFACE_KIND_ORDER[b.kind] - SURFACE_KIND_ORDER[a.kind];
		if (kindDelta !== 0) return kindDelta;
		const countDelta = Math.abs(b.delta) - Math.abs(a.delta);
		if (countDelta !== 0) return countDelta;
		return a.value.localeCompare(b.value);
	});
}

function countByKind(changes: SurfaceChange[]): Record<SurfaceKind, number> {
	const result = Object.fromEntries(
		SURFACE_KINDS.map((kind) => [kind, 0]),
	) as Record<SurfaceKind, number>;
	for (const change of changes) result[change.kind] += 1;
	return result;
}

function buildInventoryDiff(
	oldInventory: BundleInventory,
	newInventory: BundleInventory,
): InventoryDiff {
	const added: InventoryChange[] = [];
	const removed: InventoryChange[] = [];
	const countChanged: InventoryChange[] = [];

	for (const kind of INVENTORY_KINDS) {
		const oldEntries = oldInventory[kind];
		const newEntries = newInventory[kind];
		for (const [value, entry] of newEntries.entries()) {
			const oldEntry = oldEntries.get(value);
			if (!oldEntry) {
				added.push({ ...entry, kind, delta: entry.count });
			} else if (oldEntry.count !== entry.count) {
				countChanged.push({
					...entry,
					kind,
					delta: entry.count - oldEntry.count,
				});
			}
		}
		for (const [value, entry] of oldEntries.entries()) {
			if (!newEntries.has(value)) {
				removed.push({ ...entry, kind, delta: -entry.count });
			}
		}
	}

	sortInventoryChanges(added);
	sortInventoryChanges(removed);
	sortInventoryChanges(countChanged);
	return { added, removed, countChanged };
}

function sortInventoryChanges(changes: InventoryChange[]): void {
	changes.sort((a, b) => {
		const kindDelta =
			INVENTORY_KINDS.indexOf(a.kind) - INVENTORY_KINDS.indexOf(b.kind);
		if (kindDelta !== 0) return kindDelta;
		const lineDelta = (a.contexts[0]?.line ?? 0) - (b.contexts[0]?.line ?? 0);
		if (lineDelta !== 0) return lineDelta;
		return a.value.localeCompare(b.value);
	});
}

interface ReleaseSummaryInput {
	added: SurfaceChange[];
	removed: SurfaceChange[];
	inventory: InventoryDiff;
	commandCandidates: CommandCandidate[];
	rewriteCandidates: RewriteCandidate[];
}

function buildReleaseSummary(input: ReleaseSummaryInput): ReleaseSummary {
	const summary = createEmptyReleaseSummary();
	const addItem = createReleaseSummaryAdder(summary);

	const addedCommands = input.inventory.added.filter(
		(change) => change.kind === "commands",
	);
	for (const command of addedCommands) {
		addItem("features", {
			title: `Command added: ${command.value}`,
			confidence: "high",
			evidence: [formatInventoryEvidence(command)],
			lines: inventoryLines([command]),
		});
	}
	addCommandCandidateSummaries(addedCommands, input.commandCandidates, addItem);

	const addedRoutes = input.inventory.added.filter(
		(change) => change.kind === "routes",
	);
	addRouteFamilySummaries(addedRoutes, addItem);

	const addedTables = input.inventory.added.filter(
		(change) => change.kind === "sqlTables",
	);
	const addedIndexes = input.inventory.added.filter(
		(change) => change.kind === "sqlIndexes",
	);
	if (addedTables.length > 0) {
		addItem("infrastructure", {
			title: `SQL schema added: ${summarizeValues(addedTables)}`,
			confidence: "high",
			evidence: [
				...addedTables.slice(0, 8).map(formatInventoryEvidence),
				...addedIndexes.slice(0, 4).map(formatInventoryEvidence),
			],
			lines: inventoryLines([...addedTables, ...addedIndexes]),
		});
	}

	addKeywordSurfaceSummary(
		input.added,
		addItem,
		"authSecurity",
		"Auth/security surface added",
		/(?:oauth|openid|oidc|jose|jwt|jwe|jws|jwk|issuer|token|credential|bearer|certificate|proxy|private|public|signature|algorithm)/i,
		"medium",
	);
	addKeywordSurfaceSummary(
		input.added,
		addItem,
		"hardening",
		"Hardening or bug-fix hint added",
		/(?:mismatch|timeout|timed out|invalid|rejected|missing|required|failed|failure|unavailable|outside|stale|retry|denied|forbidden|too large|malformed|parse|resolved?|symlink|junction|unc|not allowed)/i,
		"medium",
	);

	const removedHighSignal = input.removed.filter(
		(change) => SURFACE_KIND_ORDER[change.kind] >= 60,
	);
	if (removedHighSignal.length > 0) {
		const evidenceHits = removedHighSignal.slice(0, 8);
		addItem("behaviorChanges", {
			title: "High-signal public text or labels removed",
			confidence: "medium",
			evidence: evidenceHits.map(formatSurfaceEvidence),
			lines: surfaceLines(evidenceHits),
		});
	}

	const removedCommands = input.inventory.removed.filter(
		(change) => change.kind === "commands",
	);
	if (removedCommands.length > 0) {
		addItem("behaviorChanges", {
			title: `Command removed: ${summarizeValues(removedCommands)}`,
			confidence: "high",
			evidence: removedCommands.slice(0, 8).map(formatInventoryEvidence),
			lines: inventoryLines(removedCommands),
		});
	}

	const likelyFlagNoise = input.added.filter(
		(change) =>
			change.kind === "cli-flag" &&
			!input.inventory.added.some(
				(inventory) =>
					inventory.kind === "commands" &&
					change.contexts.some((context) =>
						inventory.contexts.some(
							(inventoryContext) =>
								context.line !== null &&
								inventoryContext.line !== null &&
								Math.abs(context.line - inventoryContext.line) <= 8,
						),
					),
			),
	);
	if (likelyFlagNoise.length > 0) {
		const evidenceHits = likelyFlagNoise.slice(0, 6);
		addItem("noise", {
			title: "Flag-shaped strings not tied to declared commands",
			confidence: "medium",
			evidence: evidenceHits.map(formatSurfaceEvidence),
			lines: surfaceLines(evidenceHits),
		});
	}

	const rewriteEvidence = input.rewriteCandidates
		.filter((candidate) => candidate.score >= 0.82)
		.slice(0, 6);
	if (rewriteEvidence.length > 0) {
		addItem("behaviorChanges", {
			title: "Likely text rewrites",
			confidence: "low",
			evidence: rewriteEvidence.map(
				(rewrite) =>
					`${truncateForDisplay(rewrite.oldChange.value, 80)} -> ${truncateForDisplay(rewrite.newChange.value, 80)}`,
			),
			lines: rewriteEvidence.flatMap((rewrite) =>
				[
					rewrite.oldChange.contexts[0]?.line,
					rewrite.newChange.contexts[0]?.line,
				].filter((line): line is number => line !== null && line !== undefined),
			),
		});
	}

	return summary;
}

function createEmptyReleaseSummary(): ReleaseSummary {
	return {
		features: [],
		infrastructure: [],
		authSecurity: [],
		hardening: [],
		behaviorChanges: [],
		noise: [],
	};
}

function releaseSummaryHasItems(summary: ReleaseSummary): boolean {
	return RELEASE_SUMMARY_KEYS.some((section) => summary[section].length > 0);
}

function createReleaseSummaryAdder(summary: ReleaseSummary) {
	const seen = new Set<string>();
	return (section: ReleaseSummarySectionKey, item: ReleaseSummaryItem) => {
		const key = `${section}\0${item.title}`;
		if (seen.has(key)) return;
		seen.add(key);
		summary[section].push({
			...item,
			evidence: item.evidence.slice(0, 10),
			lines: uniqueNumbers(item.lines).slice(0, 10),
		});
	};
}

function addCommandCandidateSummaries(
	inventoryCommands: InventoryChange[],
	commandCandidates: CommandCandidate[],
	addItem: ReturnType<typeof createReleaseSummaryAdder>,
): void {
	const inventoryKeys = new Set(
		inventoryCommands.map((command) => commandSummaryKey(command.value)),
	);
	for (const command of commandCandidates) {
		if (command.change !== "added") continue;
		if (!isUsefulCommandSummaryCandidate(command)) continue;
		const key = commandSummaryKey(command.command);
		if (inventoryKeys.has(key)) continue;
		inventoryKeys.add(key);
		addItem("features", {
			title: `Command candidate added: ${command.command}`,
			confidence: command.confidence,
			evidence: formatCommandCandidateEvidence(command),
			lines: command.line ? [command.line] : [],
		});
	}
}

function isUsefulCommandSummaryCandidate(command: CommandCandidate): boolean {
	return (
		command.confidence === "high" ||
		command.descriptions.length > 0 ||
		command.flags.length > 0
	);
}

function commandSummaryKey(command: string): string {
	return command
		.replace(/^claude\s+/, "")
		.replace(/\s+(?:\[[^\]]+\]|<[^>]+>)/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

function formatCommandCandidateEvidence(command: CommandCandidate): string[] {
	const evidence = [
		`command: ${command.command}${command.line ? ` (line ${command.line})` : ""}`,
	];
	for (const description of command.descriptions.slice(0, 2)) {
		evidence.push(`description: ${truncateForDisplay(description, 100)}`);
	}
	if (command.flags.length > 0) {
		evidence.push(`flags: ${command.flags.slice(0, 6).join(", ")}`);
	}
	return evidence;
}

function addRouteFamilySummaries(
	routes: InventoryChange[],
	addItem: ReturnType<typeof createReleaseSummaryAdder>,
): void {
	const routeFamilies: Array<{
		title: string;
		section: ReleaseSummarySectionKey;
		confidence: ReleaseSummaryItem["confidence"];
		match: RegExp;
	}> = [
		{
			title: "OAuth/device authorization routes added",
			section: "authSecurity",
			confidence: "high",
			match: /(?:oauth|device|callback|openid|well-known)/i,
		},
		{
			title: "Telemetry ingestion routes added",
			section: "infrastructure",
			confidence: "high",
			match: /\/(?:logs|metrics|traces)(?:$|[/?#])/i,
		},
		{
			title: "Admin or organization routes added",
			section: "features",
			confidence: "high",
			match: /(?:admin|audit|effective|organizations?|settings|bootstrap)/i,
		},
		{
			title: "Health/readiness/protocol routes added",
			section: "infrastructure",
			confidence: "high",
			match: /(?:health|ready|protocol|status|live)/i,
		},
		{
			title: "API routes added",
			section: "features",
			confidence: "medium",
			match: /^\/?(?:\$\{\}\/)?(?:api|v\d+)\//i,
		},
	];
	const matched = new Set<InventoryChange>();
	for (const family of routeFamilies) {
		const hits = routes.filter(
			(route) => !matched.has(route) && family.match.test(route.value),
		);
		if (hits.length === 0) continue;
		hits.forEach((hit) => {
			matched.add(hit);
		});
		addItem(family.section, {
			title: `${family.title}: ${summarizeValues(hits)}`,
			confidence: family.confidence,
			evidence: hits.slice(0, 8).map(formatInventoryEvidence),
			lines: inventoryLines(hits),
		});
	}
	const unmatched = routes.filter((route) => !matched.has(route));
	if (unmatched.length > 0) {
		addItem("features", {
			title: `Other routes added: ${summarizeValues(unmatched)}`,
			confidence: "medium",
			evidence: unmatched.slice(0, 8).map(formatInventoryEvidence),
			lines: inventoryLines(unmatched),
		});
	}
}

function addKeywordSurfaceSummary(
	changes: SurfaceChange[],
	addItem: ReturnType<typeof createReleaseSummaryAdder>,
	section: ReleaseSummarySectionKey,
	title: string,
	pattern: RegExp,
	confidence: ReleaseSummaryItem["confidence"],
): void {
	const hits = changes.filter((change) => pattern.test(change.value));
	if (hits.length === 0) return;
	const evidenceHits = hits.slice(0, 10);
	addItem(section, {
		title,
		confidence,
		evidence: evidenceHits.map(formatSurfaceEvidence),
		lines: surfaceLines(evidenceHits),
	});
}

function summarizeValues(changes: Array<{ value: string }>, limit = 6): string {
	const values = changes.map((change) => change.value);
	const shown = values.slice(0, limit).join(", ");
	if (values.length <= limit) return shown;
	return `${shown}, +${values.length - limit} more`;
}

function formatInventoryEvidence(change: InventoryChange): string {
	const line = change.contexts[0]?.line;
	return `${change.kind}: ${change.value}${line ? ` (line ${line})` : ""}`;
}

function formatSurfaceEvidence(change: SurfaceChange): string {
	const line = change.contexts[0]?.line;
	return `${change.kind}: ${truncateForDisplay(stripObjectLabelKey(change.value), 120)}${line ? ` (line ${line})` : ""}`;
}

function inventoryLines(changes: InventoryChange[]): number[] {
	return uniqueNumbers(
		changes
			.map((change) => change.contexts[0]?.line)
			.filter((line): line is number => line !== null && line !== undefined),
	);
}

function surfaceLines(changes: SurfaceChange[]): number[] {
	return uniqueNumbers(
		changes
			.map((change) => change.contexts[0]?.line)
			.filter((line): line is number => line !== null && line !== undefined),
	);
}

function uniqueNumbers(values: number[]): number[] {
	const seen = new Set<number>();
	const result: number[] = [];
	for (const value of values) {
		if (seen.has(value)) continue;
		seen.add(value);
		result.push(value);
	}
	return result;
}

function buildClusters(changes: SurfaceChange[]): SurfaceCluster[] {
	const clusterable = changes
		.filter((change) => SURFACE_KIND_ORDER[change.kind] >= 60)
		.filter((change) =>
			change.contexts.some((context) => context.line !== null),
		)
		.flatMap((change) =>
			change.contexts
				.filter((context) => context.line !== null)
				.map((context) => ({ change, line: context.line as number })),
		)
		.sort((a, b) => a.line - b.line);

	const clusters: SurfaceCluster[] = [];
	for (const item of clusterable) {
		const last = clusters.at(-1);
		if (!last || item.line - last.lineEnd > 8) {
			clusters.push({
				lineStart: item.line,
				lineEnd: item.line,
				score: SURFACE_KIND_ORDER[item.change.kind],
				changes: [item.change],
			});
			continue;
		}
		last.lineEnd = item.line;
		last.score += SURFACE_KIND_ORDER[item.change.kind];
		if (!last.changes.some((change) => sameSurface(change, item.change))) {
			last.changes.push(item.change);
		}
	}

	return clusters
		.filter((cluster) => cluster.changes.length >= 2)
		.sort((a, b) => b.score - a.score);
}

function sameSurface(a: SurfaceChange, b: SurfaceChange): boolean {
	return a.kind === b.kind && a.value === b.value;
}

function buildSurfaceSections(
	added: SurfaceChange[],
	removed: SurfaceChange[],
	countChanged: SurfaceChange[],
): SurfaceSections {
	const sections = createEmptySurfaceSections();

	for (const change of added) {
		const section = getSurfaceSection(change);
		if (section) sections[section].added.push(change);
	}
	for (const change of removed) {
		const section = getSurfaceSection(change);
		if (section) sections[section].removed.push(change);
	}
	for (const change of countChanged) {
		const section = getSurfaceSection(change);
		if (section) sections[section].countChanged.push(change);
	}

	return sections;
}

function createEmptySurfaceSections(): SurfaceSections {
	return {
		commands: { added: [], removed: [], countChanged: [] },
		flags: { added: [], removed: [], countChanged: [] },
		env: { added: [], removed: [], countChanged: [] },
		routes: { added: [], removed: [], countChanged: [] },
		settings: { added: [], removed: [], countChanged: [] },
		reminders: { added: [], removed: [], countChanged: [] },
		labels: { added: [], removed: [], countChanged: [] },
		messages: { added: [], removed: [], countChanged: [] },
	};
}

function getSurfaceSection(change: SurfaceChange): SurfaceSectionKey | null {
	if (isCommandSurface(change)) return "commands";
	if (change.kind === "cli-flag") return "flags";
	if (change.kind === "env-var") return "env";
	if (change.kind === "slash-command" || change.kind === "url") return "routes";
	if (change.kind === "settings-write") return "settings";
	if (change.kind === "system-reminder") return "reminders";
	if (isProductLabelSurface(change)) return "labels";
	if (change.kind === "user-message" || change.kind === "template") {
		return "messages";
	}
	return null;
}

function isCommandSurface(change: SurfaceChange): boolean {
	const value = stripObjectLabelKey(change.value);
	if (change.kind === "object-label") {
		const key = objectLabelKey(change.value);
		if (key === "command" || key === "commandName") return true;
	}
	if (change.kind === "slash-command" || change.kind === "cli-flag")
		return false;
	if (value.startsWith("/") || value.startsWith("-")) return false;
	if (value.length > 90) return false;
	if (!/[<[]/.test(value) && !value.startsWith("claude ")) return false;
	return /^[a-z][a-z0-9:_-]*(?:\s+(?:\[[^\]]+\]|<[^>]+>|[a-z][a-z0-9:_-]*))*$/.test(
		value,
	);
}

function isProductLabelSurface(change: SurfaceChange): boolean {
	if (change.kind !== "object-label") return false;
	const key = objectLabelKey(change.value);
	return (
		key === "id" ||
		key === "kind" ||
		key === "label" ||
		key === "name" ||
		key === "source" ||
		key === "title" ||
		key === "tool" ||
		key === "toolName" ||
		key === "type"
	);
}

function objectLabelKey(value: string): string | null {
	const index = value.indexOf("=");
	if (index <= 0) return null;
	return value.slice(0, index);
}

function stripObjectLabelKey(value: string): string {
	const key = objectLabelKey(value);
	if (!key) return value;
	return value.slice(key.length + 1);
}

function buildRewriteCandidates(
	removed: SurfaceChange[],
	added: SurfaceChange[],
	options: { includeCrossPrefix: boolean } = { includeCrossPrefix: true },
): RewriteCandidate[] {
	const candidates: RewriteCandidate[] = [];
	const removedPool = removed
		.filter(isRewriteCandidateSurface)
		.map(toRewriteData);
	const addedPool = added.filter(isRewriteCandidateSurface).map(toRewriteData);
	const addedByToken = new Map<string, RewriteSurfaceData[]>();
	for (const data of addedPool) {
		for (const token of data.tokens) {
			const existing = addedByToken.get(token);
			if (existing) {
				existing.push(data);
			} else {
				addedByToken.set(token, [data]);
			}
		}
	}

	for (const oldData of removedPool) {
		const checked = new Set<string>();
		for (const token of oldData.tokens) {
			const possibleMatches = addedByToken.get(token) ?? [];
			for (const newData of possibleMatches) {
				const newKey = surfaceIdentity(newData.change);
				if (checked.has(newKey)) continue;
				checked.add(newKey);
				if (
					!options.includeCrossPrefix &&
					oldData.prefix &&
					newData.prefix &&
					oldData.prefix !== newData.prefix
				) {
					continue;
				}
				if (
					!areComparableRewriteKinds(oldData.change.kind, newData.change.kind)
				) {
					continue;
				}
				const candidate = scoreRewriteCandidate(oldData, newData);
				if (!candidate) continue;
				candidates.push(candidate);
			}
		}
	}

	candidates.sort((a, b) => {
		const scoreDelta = b.score - a.score;
		if (scoreDelta !== 0) return scoreDelta;
		return b.sharedTokens.length - a.sharedTokens.length;
	});

	const selected: RewriteCandidate[] = [];
	const usedOld = new Set<string>();
	const usedNew = new Set<string>();
	for (const candidate of candidates) {
		const oldKey = rewriteIdentity(candidate.oldChange);
		const newKey = rewriteIdentity(candidate.newChange);
		if (usedOld.has(oldKey) || usedNew.has(newKey)) continue;
		selected.push(candidate);
		usedOld.add(oldKey);
		usedNew.add(newKey);
		if (selected.length >= 50) break;
	}

	return selected;
}

function toRewriteData(change: SurfaceChange): RewriteSurfaceData {
	return {
		change,
		tokens: tokenSetForRewrite(change.value),
		prefix: extractLogPrefix(change.value),
	};
}

function buildPrefixRewrites(
	removed: SurfaceChange[],
	added: SurfaceChange[],
): PrefixRewrite[] {
	const removedByPrefix = groupByPrefix(removed);
	const addedByPrefix = groupByPrefix(added);
	const rewrites: PrefixRewrite[] = [];

	for (const [oldPrefix, oldChanges] of removedByPrefix.entries()) {
		for (const [newPrefix, newChanges] of addedByPrefix.entries()) {
			if (oldPrefix === newPrefix) continue;
			const samples = buildRewriteCandidates(oldChanges, newChanges).slice(
				0,
				5,
			);
			const strongMatches = samples.filter(
				(candidate) => candidate.score >= 0.52,
			);
			if (strongMatches.length < 2) continue;
			const score =
				strongMatches.reduce((sum, candidate) => sum + candidate.score, 0) /
				strongMatches.length;
			rewrites.push({
				oldPrefix,
				newPrefix,
				score,
				matches: strongMatches.length,
				removedCount: oldChanges.length,
				addedCount: newChanges.length,
				samples: strongMatches,
			});
		}
	}

	return rewrites.sort((a, b) => {
		const matchDelta = b.matches - a.matches;
		if (matchDelta !== 0) return matchDelta;
		return b.score - a.score;
	});
}

function groupByPrefix(changes: SurfaceChange[]): Map<string, SurfaceChange[]> {
	const result = new Map<string, SurfaceChange[]>();
	for (const change of changes) {
		const prefix = extractLogPrefix(change.value);
		if (!prefix) continue;
		const existing = result.get(prefix);
		if (existing) {
			existing.push(change);
		} else {
			result.set(prefix, [change]);
		}
	}
	return result;
}

function extractLogPrefix(value: string): string | null {
	const match = /^\[([^\]]{2,50})\]/.exec(stripObjectLabelKey(value));
	return match?.[1] ?? null;
}

function isRewriteCandidateSurface(change: SurfaceChange): boolean {
	if (change.value.length < 12) return false;
	return (
		change.kind === "object-label" ||
		change.kind === "template" ||
		change.kind === "system-reminder" ||
		change.kind === "user-message" ||
		change.kind === "literal"
	);
}

function areComparableRewriteKinds(a: SurfaceKind, b: SurfaceKind): boolean {
	if (a === b) return true;
	const textKinds = new Set<SurfaceKind>([
		"object-label",
		"template",
		"user-message",
		"literal",
	]);
	return textKinds.has(a) && textKinds.has(b);
}

function scoreRewriteCandidate(
	oldData: RewriteSurfaceData,
	newData: RewriteSurfaceData,
): RewriteCandidate | null {
	const oldTokens = oldData.tokens;
	const newTokens = newData.tokens;
	const sharedTokens = [...oldTokens].filter((token) => newTokens.has(token));
	if (sharedTokens.length < 2) return null;
	if (sharedTokens.length < 3 && !(oldData.prefix && newData.prefix)) {
		return null;
	}

	const unionSize = new Set([...oldTokens, ...newTokens]).size;
	if (unionSize === 0) return null;
	const jaccard = sharedTokens.length / unionSize;
	const editSimilarity = normalizedEditSimilarity(
		normalizeForSimilarity(oldData.change.value),
		normalizeForSimilarity(newData.change.value),
	);
	const prefixBonus = oldData.prefix && newData.prefix ? 0.08 : 0;
	const score = Math.min(
		1,
		jaccard * 0.68 + editSimilarity * 0.32 + prefixBonus,
	);
	if (score < 0.44) return null;

	return {
		score,
		oldChange: oldData.change,
		newChange: newData.change,
		sharedTokens: sharedTokens.sort(),
	};
}

function tokenSetForRewrite(value: string): Set<string> {
	const tokens = tokenizeSurface(value).filter(
		(token) => token.length >= 3 && !TOKEN_STOPWORDS.has(token),
	);
	return new Set(tokens);
}

function buildCapabilityCandidates(
	changes: SurfaceChange[],
	config: DiffConfig,
): CapabilityCandidate[] {
	const groups = new Map<string, SurfaceChange[]>();
	for (const change of changes) {
		if (!isCapabilitySurface(change)) continue;
		const tokens = new Set(
			tokenizeSurface(change.value).filter(isCapabilityToken),
		);
		for (const token of tokens) {
			const existing = groups.get(token);
			if (existing) {
				existing.push(change);
			} else {
				groups.set(token, [change]);
			}
		}
	}

	const candidates = [...groups.entries()]
		.map(([token, groupedChanges]) => ({
			token,
			changes: dedupeChanges(groupedChanges),
			score: scoreCapabilityGroup(token, groupedChanges, config),
		}))
		.filter(
			(candidate) => candidate.changes.length >= 2 || candidate.score >= 140,
		)
		.sort((a, b) => {
			const scoreDelta = b.score - a.score;
			if (scoreDelta !== 0) return scoreDelta;
			return a.token.localeCompare(b.token);
		});

	return candidates.slice(0, 20);
}

function isCapabilitySurface(change: SurfaceChange): boolean {
	if (change.value.length < 5) return false;
	if (
		change.value.length > 220 &&
		change.kind !== "object-label" &&
		change.kind !== "env-var" &&
		change.kind !== "slash-command"
	) {
		return false;
	}
	return (
		change.kind === "object-label" ||
		change.kind === "template" ||
		change.kind === "user-message" ||
		change.kind === "env-var" ||
		change.kind === "slash-command"
	);
}

function isCapabilityToken(token: string): boolean {
	if (token.length < 4) return false;
	if (TOKEN_STOPWORDS.has(token)) return false;
	if (/^\d+$/.test(token)) return false;
	return true;
}

function scoreCapabilityGroup(
	token: string,
	changes: SurfaceChange[],
	config: DiffConfig,
): number {
	const uniqueChanges = dedupeChanges(changes);
	const kindScore = uniqueChanges.reduce(
		(sum, change) => sum + SURFACE_KIND_ORDER[change.kind],
		0,
	);
	const nameBonus = /^[a-z]+(?:-[a-z]+|_[a-z]+)*$/.test(token) ? 15 : 0;
	const highSignalBonus = config.highSignalTokens
		.map((value) => value.toLowerCase())
		.includes(token)
		? 100
		: 0;
	return kindScore + uniqueChanges.length * 12 + nameBonus + highSignalBonus;
}

function buildCommandCandidates(
	added: SurfaceChange[],
	removed: SurfaceChange[],
	countChanged: SurfaceChange[],
): CommandCandidate[] {
	return [
		...buildCommandCandidatesForSide("added", added, countChanged),
		...buildCommandCandidatesForSide("removed", removed, countChanged),
	];
}

function buildCommandCandidatesForSide(
	change: "added" | "removed",
	changes: SurfaceChange[],
	countChanged: SurfaceChange[],
): CommandCandidate[] {
	const commands = changes.filter(isCommandSurface);
	return commands.map((commandChange) => {
		const line = commandChange.contexts[0]?.line ?? null;
		const nearby = line
			? changes.filter((candidate) => isNearLine(candidate, line, 24))
			: [];
		const nearbyCountChanges = line
			? countChanged.filter((candidate) => isNearLine(candidate, line, 120))
			: [];
		return {
			command: stripObjectLabelKey(commandChange.value),
			change,
			confidence: commandChange.kind === "object-label" ? "high" : "medium",
			line,
			descriptions: nearby
				.filter(
					(candidate) => objectLabelKey(candidate.value) === "description",
				)
				.map((candidate) => stripObjectLabelKey(candidate.value))
				.slice(0, 4),
			flags: [...nearby, ...nearbyCountChanges]
				.filter((candidate) => candidate.kind === "cli-flag")
				.map((candidate) => candidate.value)
				.slice(0, 8),
			prompts: nearby
				.filter(
					(candidate) =>
						candidate.kind === "user-message" || candidate.kind === "template",
				)
				.map((candidate) => candidate.value)
				.slice(0, 8),
		};
	});
}

function isNearLine(
	change: SurfaceChange,
	line: number,
	distance: number,
): boolean {
	return change.contexts.some(
		(context) =>
			context.line !== null && Math.abs(context.line - line) <= distance,
	);
}

export function buildPatchRelevance(
	added: SurfaceChange[],
	removed: SurfaceChange[],
	countChanged: SurfaceChange[],
	rewrites: RewriteCandidate[],
	patchesDir: string = path.join(SOURCE_DIR, "patches"),
): PatchRelevance[] {
	if (!fs.existsSync(patchesDir)) return [];

	const files = fs
		.readdirSync(patchesDir)
		.filter((file) => file.endsWith(".ts"))
		.filter((file) => !file.endsWith(".test.ts"))
		.filter((file) => !["index.ts", "ast-helpers.ts"].includes(file));

	return files
		.map((file) => {
			const tag = path.basename(file, ".ts");
			const anchors = extractPatchAnchors(path.join(patchesDir, file));
			const directRemoved = findPatchAnchorHits(anchors, removed)
				.filter((hit) => !patchAnchorStillExists(hit.anchor, added))
				.slice(0, 8);
			const countHits = findPatchAnchorHits(anchors, countChanged).slice(0, 6);
			const rewriteHits = findPatchRewriteHits(anchors, rewrites).slice(0, 6);
			const confidence = getPatchRelevanceConfidence(
				directRemoved,
				rewriteHits,
				countHits,
			);
			return {
				tag,
				confidence,
				directRemoved,
				rewrites: rewriteHits,
				countChanged: countHits,
			};
		})
		.filter(
			(result) =>
				result.confidence !== "none" ||
				result.directRemoved.length > 0 ||
				result.rewrites.length > 0 ||
				result.countChanged.length > 0,
		)
		.sort(
			(a, b) =>
				patchConfidenceRank(b.confidence) - patchConfidenceRank(a.confidence),
		);
}

export function extractPatchAnchors(file: string): string[] {
	const source = fs.readFileSync(file, "utf-8");
	const anchors = new Set<string>();
	let ast: t.File;
	try {
		ast = parser.parse(source, {
			sourceType: "module",
			plugins: ["typescript"],
			tokens: false,
		});
	} catch {
		return [];
	}

	const consider = (raw: string) => {
		const value = raw.replace(/\s+/g, " ").trim();
		if (!isUsefulPatchAnchor(value)) return;
		anchors.add(normalizeSurfaceValue(value, false) ?? value);
	};

	traverse(ast, {
		StringLiteral(nodePath: any) {
			if (isPatchDiagnosticLiteral(nodePath)) return;
			consider(nodePath.node.value);
		},
		TemplateLiteral(nodePath: any) {
			if (isPatchDiagnosticLiteral(nodePath)) return;
			consider(templateShape(nodePath.node));
			for (const quasi of nodePath.node.quasis) {
				consider(quasi.value.cooked ?? quasi.value.raw);
			}
		},
	});

	return [...anchors].sort((a, b) => b.length - a.length).slice(0, 120);
}

function isPatchDiagnosticLiteral(nodePath: any): boolean {
	if (nodePath.parentPath?.isReturnStatement?.()) return true;

	const callPath = nodePath.findParent?.((parent: any) =>
		parent.isCallExpression?.(),
	);
	if (!callPath) return false;
	const callee = callPath.node.callee;
	if (!t.isMemberExpression(callee) || callee.computed) return false;
	if (!t.isIdentifier(callee.object, { name: "console" })) return false;
	const propertyName = t.isIdentifier(callee.property)
		? callee.property.name
		: t.isStringLiteral(callee.property)
			? callee.property.value
			: null;
	return propertyName === "warn" || propertyName === "error";
}

function isUsefulPatchAnchor(value: string): boolean {
	if (value.length < 6 || value.length > 220) return false;
	if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) return false;
	if (/^[./\w-]+\.ts$/.test(value)) return false;
	if (value.includes("node:") || value.includes("@babel/")) return false;
	return /[A-Za-z]/.test(value);
}

function findPatchAnchorHits(
	anchors: string[],
	changes: SurfaceChange[],
): PatchAnchorHit[] {
	const hits: PatchAnchorHit[] = [];
	for (const anchor of anchors) {
		const normalizedAnchor = normalizeForPatchMatch(anchor);
		for (const change of changes) {
			if (surfaceMatchesPatchAnchor(change.value, normalizedAnchor)) {
				hits.push({ anchor, change });
				break;
			}
		}
	}
	return hits;
}

function findPatchRewriteHits(
	anchors: string[],
	rewrites: RewriteCandidate[],
): PatchRewriteHit[] {
	const hits: PatchRewriteHit[] = [];
	for (const anchor of anchors) {
		const normalizedAnchor = normalizeForPatchMatch(anchor);
		for (const rewrite of rewrites) {
			if (
				surfaceMatchesPatchAnchor(rewrite.oldChange.value, normalizedAnchor) &&
				!surfaceMatchesPatchAnchor(rewrite.newChange.value, normalizedAnchor)
			) {
				hits.push({ anchor, rewrite });
				break;
			}
		}
	}
	return hits;
}

function patchAnchorStillExists(
	anchor: string,
	added: SurfaceChange[],
): boolean {
	const normalizedAnchor = normalizeForPatchMatch(anchor);
	return added.some((change) =>
		surfaceMatchesPatchAnchor(change.value, normalizedAnchor),
	);
}

function surfaceMatchesPatchAnchor(
	value: string,
	normalizedAnchor: string,
): boolean {
	const normalizedValue = normalizeForPatchMatch(value);
	if (
		normalizedAnchor.length >= 18 &&
		normalizedValue.includes(normalizedAnchor)
	) {
		return true;
	}
	return (
		normalizedAnchor.includes(normalizedValue) && normalizedValue.length >= 18
	);
}

function normalizeForPatchMatch(value: string): string {
	return (
		normalizeSurfaceValue(value, false)
			?.toLowerCase()
			.replace(/\s+/g, " ")
			.trim() ?? ""
	);
}

function getPatchRelevanceConfidence(
	directRemoved: PatchAnchorHit[],
	rewrites: PatchRewriteHit[],
	countChanged: PatchAnchorHit[],
): PatchRelevance["confidence"] {
	if (directRemoved.length >= 2 || rewrites.length >= 2) return "high";
	if (directRemoved.length === 1 || rewrites.length === 1) return "medium";
	if (countChanged.length > 0) return "review";
	return "none";
}

function patchConfidenceRank(confidence: PatchRelevance["confidence"]): number {
	if (confidence === "high") return 3;
	if (confidence === "medium") return 2;
	if (confidence === "review") return 1;
	return 0;
}

function buildPromptExportCheck(
	promptExportDir: string,
	added: SurfaceChange[],
): PromptExportCheck {
	const resolvedDir = path.resolve(promptExportDir);
	if (!fs.existsSync(resolvedDir)) {
		return {
			dir: resolvedDir,
			filesScanned: 0,
			error: "Prompt export directory does not exist",
			bundleOnlyPromptLike: [],
		};
	}

	const files = listPromptExportFiles(resolvedDir);
	const corpus = files
		.map((file) => fs.readFileSync(file, "utf-8").toLowerCase())
		.join("\n");
	const bundleOnlyPromptLike = added
		.filter(isPromptLikeSurface)
		.filter((change) => !promptCorpusContains(corpus, change.value))
		.slice(0, 80);
	return {
		dir: resolvedDir,
		filesScanned: files.length,
		bundleOnlyPromptLike,
	};
}

function listPromptExportFiles(dir: string): string[] {
	const result: string[] = [];
	const stack = [dir];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const fullPath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(fullPath);
				continue;
			}
			if (/\.(md|txt|json)$/i.test(entry.name)) result.push(fullPath);
		}
	}
	return result;
}

function isPromptLikeSurface(change: SurfaceChange): boolean {
	return (
		change.kind === "template" ||
		change.kind === "user-message" ||
		change.kind === "system-reminder" ||
		(change.kind === "object-label" &&
			objectLabelKey(change.value) === "description")
	);
}

function promptCorpusContains(corpus: string, value: string): boolean {
	const normalized = stripObjectLabelKey(value)
		.replace(/\$\{\}/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
	if (normalized.length < 16) return true;
	return corpus.includes(normalized.slice(0, Math.min(normalized.length, 120)));
}

function dedupeChanges(changes: SurfaceChange[]): SurfaceChange[] {
	const seen = new Set<string>();
	const result: SurfaceChange[] = [];
	for (const change of changes) {
		const key = surfaceIdentity(change);
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(change);
	}
	return result;
}

function surfaceIdentity(change: SurfaceChange): string {
	return `${change.kind}\0${change.value}`;
}

function rewriteIdentity(change: SurfaceChange): string {
	return normalizeForSimilarity(change.value);
}

function tokenizeSurface(value: string): string[] {
	return stripObjectLabelKey(value)
		.replace(/\$\{\}/g, " placeholder ")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/g)
		.filter(Boolean);
}

function normalizeForSimilarity(value: string): string {
	return stripObjectLabelKey(value)
		.toLowerCase()
		.replace(/\[[^\]]+\]/g, "[prefix]")
		.replace(/\$\{\}/g, "${}")
		.replace(/\b\d+\b/g, "<number>")
		.replace(/\s+/g, " ")
		.trim();
}

function normalizedEditSimilarity(a: string, b: string): number {
	const maxLength = Math.max(a.length, b.length);
	if (maxLength === 0) return 1;
	const distance = levenshteinDistance(a, b, 180);
	return Math.max(0, 1 - distance / maxLength);
}

function levenshteinDistance(
	a: string,
	b: string,
	maxInputLength: number,
): number {
	const left = a.slice(0, maxInputLength);
	const right = b.slice(0, maxInputLength);
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	let current = new Array<number>(right.length + 1);

	for (let i = 1; i <= left.length; i++) {
		current[0] = i;
		for (let j = 1; j <= right.length; j++) {
			const substitutionCost = left[i - 1] === right[j - 1] ? 0 : 1;
			current[j] = Math.min(
				previous[j] + 1,
				current[j - 1] + 1,
				previous[j - 1] + substitutionCost,
			);
		}
		[previous, current] = [current, previous];
	}

	return (
		previous[right.length] +
		Math.abs(a.length - left.length) +
		Math.abs(b.length - right.length)
	);
}

async function runBundleDiff(argv: any) {
	const oldPath = path.resolve(String(argv.old));
	const newPath = path.resolve(String(argv.new));
	const limit = Number(argv.limit ?? 20);
	const options = buildBundleDiffOptions(argv);
	const focus = parseFocusMode(argv.focus);

	const oldFacts = extractBundleFacts(oldPath, options);
	const newFacts = extractBundleFacts(newPath, options);
	const report = buildBundleDiffReport(
		oldFacts,
		newFacts,
		options,
		argv.promptExport ? String(argv.promptExport) : undefined,
	);

	if (argv.json) {
		console.log(JSON.stringify(sliceBundleDiffReport(report, limit), null, 2));
		return;
	}

	if (argv.markdown) {
		console.log(renderBundleDiffMarkdown(report, limit, focus));
		return;
	}

	printBundleDiffReport(report, limit, focus);
}

async function runMatrixDiff(argv: any) {
	const bundles = ((argv.bundles as string[]) ?? []).map((bundle) =>
		path.resolve(String(bundle)),
	);
	if (bundles.length < 2) {
		throw new Error("matrix requires at least two bundle paths");
	}

	const limit = Number(argv.limit ?? 20);
	const options = buildBundleDiffOptions(argv);
	const facts = bundles.map((bundle) => extractBundleFacts(bundle, options));
	const pairs: BundleDiffReport[] = [];
	for (let i = 1; i < facts.length; i++) {
		pairs.push(buildBundleDiffReport(facts[i - 1], facts[i], options));
	}
	const report = buildMatrixDiffReport(facts, pairs);

	if (argv.json) {
		console.log(JSON.stringify(sliceMatrixDiffReport(report, limit), null, 2));
		return;
	}
	if (argv.markdown) {
		console.log(renderMatrixDiffMarkdown(report, limit));
		return;
	}
	printMatrixDiffReport(report, limit);
}

function buildBundleDiffOptions(argv: any): BundleDiffOptions {
	return {
		includeBuildMetadata: Boolean(argv.includeBuildMetadata),
		minLength: Number(argv.minLength ?? 3),
		contextLimit: 3,
		cache: Boolean(argv.cache),
		cacheDir: path.resolve(String(argv.cacheDir ?? DEFAULT_CACHE_DIR)),
		config: loadDiffConfig(argv.config ? String(argv.config) : undefined),
	};
}

function parseFocusMode(raw: unknown): FocusMode {
	const value = String(raw ?? "all");
	if (FOCUS_MODES.includes(value as FocusMode)) return value as FocusMode;
	return "all";
}

function buildMatrixDiffReport(
	facts: BundleFacts[],
	pairs: BundleDiffReport[],
): MatrixDiffReport {
	const earlierAdded = new Set<string>();
	for (const pair of pairs.slice(0, -1)) {
		for (const change of pair.added) earlierAdded.add(surfaceIdentity(change));
	}
	const latestPair = pairs.at(-1);
	const latestOnlyAdditions =
		latestPair?.added.filter(
			(change) => !earlierAdded.has(surfaceIdentity(change)),
		) ?? [];
	return {
		bundles: facts.map((fact) => fact.metadata),
		pairs,
		latestOnlyAdditions,
	};
}

function sliceMatrixDiffReport(
	report: MatrixDiffReport,
	limit: number,
): MatrixDiffReport {
	return {
		bundles: report.bundles,
		pairs: report.pairs.map((pair) => sliceBundleDiffReport(pair, limit)),
		latestOnlyAdditions: report.latestOnlyAdditions.slice(0, limit),
	};
}

function printMatrixDiffReport(report: MatrixDiffReport, limit: number): void {
	console.log(chalk.blue("Bundle diff matrix"));
	for (const pair of report.pairs) {
		console.log(
			`${path.basename(path.dirname(pair.old.file)) || path.basename(pair.old.file)} -> ${path.basename(path.dirname(pair.new.file)) || path.basename(pair.new.file)}: ` +
				`added ${chalk.green(String(pair.totals.added))}, removed ${chalk.red(String(pair.totals.removed))}, rewrites ${chalk.yellow(String(pair.rewriteCandidates.length))}`,
		);
		const commands = pair.commandCandidates
			.slice(0, 4)
			.map(
				(candidate) =>
					`${candidate.change === "added" ? "+" : "-"}${candidate.command}`,
			);
		if (commands.length > 0) console.log(`  commands: ${commands.join(", ")}`);
		const env = [
			...pair.sections.env.added.map((change) => `+${change.value}`),
			...pair.sections.env.removed.map((change) => `-${change.value}`),
		].slice(0, 6);
		if (env.length > 0) console.log(`  env: ${env.join(", ")}`);
		const settings = [
			...pair.sections.settings.added.map((change) => `+${change.value}`),
			...pair.sections.settings.removed.map((change) => `-${change.value}`),
			...pair.sections.settings.countChanged.map(
				(change) => `~${change.value} ${formatDelta(change.delta)}`,
			),
		].slice(0, 6);
		if (settings.length > 0) console.log(`  settings: ${settings.join(", ")}`);
	}

	if (report.latestOnlyAdditions.length > 0) {
		console.log();
		console.log(chalk.bold("Latest-only additions"));
		for (const change of report.latestOnlyAdditions.slice(0, limit)) {
			console.log(
				`  + [${change.kind}] ${truncateForDisplay(change.value, 120)}`,
			);
		}
	}
}

function renderMatrixDiffMarkdown(
	report: MatrixDiffReport,
	limit: number,
): string {
	const lines = ["# Bundle Diff Matrix", ""];
	for (const pair of report.pairs) {
		lines.push(
			`## ${path.basename(path.dirname(pair.old.file)) || path.basename(pair.old.file)} -> ${path.basename(path.dirname(pair.new.file)) || path.basename(pair.new.file)}`,
			"",
			`- Added: ${pair.totals.added}`,
			`- Removed: ${pair.totals.removed}`,
			`- Count changed: ${pair.totals.countChanged}`,
			`- Rewrite candidates: ${pair.rewriteCandidates.length}`,
			"",
		);
	}
	if (report.latestOnlyAdditions.length > 0) {
		lines.push("## Latest-Only Additions", "");
		for (const change of report.latestOnlyAdditions.slice(0, limit)) {
			lines.push(`- \`${change.kind}\` ${escapeMarkdownInline(change.value)}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

function renderBundleDiffMarkdown(
	report: BundleDiffReport,
	limit: number,
	focus: FocusMode,
): string {
	const lines = [
		"# Bundle Surface Diff",
		"",
		`- Old: \`${report.old.file}\``,
		`- New: \`${report.new.file}\``,
		`- Added: ${report.totals.added}`,
		`- Removed: ${report.totals.removed}`,
		`- Count changed: ${report.totals.countChanged}`,
		"",
	];

	if (focus === "all" || focus === "commands") {
		appendMarkdownCommandCandidates(lines, report.commandCandidates, limit);
		appendMarkdownSection(
			lines,
			"Flags",
			[
				...report.sections.flags.added,
				...report.sections.flags.removed,
				...report.sections.flags.countChanged,
			],
			limit,
		);
	}
	if (focus === "all" || focus === "inventory") {
		appendMarkdownInventory(lines, report.inventory, limit);
	}
	if (focus === "all" || focus === "release") {
		appendMarkdownReleaseSummary(lines, report.releaseSummary, limit);
	}
	if (focus === "all" || focus === "env") {
		appendMarkdownSection(
			lines,
			"Environment Variables",
			[
				...report.sections.env.added,
				...report.sections.env.removed,
				...report.sections.env.countChanged,
			],
			limit,
		);
		appendMarkdownSection(
			lines,
			"Routes / Endpoints",
			[
				...report.sections.routes.added,
				...report.sections.routes.removed,
				...report.sections.routes.countChanged,
			],
			limit,
		);
	}
	if (focus === "all" || focus === "env" || focus === "settings") {
		appendMarkdownSection(
			lines,
			"Settings Writes",
			[
				...report.sections.settings.added,
				...report.sections.settings.removed,
				...report.sections.settings.countChanged,
			],
			limit,
		);
	}
	if (focus === "all" || focus === "rewrites") {
		appendMarkdownPrefixRewrites(lines, report.prefixRewrites, limit);
		appendMarkdownRewrites(lines, report.rewriteCandidates, limit);
	}
	if (focus === "all" || focus === "removals") {
		appendMarkdownClusters(
			lines,
			"Potential Removed Feature Clusters",
			report.removedClusters,
			limit,
		);
		appendMarkdownSection(lines, "High-Signal Removals", report.removed, limit);
	}
	if (focus === "all" || focus === "prompts") {
		appendMarkdownSection(
			lines,
			"System Reminders",
			[
				...report.sections.reminders.added,
				...report.sections.reminders.removed,
				...report.sections.reminders.countChanged,
			],
			limit,
		);
		appendMarkdownSection(
			lines,
			"Prompt / Text Surfaces",
			[
				...report.sections.messages.added,
				...report.sections.messages.removed,
				...report.sections.messages.countChanged,
			],
			limit,
		);
		appendMarkdownPromptExport(lines, report.promptExport, limit);
	}
	if (focus === "all" || focus === "patches") {
		appendMarkdownPatchRelevance(lines, report.patchRelevance, limit);
	}
	if (focus === "all") {
		appendMarkdownClusters(
			lines,
			"Potential Added Feature Clusters",
			report.addedClusters,
			limit,
		);
		appendMarkdownSection(lines, "High-Signal Additions", report.added, limit);
	}

	return lines.join("\n");
}

function appendMarkdownSection(
	lines: string[],
	title: string,
	changes: SurfaceChange[],
	limit: number,
): void {
	if (changes.length === 0) return;
	lines.push(`## ${title}`, "");
	for (const change of changes.slice(0, limit)) {
		const prefix = change.delta > 0 ? "+" : change.delta < 0 ? "-" : "~";
		lines.push(
			`- ${prefix} \`${change.kind}\` ${escapeMarkdownInline(change.value)}`,
		);
	}
	lines.push("");
}

function appendMarkdownCommandCandidates(
	lines: string[],
	commands: CommandCandidate[],
	limit: number,
): void {
	if (commands.length === 0) return;
	lines.push("## Command Candidates", "");
	for (const command of commands.slice(0, limit)) {
		const prefix = command.change === "added" ? "+" : "-";
		lines.push(
			`- ${prefix} \`${command.command}\` (${command.confidence}${command.line ? `, line ${command.line}` : ""})`,
		);
		for (const description of command.descriptions.slice(0, 2)) {
			lines.push(`  - description: ${escapeMarkdownInline(description)}`);
		}
		if (command.flags.length > 0) {
			lines.push(
				`  - flags: ${command.flags.map((flag) => `\`${flag}\``).join(", ")}`,
			);
		}
	}
	lines.push("");
}

function appendMarkdownInventory(
	lines: string[],
	inventory: InventoryDiff,
	limit: number,
): void {
	const changes = [
		...inventory.added,
		...inventory.removed,
		...inventory.countChanged,
	];
	if (changes.length === 0) return;
	lines.push("## Semantic Inventory", "");
	for (const kind of INVENTORY_KINDS) {
		const kindChanges = changes.filter((change) => change.kind === kind);
		if (kindChanges.length === 0) continue;
		lines.push(`### ${INVENTORY_TITLES[kind]}`, "");
		for (const change of kindChanges.slice(0, limit)) {
			const prefix = change.delta > 0 ? "+" : change.delta < 0 ? "-" : "~";
			const line = change.contexts[0]?.line
				? `, line ${change.contexts[0].line}`
				: "";
			lines.push(
				`- ${prefix} ${escapeMarkdownInline(change.value)} (${formatDelta(change.delta)}${line})`,
			);
		}
		lines.push("");
	}
}

function appendMarkdownReleaseSummary(
	lines: string[],
	summary: ReleaseSummary,
	limit: number,
): void {
	if (!releaseSummaryHasItems(summary)) return;
	lines.push("## Release Summary", "");
	for (const section of RELEASE_SUMMARY_KEYS) {
		const items = summary[section];
		if (items.length === 0) continue;
		lines.push(`### ${RELEASE_SUMMARY_TITLES[section]}`, "");
		for (const item of items.slice(0, limit)) {
			const linesText =
				item.lines.length > 0 ? `, lines ${item.lines.join(", ")}` : "";
			lines.push(
				`- **${escapeMarkdownInline(item.title)}** (${item.confidence}${linesText})`,
			);
			for (const evidence of item.evidence.slice(0, 3)) {
				lines.push(`  - ${escapeMarkdownInline(evidence)}`);
			}
		}
		lines.push("");
	}
}

function appendMarkdownPrefixRewrites(
	lines: string[],
	rewrites: PrefixRewrite[],
	limit: number,
): void {
	if (rewrites.length === 0) return;
	lines.push("## Likely Prefix Rewrites", "");
	for (const rewrite of rewrites.slice(0, limit)) {
		lines.push(
			`- \`[${rewrite.oldPrefix}]\` -> \`[${rewrite.newPrefix}]\` (${rewrite.matches} matched surfaces, score ${rewrite.score.toFixed(2)})`,
		);
	}
	lines.push("");
}

function appendMarkdownRewrites(
	lines: string[],
	rewrites: RewriteCandidate[],
	limit: number,
): void {
	if (rewrites.length === 0) return;
	lines.push("## Likely Text Rewrites", "");
	for (const rewrite of rewrites.slice(0, limit)) {
		lines.push(
			`- score ${rewrite.score.toFixed(2)}: ${escapeMarkdownInline(rewrite.oldChange.value)} -> ${escapeMarkdownInline(rewrite.newChange.value)}`,
		);
	}
	lines.push("");
}

function appendMarkdownClusters(
	lines: string[],
	title: string,
	clusters: SurfaceCluster[],
	limit: number,
): void {
	if (clusters.length === 0) return;
	lines.push(`## ${title}`, "");
	for (const cluster of clusters.slice(0, limit)) {
		lines.push(`- lines ${cluster.lineStart}-${cluster.lineEnd}`);
		for (const change of cluster.changes.slice(0, 4)) {
			lines.push(
				`  - \`${change.kind}\` ${escapeMarkdownInline(change.value)}`,
			);
		}
	}
	lines.push("");
}

function appendMarkdownPatchRelevance(
	lines: string[],
	relevance: PatchRelevance[],
	limit: number,
): void {
	if (relevance.length === 0) return;
	lines.push("## Patch Relevance", "");
	for (const patch of relevance.slice(0, limit)) {
		lines.push(`- \`${patch.tag}\`: ${patch.confidence}`);
		for (const hit of patch.directRemoved.slice(0, 2)) {
			lines.push(`  - removed: ${escapeMarkdownInline(hit.anchor)}`);
		}
		for (const hit of patch.rewrites.slice(0, 2)) {
			lines.push(`  - rewrite: ${escapeMarkdownInline(hit.anchor)}`);
		}
	}
	lines.push("");
}

function appendMarkdownPromptExport(
	lines: string[],
	check: PromptExportCheck | undefined,
	limit: number,
): void {
	if (!check) return;
	lines.push("## Prompt Export Cross-Check", "");
	if (check.error) {
		lines.push(`- ${check.error}: \`${check.dir}\``, "");
		return;
	}
	lines.push(`- Scanned files: ${check.filesScanned}`);
	for (const change of check.bundleOnlyPromptLike.slice(0, limit)) {
		lines.push(`- ${escapeMarkdownInline(change.value)}`);
	}
	lines.push("");
}

function escapeMarkdownInline(value: string): string {
	return truncateForDisplay(value, 180).replace(/`/g, "\\`");
}

function sliceBundleDiffReport(
	report: BundleDiffReport,
	limit: number,
): BundleDiffReport {
	return {
		...report,
		added: report.added.slice(0, limit),
		removed: report.removed.slice(0, limit),
		countChanged: report.countChanged.slice(0, limit),
		sections: sliceSurfaceSections(report.sections, limit),
		addedClusters: report.addedClusters.slice(0, limit),
		removedClusters: report.removedClusters.slice(0, limit),
		clusters: report.clusters.slice(0, limit),
		prefixRewrites: report.prefixRewrites.slice(0, limit),
		rewriteCandidates: report.rewriteCandidates.slice(0, limit),
		addedCapabilities: report.addedCapabilities.slice(0, limit),
		removedCapabilities: report.removedCapabilities.slice(0, limit),
		commandCandidates: report.commandCandidates.slice(0, limit),
		inventory: sliceInventoryDiff(report.inventory, limit),
		releaseSummary: sliceReleaseSummary(report.releaseSummary, limit),
		patchRelevance: report.patchRelevance.slice(0, limit),
		promptExport: report.promptExport
			? {
					...report.promptExport,
					bundleOnlyPromptLike: report.promptExport.bundleOnlyPromptLike.slice(
						0,
						limit,
					),
				}
			: undefined,
	};
}

function sliceInventoryDiff(
	inventory: InventoryDiff,
	limit: number,
): InventoryDiff {
	return {
		added: inventory.added.slice(0, limit),
		removed: inventory.removed.slice(0, limit),
		countChanged: inventory.countChanged.slice(0, limit),
	};
}

function sliceReleaseSummary(
	summary: ReleaseSummary,
	limit: number,
): ReleaseSummary {
	return Object.fromEntries(
		RELEASE_SUMMARY_KEYS.map((section) => [
			section,
			summary[section].slice(0, limit).map((item) => ({
				...item,
				evidence: item.evidence.slice(0, Math.min(limit, 3)),
				lines: item.lines.slice(0, Math.min(limit, 10)),
			})),
		]),
	) as ReleaseSummary;
}

function printBundleDiffReport(
	report: BundleDiffReport,
	limit: number,
	focus: FocusMode = "all",
): void {
	console.log(chalk.blue("Bundle surface diff"));
	console.log(`${formatBundle(report.old)} -> ${formatBundle(report.new)}`);
	console.log();
	console.log(chalk.bold("Metadata"));
	printMetadataPair(
		"comment version",
		report.old.commentVersions,
		report.new.commentVersions,
	);
	printMetadataPair(
		"embedded version",
		report.old.embeddedVersions,
		report.new.embeddedVersions,
	);
	printMetadataPair("build time", report.old.buildTimes, report.new.buildTimes);
	printMetadataPair("git sha", report.old.gitShas, report.new.gitShas);
	console.log();

	console.log(chalk.bold("Summary"));
	console.log(
		`unique surfaces: ${report.totals.oldUnique} -> ${report.totals.newUnique}`,
	);
	console.log(
		`added ${chalk.green(String(report.totals.added))}, removed ${chalk.red(String(report.totals.removed))}, count changed ${chalk.yellow(String(report.totals.countChanged))}`,
	);
	printKindCounts("added by kind", report.addedByKind, chalk.green);
	printKindCounts("removed by kind", report.removedByKind, chalk.red);
	console.log();

	if (focus === "all" || focus === "commands") {
		printSurfaceSections(
			report.sections,
			Math.min(limit, 10),
			new Set(["commands", "flags"]),
		);
		printCommandCandidates(report.commandCandidates.slice(0, limit));
	}
	if (focus === "all" || focus === "inventory") {
		printInventoryDiff(report.inventory, limit);
	}
	if (focus === "all" || focus === "release") {
		printReleaseSummary(report.releaseSummary, limit);
	}
	if (focus === "all" || focus === "env") {
		printSurfaceSections(
			report.sections,
			Math.min(limit, 10),
			new Set(["env", "routes", "settings"]),
		);
	}
	if (focus === "settings") {
		printSurfaceSections(
			report.sections,
			Math.min(limit, 10),
			new Set(["settings"]),
		);
	}
	if (focus === "all" || focus === "rewrites") {
		printPrefixRewrites(report.prefixRewrites.slice(0, Math.min(limit, 8)));
		printRewriteCandidates(
			report.rewriteCandidates.slice(0, Math.min(limit, 8)),
		);
	}
	if (focus === "all") {
		printSurfaceSections(
			report.sections,
			Math.min(limit, 10),
			new Set(["labels", "reminders", "messages"]),
		);
		printCapabilities(
			"Added capability candidates",
			report.addedCapabilities.slice(0, Math.min(limit, 8)),
			chalk.green("+"),
		);
		printCapabilities(
			"Removed capability candidates",
			report.removedCapabilities.slice(0, Math.min(limit, 8)),
			chalk.red("-"),
		);
	}
	if (focus === "all" || focus === "removals") {
		printClusters(
			"Potential added feature clusters",
			report.addedClusters.slice(0, Math.min(limit, 8)),
			chalk.green("+"),
		);
		printClusters(
			"Potential removed feature clusters",
			report.removedClusters.slice(0, Math.min(limit, 8)),
			chalk.red("-"),
		);
		printChanges("High-signal removals", report.removed, limit, chalk.red("-"));
	}
	if (focus === "all" || focus === "prompts") {
		if (focus === "prompts") {
			printSurfaceSections(
				report.sections,
				Math.min(limit, 10),
				new Set(["reminders", "messages"]),
			);
		}
		printPromptExportCheck(report.promptExport, limit);
	}
	if (focus === "all" || focus === "patches") {
		printPatchRelevance(report.patchRelevance.slice(0, limit));
	}
	if (focus === "all") {
		printChanges(
			"High-signal additions",
			report.added,
			limit,
			chalk.green("+"),
		);
		printChanges(
			"Count changes",
			report.countChanged,
			Math.min(limit, 12),
			chalk.yellow("~"),
		);
	}
}

function sliceSurfaceSections(
	sections: SurfaceSections,
	limit: number,
): SurfaceSections {
	return Object.fromEntries(
		SURFACE_SECTION_KEYS.map((key) => [
			key,
			{
				added: sections[key].added.slice(0, limit),
				removed: sections[key].removed.slice(0, limit),
				countChanged: sections[key].countChanged.slice(0, limit),
			},
		]),
	) as SurfaceSections;
}

function formatBundle(metadata: BundleMetadata): string {
	const relative = path.relative(process.cwd(), metadata.file);
	const displayPath = relative.startsWith("..") ? metadata.file : relative;
	return `${displayPath} (${formatBytes(metadata.bytes)}, ${metadata.lineCount} lines)`;
}

function formatBytes(bytes: number): string {
	const mib = bytes / (1024 * 1024);
	if (mib >= 1) return `${mib.toFixed(1)} MiB`;
	return `${(bytes / 1024).toFixed(1)} KiB`;
}

function printMetadataPair(
	label: string,
	oldValues: string[],
	newValues: string[],
): void {
	const oldText = oldValues.length ? oldValues.join(", ") : "n/a";
	const newText = newValues.length ? newValues.join(", ") : "n/a";
	if (oldText === newText) {
		console.log(`  ${label}: ${chalk.gray(oldText)}`);
		return;
	}
	console.log(`  ${label}: ${chalk.red(oldText)} -> ${chalk.green(newText)}`);
}

function printKindCounts(
	label: string,
	counts: Record<SurfaceKind, number>,
	color: (text: string) => string,
): void {
	const parts = SURFACE_KINDS.filter((kind) => counts[kind] > 0).map(
		(kind) => `${kind}=${counts[kind]}`,
	);
	if (parts.length === 0) return;
	console.log(`  ${label}: ${color(parts.join(", "))}`);
}

function printSurfaceSections(
	sections: SurfaceSections,
	limit: number,
	onlyKeys?: Set<SurfaceSectionKey>,
): void {
	for (const key of SURFACE_SECTION_KEYS) {
		if (onlyKeys && !onlyKeys.has(key)) continue;
		const section = sections[key];
		const changes = [
			...section.added.slice(0, limit),
			...section.removed.slice(0, limit),
			...section.countChanged.slice(0, Math.max(0, limit - 4)),
		];
		if (changes.length === 0) continue;

		console.log(chalk.bold(SURFACE_SECTION_TITLES[key]));
		printCompactChangeGroup(section.added, limit, chalk.green("+"));
		printCompactChangeGroup(section.removed, limit, chalk.red("-"));
		printCompactChangeGroup(
			section.countChanged,
			Math.max(0, limit - 4),
			chalk.yellow("~"),
		);
		console.log();
	}
}

function printCompactChangeGroup(
	changes: SurfaceChange[],
	limit: number,
	prefix: string,
): void {
	for (const change of changes.slice(0, limit)) {
		const context = change.contexts[0];
		const line = context?.line ? ` line ${context.line}` : "";
		const delta =
			Math.abs(change.delta) === change.count
				? ""
				: ` ${chalk.gray(`count ${formatDelta(change.delta)}`)}`;
		console.log(
			`  ${prefix}${line}${delta} ${truncateForDisplay(stripObjectLabelKey(change.value), 120)}`,
		);
	}
}

function printCommandCandidates(commands: CommandCandidate[]): void {
	if (commands.length === 0) return;

	console.log(chalk.bold("Command candidates"));
	for (const command of commands) {
		const prefix =
			command.change === "added" ? chalk.green("+") : chalk.red("-");
		const line = command.line ? ` line ${command.line}` : "";
		console.log(
			`  ${prefix}${line} ${command.command} ${chalk.gray(`confidence ${command.confidence}`)}`,
		);
		for (const description of command.descriptions.slice(0, 2)) {
			console.log(`    description: ${truncateForDisplay(description, 110)}`);
		}
		if (command.flags.length > 0) {
			console.log(`    flags: ${command.flags.join(", ")}`);
		}
		for (const prompt of command.prompts.slice(0, 3)) {
			console.log(`    prompt: ${truncateForDisplay(prompt, 110)}`);
		}
	}
	console.log();
}

function printInventoryDiff(inventory: InventoryDiff, limit: number): void {
	const changes = [
		...inventory.added,
		...inventory.removed,
		...inventory.countChanged,
	];
	if (changes.length === 0) return;

	console.log(chalk.bold("Semantic inventory"));
	for (const kind of INVENTORY_KINDS) {
		const kindChanges = changes.filter((change) => change.kind === kind);
		if (kindChanges.length === 0) continue;
		console.log(`  ${INVENTORY_TITLES[kind]}`);
		for (const change of kindChanges.slice(0, limit)) {
			const prefix =
				change.delta > 0
					? chalk.green("+")
					: change.delta < 0
						? chalk.red("-")
						: chalk.yellow("~");
			const line = change.contexts[0]?.line
				? ` line ${change.contexts[0].line}`
				: "";
			const delta =
				Math.abs(change.delta) === change.count
					? ""
					: ` ${chalk.gray(`count ${formatDelta(change.delta)}`)}`;
			console.log(
				`    ${prefix}${line}${delta} ${truncateForDisplay(change.value, 120)}`,
			);
		}
	}
	console.log();
}

function printReleaseSummary(summary: ReleaseSummary, limit: number): void {
	if (!releaseSummaryHasItems(summary)) return;

	console.log(chalk.bold("Release summary"));
	for (const section of RELEASE_SUMMARY_KEYS) {
		const items = summary[section];
		if (items.length === 0) continue;
		console.log(`  ${RELEASE_SUMMARY_TITLES[section]}`);
		for (const item of items.slice(0, limit)) {
			const lines =
				item.lines.length > 0
					? chalk.gray(` lines ${item.lines.slice(0, 6).join(", ")}`)
					: "";
			console.log(
				`    ${chalk.cyan("-")} ${item.title} ${chalk.gray(`confidence ${item.confidence}`)}${lines}`,
			);
			for (const evidence of item.evidence.slice(0, 3)) {
				console.log(`      ${truncateForDisplay(evidence, 130)}`);
			}
		}
	}
	console.log();
}

function printPatchRelevance(relevance: PatchRelevance[]): void {
	if (relevance.length === 0) return;

	console.log(chalk.bold("Patch relevance"));
	for (const patch of relevance) {
		console.log(`  ${patch.tag}: ${chalk.gray(patch.confidence)}`);
		for (const hit of patch.directRemoved.slice(0, 3)) {
			console.log(
				`    removed anchor: ${truncateForDisplay(hit.anchor, 95)} -> ${truncateForDisplay(hit.change.value, 95)}`,
			);
		}
		for (const hit of patch.rewrites.slice(0, 3)) {
			console.log(
				`    rewrite anchor: ${truncateForDisplay(hit.anchor, 95)} -> ${truncateForDisplay(hit.rewrite.newChange.value, 95)}`,
			);
		}
		for (const hit of patch.countChanged.slice(0, 2)) {
			console.log(
				`    count changed: ${truncateForDisplay(hit.anchor, 95)} -> ${truncateForDisplay(hit.change.value, 95)}`,
			);
		}
	}
	console.log();
}

function printPromptExportCheck(
	check: PromptExportCheck | undefined,
	limit: number,
): void {
	if (!check) return;

	console.log(chalk.bold("Prompt export cross-check"));
	if (check.error) {
		console.log(`  ${chalk.red(check.error)}: ${check.dir}`);
		console.log();
		return;
	}
	console.log(`  scanned ${check.filesScanned} prompt artifact file(s)`);
	for (const change of check.bundleOnlyPromptLike.slice(0, limit)) {
		const line = change.contexts[0]?.line
			? ` line ${change.contexts[0]?.line}`
			: "";
		console.log(
			`  ${chalk.yellow("!")} ${line} ${truncateForDisplay(change.value, 130)}`,
		);
	}
	console.log();
}

function printPrefixRewrites(rewrites: PrefixRewrite[]): void {
	if (rewrites.length === 0) return;

	console.log(chalk.bold("Likely prefix rewrites"));
	for (const rewrite of rewrites) {
		console.log(
			`  ${chalk.red(`[${rewrite.oldPrefix}]`)} -> ${chalk.green(`[${rewrite.newPrefix}]`)} ${chalk.gray(`${rewrite.matches} matched surfaces, score ${rewrite.score.toFixed(2)}`)}`,
		);
		for (const sample of rewrite.samples.slice(0, 2)) {
			console.log(
				`    ${chalk.red("-")} ${truncateForDisplay(sample.oldChange.value, 95)}`,
			);
			console.log(
				`    ${chalk.green("+")} ${truncateForDisplay(sample.newChange.value, 95)}`,
			);
		}
	}
	console.log();
}

function printRewriteCandidates(candidates: RewriteCandidate[]): void {
	if (candidates.length === 0) return;

	console.log(chalk.bold("Likely text rewrites"));
	for (const candidate of candidates) {
		const oldLine = candidate.oldChange.contexts[0]?.line;
		const newLine = candidate.newChange.contexts[0]?.line;
		const lineText =
			oldLine || newLine
				? chalk.gray(` lines ${oldLine ?? "?"} -> ${newLine ?? "?"}`)
				: "";
		console.log(
			`  ${chalk.gray(`score ${candidate.score.toFixed(2)}`)}${lineText}`,
		);
		console.log(
			`    ${chalk.red("-")} ${truncateForDisplay(candidate.oldChange.value, 115)}`,
		);
		console.log(
			`    ${chalk.green("+")} ${truncateForDisplay(candidate.newChange.value, 115)}`,
		);
	}
	console.log();
}

function printCapabilities(
	title: string,
	candidates: CapabilityCandidate[],
	prefix: string,
): void {
	if (candidates.length === 0) return;

	console.log(chalk.bold(title));
	for (const candidate of candidates) {
		console.log(
			`  ${prefix} ${candidate.token} ${chalk.gray(`${candidate.changes.length} surfaces, score ${candidate.score}`)}`,
		);
		for (const change of candidate.changes.slice(0, 3)) {
			console.log(
				`    ${truncateForDisplay(stripObjectLabelKey(change.value), 110)}`,
			);
		}
	}
	console.log();
}

function printClusters(
	title: string,
	clusters: SurfaceCluster[],
	prefix: string,
): void {
	if (clusters.length === 0) return;

	console.log(chalk.bold(title));
	for (const cluster of clusters) {
		const lineRange =
			cluster.lineStart === cluster.lineEnd
				? `line ${cluster.lineStart}`
				: `lines ${cluster.lineStart}-${cluster.lineEnd}`;
		console.log(`  ${chalk.cyan(lineRange)}`);
		for (const change of cluster.changes.slice(0, 5)) {
			console.log(
				`    ${prefix} [${change.kind}] ${truncateForDisplay(change.value, 110)}`,
			);
		}
	}
	console.log();
}

function printChanges(
	title: string,
	changes: SurfaceChange[],
	limit: number,
	prefix: string,
): void {
	if (changes.length === 0) return;

	console.log(chalk.bold(title));
	for (const change of changes.slice(0, limit)) {
		const context = change.contexts[0];
		const line = context?.line ? ` line ${context.line}` : "";
		const labels = context?.objectLabels.length
			? ` ${chalk.gray(`(${context.objectLabels.join(", ")})`)}`
			: "";
		const delta =
			change.delta === 0
				? ""
				: ` ${chalk.gray(`count ${formatDelta(change.delta)}`)}`;
		console.log(
			`  ${prefix} [${change.kind}]${line}${delta} ${truncateForDisplay(change.value, 140)}${labels}`,
		);
	}
	console.log();
}

function formatDelta(value: number): string {
	if (value > 0) return `+${value}`;
	return String(value);
}

function truncateForDisplay(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function generateBreadcrumbs(nodePath: any): string {
	const parts = [];
	let current = nodePath.parentPath;
	while (current) {
		const node = current.node;
		let name = node.type;
		if (t.isFunction(node)) {
			const id = "id" in node ? (node as any).id : null;
			name = `Function(${id?.name || "anon"})`;
		} else if (t.isVariableDeclarator(node) && t.isIdentifier(node.id)) {
			name = `Var(${node.id.name})`;
		} else if (t.isObjectProperty(node) && t.isIdentifier(node.key)) {
			name = `Prop(${node.key.name})`;
		} else if (t.isClassDeclaration(node)) name = `Class(${node.id?.name})`;
		parts.unshift(name);
		current = current.parentPath;
	}
	return parts.slice(-4).join(" > ");
}

function getNodeSignature(node: any): string {
	if (t.isFunctionDeclaration(node))
		return `FunctionDeclaration:${node.id?.name}`;
	if (t.isVariableDeclarator(node) && t.isIdentifier(node.id))
		return `VariableDeclarator:${node.id.name}`;
	if (t.isClassDeclaration(node)) return `ClassDeclaration:${node.id?.name}`;
	if (t.isObjectProperty(node) && t.isIdentifier(node.key))
		return `ObjectProperty:${node.key.name}`;
	return node.type;
}

async function runAstDiff(argv: any) {
	const { original, patched } = argv;

	console.log(chalk.blue(`Comparing ${original} -> ${patched}...`));

	const file1 = parseFile(original);
	const file2 = parseFile(patched);

	const map1 = new Map<string, string>();
	const map2 = new Map<string, string>();

	const collect = (ast: any, map: Map<string, string>) => {
		traverse(ast, {
			enter(nodePath: any) {
				const node = nodePath.node;
				if (
					t.isFunctionDeclaration(node) ||
					t.isVariableDeclarator(node) ||
					(t.isObjectProperty(node) && t.isIdentifier(node.key))
				) {
					const sig = getNodeSignature(node);
					const code = generator(node, { minified: true }).code;
					const breadcrumb = generateBreadcrumbs(nodePath);
					const fullSig = `${breadcrumb} > ${sig}`;
					if (!map.has(fullSig)) map.set(fullSig, code);
				}
			},
		});
	};

	console.log(chalk.gray("Scanning structure..."));
	collect(file1.ast, map1);
	collect(file2.ast, map2);

	let changes = 0;

	for (const [sig, code2] of map2.entries()) {
		const code1 = map1.get(sig);
		if (code1 === undefined || code1 === code2) continue;

		changes++;
		console.log(chalk.yellow("-".repeat(60)));
		console.log(chalk.green(`CHANGED: ${sig}`));

		let pretty1 = code1;
		let pretty2 = code2;
		try {
			pretty1 = generator(parse(code1).program.body[0], {
				minified: false,
			}).code;
			pretty2 = generator(parse(code2).program.body[0], {
				minified: false,
			}).code;
		} catch {}

		const diff = Diff.diffLines(pretty1, pretty2);
		diff.forEach((part) => {
			const color = part.added
				? chalk.green
				: part.removed
					? chalk.red
					: chalk.gray;
			if (part.added || part.removed) {
				process.stdout.write(color(part.value.replace(/^/gm, "  ")));
			}
		});
		console.log("\n");
	}

	if (changes === 0) {
		console.log(
			chalk.gray("No structural changes detected in identified nodes."),
		);
	} else {
		console.log(chalk.blue(`Found ${changes} modified nodes.`));
	}
}

if (import.meta.main) main();
