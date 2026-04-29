import * as fs from "node:fs";
import * as t from "@babel/types";
import chalk from "chalk";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { traverse } from "./babel.js";
import { parse } from "./loader.js";

interface LoadedFile {
	file: string;
	code: string;
	lines: string[];
	ast: t.File;
}

interface SearchOptions {
	type?: string;
	field: SearchField;
	context: number;
	limit: number;
	declaration?: boolean;
	exact?: boolean;
	regex?: boolean;
	ignoreCase?: boolean;
	json?: boolean;
	breadcrumbDepth: number;
	showChildren?: boolean;
	showScope?: boolean;
	showObject?: boolean;
}

type SearchField = "all" | "string" | "template" | "identifier" | "key";

interface SearchCandidate {
	field: Exclude<SearchField, "all">;
	value: string;
	exactWeight: number;
	partialWeight: number;
}

interface CandidateMatch {
	field: Exclude<SearchField, "all">;
	value: string;
	score: number;
}

interface QueryMatcher {
	raw: string;
	normalizedRaw: string;
	regex?: RegExp;
}

interface ObjectSummary {
	line: number;
	start: number | null;
	end: number | null;
	keys: string[];
	labels: Record<string, string>;
}

interface MatchResult {
	query: string;
	type: string;
	field: string;
	matchedValue: string;
	score: number;
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	start: number | null;
	end: number | null;
	breadcrumbs: string;
	scope: string | null;
	children?: string[];
	object?: ObjectSummary;
	source: string;
}

function loadFile(file: string): LoadedFile {
	if (!fs.existsSync(file)) {
		throw new Error(`File not found: ${file}`);
	}
	const code = fs.readFileSync(file, "utf-8");
	return {
		file,
		code,
		lines: code.split("\n"),
		ast: parse(code),
	};
}

function getSourceLines(
	lines: string[],
	startLine: number,
	endLine: number,
	context: number = 0,
) {
	const start = Math.max(1, startLine - context);
	const end = Math.min(lines.length, endLine + context);

	const result = [];
	for (let i = start; i <= end; i++) {
		const isMatch = i >= startLine && i <= endLine;
		const prefix = isMatch ? chalk.yellow(">") : " ";
		const lineNum = chalk.dim(i.toString().padEnd(6));
		const lineContent = lines[i - 1];
		const content = isMatch
			? chalk.white(lineContent)
			: chalk.gray(lineContent);
		result.push(`${prefix} ${lineNum} ${content}`);
	}
	return result.join("\n");
}

function generateBreadcrumbs(path: any, depth: number): string {
	const parts = [];
	let p = path.parentPath;
	while (p) {
		parts.unshift(describePathNode(p.node));
		p = p.parentPath;
	}
	return parts.slice(-depth).join(" > ");
}

function describePathNode(node: t.Node): string {
	if (t.isFunctionDeclaration(node) || t.isFunctionExpression(node)) {
		return `Function(${node.id?.name || "anon"})`;
	}
	if (t.isArrowFunctionExpression(node)) {
		return "ArrowFunction";
	}
	if (t.isVariableDeclarator(node) && t.isIdentifier(node.id)) {
		return `Var(${node.id.name})`;
	}
	if (t.isClassDeclaration(node)) {
		return `Class(${node.id?.name ?? "anon"})`;
	}
	if (t.isObjectProperty(node) && t.isIdentifier(node.key)) {
		return `Prop(${node.key.name})`;
	}
	if (t.isObjectMethod(node) && t.isIdentifier(node.key)) {
		return `Method(${node.key.name})`;
	}
	if (t.isCallExpression(node) && t.isIdentifier(node.callee)) {
		return `Call(${node.callee.name})`;
	}
	if (t.isAssignmentExpression(node) && t.isIdentifier(node.left)) {
		return `Assign(${node.left.name})`;
	}
	return node.type;
}

function nearestScope(path: any): string | null {
	let p = path.parentPath;
	while (p) {
		const node = p.node;
		if (t.isFunctionDeclaration(node) && node.id)
			return `function ${node.id.name}`;
		if (t.isFunctionExpression(node) && node.id)
			return `function ${node.id.name}`;
		if (t.isObjectMethod(node) && t.isIdentifier(node.key)) {
			return `method ${node.key.name}`;
		}
		if (t.isClassDeclaration(node) && node.id) return `class ${node.id.name}`;
		if (t.isVariableDeclarator(node) && t.isIdentifier(node.id)) {
			return `var ${node.id.name}`;
		}
		p = p.parentPath;
	}
	return null;
}

