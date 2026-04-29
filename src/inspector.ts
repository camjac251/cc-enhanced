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
	context: number;
	limit: number;
	declaration?: boolean;
	exact?: boolean;
	json?: boolean;
	breadcrumbDepth: number;
	showChildren?: boolean;
	showScope?: boolean;
}

interface MatchResult {
	query: string;
	type: string;
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	start: number | null;
	end: number | null;
	breadcrumbs: string;
	scope: string | null;
	children?: string[];
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

function searchableValues(node: any): string[] {
	const values: string[] = [];
	if (node.value !== undefined) values.push(String(node.value));
	if (node.name !== undefined) values.push(String(node.name));
	if (node.key?.name !== undefined) values.push(String(node.key.name));
	if (node.key?.value !== undefined) values.push(String(node.key.value));
	if (node.quasis) {
		for (const quasi of node.quasis) {
			values.push(quasi.value.raw, quasi.value.cooked ?? "");
		}
	}
	return values;
}

function matchesText(
	values: string[],
	query: string,
	exact?: boolean,
): boolean {
	return values.some((value) =>
		exact ? value === query : value.includes(query),
	);
}

function matchesDeclaration(
	node: any,
	query: string,
	exact?: boolean,
): boolean {
	if (
		!t.isVariableDeclarator(node) &&
		!t.isFunctionDeclaration(node) &&
		!t.isClassDeclaration(node)
	) {
		return false;
	}
	if (!node.id || !t.isIdentifier(node.id)) return false;
	return exact ? node.id.name === query : node.id.name.includes(query);
}

function createMatch(
	loaded: LoadedFile,
	path: any,
	query: string,
	options: SearchOptions,
): MatchResult | null {
	const node = path.node;
	const loc = node.loc;
	if (!loc) return null;
	const result: MatchResult = {
		query,
		type: node.type,
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
	return result;
}

function collectSearchMatches(
	loaded: LoadedFile,
	query: string,
	options: SearchOptions,
): MatchResult[] {
	const matches: MatchResult[] = [];
	const seen = new Set<string>();

	traverse(loaded.ast, {
		enter(pathRef: any) {
			if (matches.length >= options.limit) return;

			const node = pathRef.node;
			if (options.type && node.type !== options.type) return;

			const matchFound = options.declaration
				? matchesDeclaration(node, query, options.exact)
				: matchesText(searchableValues(node), query, options.exact);
			if (!matchFound) return;

			const loc = node.loc;
			if (!loc) return;
			const key = `${loc.start.line}:${loc.start.column}:${node.type}:${query}`;
			if (seen.has(key)) return;
			seen.add(key);

			const match = createMatch(loaded, pathRef, query, options);
			if (match) matches.push(match);
		},
	});

	return matches;
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
	traverse(loaded.ast, {
		enter(pathRef: any) {
			if (matches.length >= options.limit) return;
			const text = promptTextFromNode(pathRef.node);
			if (!text || !looksPromptLike(text)) return;
			if (query && !(options.exact ? text === query : text.includes(query))) {
				return;
			}
			const match = createMatch(loaded, pathRef, query ?? "<prompt>", options);
			if (match) matches.push(match);
		},
	});
	return matches;
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
		.option("context", {
			alias: "C",
			type: "number",
			default: 1,
			description: "Source lines context",
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
		context: Number(argv.context ?? 1),
		limit: Number(argv.limit ?? 10),
		declaration: Boolean(argv.declaration),
		exact: Boolean(argv.exact),
		json: Boolean(argv.json),
		breadcrumbDepth: Number(argv.breadcrumbDepth ?? 8),
		showChildren: Boolean(argv.children),
		showScope: Boolean(argv.scope),
	};
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
					`Match #${index + 1} [${match.type}] at line ${match.line}, bytes ${match.start ?? "?"}-${match.end ?? "?"}`,
				),
			);
			console.log(chalk.cyan("Path: ") + match.breadcrumbs);
			if (match.scope) console.log(chalk.cyan("Scope: ") + match.scope);
			if (match.children) {
				console.log(chalk.cyan("Children: ") + match.children.join(", "));
			}
			console.log(match.source);
		});
		console.log(chalk.blue(`Found ${run.matches.length} matches.`));
	}
}

main();
