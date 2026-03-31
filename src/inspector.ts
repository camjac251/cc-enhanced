import * as fs from "node:fs";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import chalk from "chalk";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { parse } from "./loader.js";

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
		const lineContent = lines[i - 1]; // 0-indexed array, 1-indexed lines
		const content = isMatch
			? chalk.white(lineContent)
			: chalk.gray(lineContent);
		result.push(`${prefix} ${lineNum} ${content}`);
	}
	return result.join("\n");
}

function generateBreadcrumbs(path: any): string {
	const parts = [];
	let p = path.parentPath;
	while (p) {
		const node = p.node;
		let name = node.type;

		if (t.isFunctionDeclaration(node) || t.isFunctionExpression(node)) {
			name = `Function(${node.id?.name || "anon"})`;
		} else if (t.isVariableDeclarator(node) && t.isIdentifier(node.id)) {
			name = `Var(${node.id.name})`;
		} else if (t.isClassDeclaration(node)) {
			name = `Class(${node.id?.name})`;
		} else if (t.isObjectProperty(node) && t.isIdentifier(node.key)) {
			name = `Prop(${node.key.name})`;
		} else if (t.isCallExpression(node) && t.isIdentifier(node.callee)) {
			name = `Call(${node.callee.name})`;
		} else if (t.isAssignmentExpression(node) && t.isIdentifier(node.left)) {
			name = `Assign(${node.left.name})`;
		}

		parts.unshift(name);
		p = p.parentPath;
	}
	return parts.slice(-5).join(" > ");
}

async function main() {
	await yargs(hideBin(process.argv))
		.command(
			"search <file> <query>",
			"Search AST",
			(yargs) => {
				return yargs
					.positional("file", { type: "string", demandOption: true })
					.positional("query", { type: "string", demandOption: true })
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
					});
			},
			(argv) => runSearch(argv),
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

async function runView(argv: any) {
	const { file, range } = argv;
	if (!fs.existsSync(file)) {
		console.error(chalk.red(`File not found: ${file}`));
		process.exit(1);
	}
	const content = fs.readFileSync(file, "utf-8");
	const lines = content.split("\n");
	let [start, end] = range.split(":").map(Number);
	if (!start) start = 1;
	if (!end) end = start + 50;
	console.log(getSourceLines(lines, start, end, 0));
}

async function runSearch(argv: any) {
	const { file, query, type, context, limit, declaration, exact } = argv;

	if (!fs.existsSync(file)) {
		console.error(chalk.red(`File not found: ${file}`));
		process.exit(1);
	}

	console.log(chalk.blue(`Analyzing ${file}...`));
	const code = fs.readFileSync(file, "utf-8");
	const lines = code.split("\n");
	const ast = parse(code);

	let matches = 0;
	const seen = new Set<string>();

	traverse.default(ast, {
		enter(path: any) {
			if (matches >= limit) return;

			const node = path.node;
			if (type && node.type !== type) return;

			// If definition mode, strict filter
			if (declaration) {
				if (
					!t.isVariableDeclarator(node) &&
					!t.isFunctionDeclaration(node) &&
					!t.isClassDeclaration(node)
				) {
					return;
				}
				// Check id
				if (!node.id || !t.isIdentifier(node.id)) return;
				if (exact ? node.id.name !== query : !node.id.name.includes(query))
					return;
			}

			let matchFound = false;

			if (!declaration) {
				const check = (val: string) =>
					exact ? val === query : val.includes(query);

				if (node.value && check(String(node.value))) matchFound = true;
				else if (node.name && check(String(node.name))) matchFound = true;
				else if (node.key?.name && check(String(node.key.name)))
					matchFound = true;
				else if (node.quasis) {
					for (const q of node.quasis) {
						if (check(q.value.raw)) {
							matchFound = true;
							break;
						}
					}
				}
			} else {
				matchFound = true; // Already checked above
			}

			if (matchFound) {
				const loc = node.loc;
				if (!loc) return;

				// Dedup based on line number to avoid visiting same node multiple times if traversal hits keys/values
				const key = `${loc.start.line}:${loc.start.column}`;
				if (seen.has(key)) return;
				seen.add(key);

				matches++;
				console.log(chalk.yellow("-".repeat(60)));
				console.log(
					chalk.green(
						`Match #${matches} [${node.type}] at line ${loc.start.line}`,
					),
				);
				console.log(chalk.cyan("Path: ") + generateBreadcrumbs(path));

				// Show Source
				console.log(
					getSourceLines(lines, loc.start.line, loc.end.line, context),
				);
			}
		},
	});

	if (matches === 0) {
		console.log(chalk.red("No matches found."));
	} else {
		console.log(chalk.blue(`\nFound ${matches} matches.`));
	}
}

main();