function childNodeTypes(node: t.Node): string[] {
	const types = new Set<string>();
	for (const value of Object.values(
		node as unknown as Record<string, unknown>,
	)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				if (item && typeof item === "object" && "type" in item) {
					types.add(String((item as { type: string }).type));
				}
			}
		} else if (value && typeof value === "object" && "type" in value) {
			types.add(String((value as { type: string }).type));
		}
	}
	return [...types].sort();
}

function nearestObjectPath(path: any): any | null {
	let current = path;
	while (current) {
		if (t.isObjectExpression(current.node)) return current;
		current = current.parentPath;
	}
	return null;
}

function literalLabelValue(node: t.Node | null | undefined): string | null {
	if (!node) return null;
	if (t.isStringLiteral(node)) return node.value;
	if (t.isNumericLiteral(node)) return String(node.value);
	if (t.isBooleanLiteral(node)) return node.value ? "true" : "false";
	if (t.isTemplateLiteral(node)) return renderTemplateForPromptSearch(node);
	return null;
}

function nearestObjectSummary(path: any): ObjectSummary | null {
	const objectPath = nearestObjectPath(path);
	if (!objectPath) return null;
	const node = objectPath.node as t.ObjectExpression;
	const loc = node.loc;
	if (!loc) return null;

	const keys: string[] = [];
	const labels: Record<string, string> = {};
	const labelKeys = new Set([
		"name",
		"type",
		"title",
		"description",
		"prompt",
		"command",
		"inputSchema",
		"agentType",
	]);

	for (const property of node.properties) {
		if (!t.isObjectProperty(property) && !t.isObjectMethod(property)) continue;
		const key = propertyKeyName(property);
		if (!key) continue;
		keys.push(key);
		if (!labelKeys.has(key) || !t.isObjectProperty(property)) continue;
		const label = literalLabelValue(property.value);
		if (label !== null) {
			labels[key] =
				label.length > 160 ? `${label.slice(0, 157).trimEnd()}...` : label;
		} else if (key === "inputSchema") {
			labels[key] = property.value.type;
		}
	}

	return {
		line: loc.start.line,
		start: node.start ?? null,
		end: node.end ?? null,
		keys: keys.slice(0, 40),
		labels,
	};
}

function propertyKeyName(node: any): string | null {
	if (!t.isObjectProperty(node) && !t.isObjectMethod(node)) return null;
	if (t.isIdentifier(node.key)) return node.key.name;
	if (t.isStringLiteral(node.key)) return node.key.value;
	if (t.isNumericLiteral(node.key)) return String(node.key.value);
	return null;
}

function searchableCandidates(node: any): SearchCandidate[] {
	const values: SearchCandidate[] = [];
	if (t.isStringLiteral(node)) {
		values.push({
			field: "string",
			value: node.value,
			exactWeight: 1000,
			partialWeight: looksPromptLike(node.value) ? 760 : 720,
		});
	}
	if (t.isTemplateLiteral(node)) {
		for (const quasi of node.quasis) {
			const value = quasi.value.cooked ?? quasi.value.raw;
			values.push({
				field: "template",
				value,
				exactWeight: 980,
				partialWeight: looksPromptLike(value) ? 750 : 700,
			});
		}
	}
	if (t.isIdentifier(node)) {
		values.push({
			field: "identifier",
			value: node.name,
			exactWeight: 820,
			partialWeight: 250,
		});
	}
	const keyName = propertyKeyName(node);
	if (keyName) {
		values.push({
			field: "key",
			value: keyName,
			exactWeight: 900,
			partialWeight: 520,
		});
	}
	return values;
}

function createQueryMatcher(
	query: string,
	options: SearchOptions,
): QueryMatcher {
	const flags = options.ignoreCase ? "i" : "";
	const regex = options.regex ? new RegExp(query, flags) : undefined;
	return {
		raw: query,
		normalizedRaw: options.ignoreCase ? query.toLowerCase() : query,
		regex,
	};
}

function normalizeForMatch(value: string, options: SearchOptions): string {
	return options.ignoreCase ? value.toLowerCase() : value;
}

function scoreCandidate(
	candidate: SearchCandidate,
	matcher: QueryMatcher,
	options: SearchOptions,
): CandidateMatch | null {
	if (options.field !== "all" && candidate.field !== options.field) {
		return null;
	}

	if (matcher.regex) {
		if (!matcher.regex.test(candidate.value)) return null;
		matcher.regex.lastIndex = 0;
		return {
			field: candidate.field,
			value: candidate.value,
			score: candidate.partialWeight + 40,
		};
	}

	const value = normalizeForMatch(candidate.value, options);
	if (options.exact) {
		if (value !== matcher.normalizedRaw) return null;
		return {
			field: candidate.field,
			value: candidate.value,
			score: candidate.exactWeight,
		};
	}

	if (value === matcher.normalizedRaw) {
		return {
			field: candidate.field,
			value: candidate.value,
			score: candidate.exactWeight,
		};
	}
	if (!value.includes(matcher.normalizedRaw)) return null;

	let score = candidate.partialWeight;
	if (value.startsWith(matcher.normalizedRaw)) score += 80;
	if (candidate.value.length <= matcher.raw.length + 8) score += 40;
	return {
		field: candidate.field,
		value: candidate.value,
		score,
	};
}

function bestCandidateMatch(
	candidates: SearchCandidate[],
	matcher: QueryMatcher,
	options: SearchOptions,
): CandidateMatch | null {
	let best: CandidateMatch | null = null;
	for (const candidate of candidates) {
		const match = scoreCandidate(candidate, matcher, options);
		if (!match) continue;
		if (!best || match.score > best.score) best = match;
	}
	return best;
}

function matchDeclarationCandidate(
	node: any,
	matcher: QueryMatcher,
	options: SearchOptions,
): CandidateMatch | null {
	if (
		!t.isVariableDeclarator(node) &&
		!t.isFunctionDeclaration(node) &&
		!t.isClassDeclaration(node)
	) {
		return null;
	}
	if (!node.id || !t.isIdentifier(node.id)) return null;
	return scoreCandidate(
		{
			field: "identifier",
			value: node.id.name,
			exactWeight: 900,
			partialWeight: 500,
		},
		matcher,
		options,
	);
}

function rankMatches(matches: MatchResult[]): MatchResult[] {
	return matches.sort((left, right) => {
		const scoreDelta = right.score - left.score;
		if (scoreDelta !== 0) return scoreDelta;
		const lineDelta = left.line - right.line;
		if (lineDelta !== 0) return lineDelta;
		return left.column - right.column;
	});
}

function createMatch(
	loaded: LoadedFile,
	path: any,
	query: string,
	options: SearchOptions,
	candidate: CandidateMatch,
): MatchResult | null {
	const node = path.node;
	const loc = node.loc;
	if (!loc) return null;
	const result: MatchResult = {
		query,
		type: node.type,
		field: candidate.field,
		matchedValue: candidate.value,
		score: candidate.score,
		line: loc.start.line,
		column: loc.start.column,
		endLine: loc.end.line,
		endColumn: loc.end.column,
		start: node.start ?? null,
		end: node.end ?? null,
		breadcrumbs: generateBreadcrumbs(path, options.breadcrumbDepth),
		scope: options.showScope ? nearestScope(path) : null,
		source: getSourceLines(
			loaded.lines,
			loc.start.line,
			loc.end.line,
			options.context,
		),
	};
	if (options.showChildren) {
		result.children = childNodeTypes(node);
	}
	if (options.showObject) {
		const object = nearestObjectSummary(path);
		if (object) result.object = object;
	}
	return result;
}

function collectSearchMatches(
	loaded: LoadedFile,
	query: string,
	options: SearchOptions,
): MatchResult[] {
	const matches: MatchResult[] = [];
	const seen = new Set<string>();
	const matcher = createQueryMatcher(query, options);

	traverse(loaded.ast, {
		enter(pathRef: any) {
			const node = pathRef.node;
			if (options.type && node.type !== options.type) return;

			const candidate = options.declaration
				? matchDeclarationCandidate(node, matcher, options)
				: bestCandidateMatch(searchableCandidates(node), matcher, options);
			if (!candidate) return;

			const loc = node.loc;
			if (!loc) return;
			const key = `${loc.start.line}:${loc.start.column}:${node.type}:${query}:${candidate.field}:${candidate.value}`;
			if (seen.has(key)) return;
			seen.add(key);

			const match = createMatch(loaded, pathRef, query, options, candidate);
			if (match) matches.push(match);
		},
	});

	return rankMatches(matches).slice(0, options.limit);
}

function renderTemplateForPromptSearch(node: t.TemplateLiteral): string {
	let result = "";
	for (let index = 0; index < node.quasis.length; index++) {
		result += node.quasis[index].value.cooked ?? node.quasis[index].value.raw;
		if (index < node.expressions.length) result += "${...}";
	}
	return result;
}

function promptTextFromNode(node: t.Node): string | null {
	if (t.isStringLiteral(node)) return node.value;
	if (t.isTemplateLiteral(node)) return renderTemplateForPromptSearch(node);
	return null;
}

function looksPromptLike(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length < 120) return false;
	if (!/[A-Za-z]/.test(trimmed)) return false;
	if (!/\s/.test(trimmed)) return false;
	const lower = trimmed.toLowerCase();
	return (
		lower.includes("you ") ||
		lower.includes("must ") ||
		lower.includes("should ") ||
		lower.includes("assistant") ||
		lower.includes("tool")
	);
}

function collectPromptMatches(
	loaded: LoadedFile,
	query: string | undefined,
	options: SearchOptions,
): MatchResult[] {
	const matches: MatchResult[] = [];
	const matcher = query ? createQueryMatcher(query, options) : null;
	traverse(loaded.ast, {
		enter(pathRef: any) {
			const text = promptTextFromNode(pathRef.node);
			if (!text || !looksPromptLike(text)) return;
			const field: Exclude<SearchField, "all"> = t.isTemplateLiteral(
				pathRef.node,
			)
				? "template"
				: "string";
			const candidate = matcher
				? bestCandidateMatch(
						[
							{
								field,
								value: text,
								exactWeight: field === "template" ? 980 : 1000,
								partialWeight: field === "template" ? 750 : 760,
							},
						],
						matcher,
						options,
					)
				: { field, value: text, score: field === "template" ? 750 : 760 };
			if (!candidate) return;
			const match = createMatch(
				loaded,
				pathRef,
				query ?? "<prompt>",
				options,
				candidate,
			);
			if (match) matches.push(match);
		},
	});
	return rankMatches(matches).slice(0, options.limit);
}

async function main() {
	await yargs(hideBin(process.argv))
		.command(
			"search <file> [queries..]",
			"Search AST once and run one or more queries",
			(yargs) => {
				return addSearchOptions(
					yargs
						.positional("file", { type: "string", demandOption: true })
						.positional("queries", {
							type: "string",
							array: true,
							description: "One or more search queries",
						}),
				);
			},
			(argv) => runSearch(argv),
		)
		.command(
			"prompts <file> [query]",
			"List prompt-like string and template nodes",
			(yargs) => {
				return addSearchOptions(
					yargs
						.positional("file", { type: "string", demandOption: true })
						.positional("query", {
							type: "string",
							description: "Optional prompt text filter",
						}),
				);
			},
			(argv) => runPrompts(argv),
		)
		.command(
			"view <file> [range]",
			"View file content",
			(yargs) => {
				return yargs
					.positional("file", { type: "string", demandOption: true })
					.positional("range", {
						type: "string",
						description: "start:end",
						default: "1:50",
					});
			},
			(argv) => runView(argv),
		)
		.help()
		.strict()
		.parse();
}

function addSearchOptions(yargs: any) {
	return yargs
		.option("type", {
			alias: "t",
			type: "string",
			description: "Filter node type",
		})
		.option("field", {
			type: "string",
			choices: ["all", "string", "template", "identifier", "key"],
			default: "all",
			description: "Filter searched node value kind",
		})
		.option("context", {
			alias: "C",
			type: "number",
			default: 1,
			description: "Context lines",
		})
		.option("limit", { alias: "l", type: "number", default: 10 })
		.option("declaration", {
			alias: "d",
			type: "boolean",
			description: "Find variable/function definition only",
		})
		.option("exact", {
			alias: "e",
			type: "boolean",
			description: "Exact match for identifiers/literals",
		})
		.option("regex", {
			type: "boolean",
			description: "Treat query as a JavaScript regular expression",
		})
		.option("ignore-case", {
			alias: "i",
			type: "boolean",
			description: "Case-insensitive search",
		})
		.option("json", {
			type: "boolean",
			description: "Print machine-readable JSON",
		})
		.option("breadcrumb-depth", {
			type: "number",
			default: 8,
			description: "Number of ancestor nodes to include in breadcrumbs",
		})
		.option("children", {
			type: "boolean",
			description: "Include immediate child node types",
		})
		.option("scope", {
			type: "boolean",
			description: "Include nearest function/class/variable scope",
		})
		.option("object", {
			type: "boolean",
			description: "Include nearest object literal keys and selected labels",
		});
}

async function runView(argv: any) {
	try {
		const loaded = loadFile(argv.file);
		let [start, end] = String(argv.range).split(":").map(Number);
		if (!start) start = 1;
		if (!end) end = start + 50;
		console.log(getSourceLines(loaded.lines, start, end, 0));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(message));
		process.exit(1);
	}
}

async function runSearch(argv: any) {
	const queries = ((argv.queries as string[] | undefined) ?? []).filter(
		Boolean,
	);
	if (queries.length === 0) {
		console.error(chalk.red("At least one search query is required."));
		process.exit(1);
		return;
	}
	const options = normalizeSearchOptions(argv);
	try {
		const loaded = loadFile(argv.file);
		if (!options.json) {
			console.log(chalk.blue(`Analyzed ${loaded.file} once.`));
		}
		const runs = queries.map((query) => ({
			query,
			matches: collectSearchMatches(loaded, query, options),
		}));
		printRuns(runs, options);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(message));
		process.exit(1);
	}
}

async function runPrompts(argv: any) {
	const options = normalizeSearchOptions(argv);
	try {
		const loaded = loadFile(argv.file);
		if (!options.json) {
			console.log(chalk.blue(`Analyzed ${loaded.file} once.`));
		}
		const query = typeof argv.query === "string" ? argv.query : undefined;
		printRuns(
			[
				{
					query: query ?? "<prompt>",
					matches: collectPromptMatches(loaded, query, options),
				},
			],
			options,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(message));
		process.exit(1);
	}
}

function normalizeSearchOptions(argv: any): SearchOptions {
	return {
		type: argv.type,
		field: isSearchField(argv.field) ? argv.field : "all",
		context: Number(argv.context ?? 1),
		limit: Number(argv.limit ?? 10),
		declaration: Boolean(argv.declaration),
		exact: Boolean(argv.exact),
		regex: Boolean(argv.regex),
		ignoreCase: Boolean(argv.ignoreCase),
		json: Boolean(argv.json),
		breadcrumbDepth: Number(argv.breadcrumbDepth ?? 8),
		showChildren: Boolean(argv.children),
		showScope: Boolean(argv.scope),
		showObject: Boolean(argv.object),
	};
}

function isSearchField(value: unknown): value is SearchField {
	return (
		value === "all" ||
		value === "string" ||
		value === "template" ||
		value === "identifier" ||
		value === "key"
	);
}

function printRuns(
	runs: Array<{ query: string; matches: MatchResult[] }>,
	options: SearchOptions,
): void {
	if (options.json) {
		console.log(JSON.stringify({ runs }, null, 2));
		return;
	}

	for (const run of runs) {
		console.log(chalk.yellow("-".repeat(60)));
		console.log(chalk.cyan(`Query: ${run.query}`));
		if (run.matches.length === 0) {
			console.log(chalk.red("No matches found."));
			continue;
		}
		run.matches.forEach((match, index) => {
			console.log(chalk.yellow("-".repeat(60)));
			console.log(
				chalk.green(
					`Match #${index + 1} [${match.type}/${match.field}, score ${match.score}] at line ${match.line}, bytes ${match.start ?? "?"}-${match.end ?? "?"}`,
				),
			);
			console.log(chalk.cyan("Value: ") + summarizeValue(match.matchedValue));
			console.log(chalk.cyan("Path: ") + match.breadcrumbs);
			if (match.scope) console.log(chalk.cyan("Scope: ") + match.scope);
			if (match.children) {
				console.log(chalk.cyan("Children: ") + match.children.join(", "));
			}
			if (match.object) {
				console.log(
					chalk.cyan("Object: ") +
						`line ${match.object.line}, keys: ${match.object.keys.join(", ")}`,
				);
				const labels = Object.entries(match.object.labels);
				if (labels.length > 0) {
					console.log(
						chalk.cyan("Labels: ") +
							labels
								.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
								.join(", "),
					);
				}
			}
			console.log(match.source);
		});
		console.log(chalk.blue(`Found ${run.matches.length} matches.`));
	}
}

function summarizeValue(value: string): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > 220
		? `${normalized.slice(0, 217).trimEnd()}...`
		: normalized;
}

main();
