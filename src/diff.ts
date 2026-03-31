import * as fs from "node:fs";
import generator from "@babel/generator";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import chalk from "chalk";
import * as Diff from "diff";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { parse } from "./loader.js";

async function main() {
	await yargs(hideBin(process.argv))
		.command(
			"diff <original> <patched>",
			"Compare two JS files intelligently",
			(yargs) => {
				return yargs
					.positional("original", { type: "string", demandOption: true })
					.positional("patched", { type: "string", demandOption: true })
					.option("context", { alias: "c", type: "number", default: 2 });
			},
			(argv) => runDiff(argv),
		)
		.help()
		.strict()
		.parse();
}

function parseFile(path: string) {
	const code = fs.readFileSync(path, "utf-8");
	return {
		code,
		ast: parse(code),
	};
}

function generateBreadcrumbs(path: any): string {
	const parts = [];
	let p = path.parentPath;
	while (p) {
		const node = p.node;
		let name = node.type;
		if (t.isFunction(node)) {
			const id = "id" in node ? (node as any).id : null;
			name = `Function(${id?.name || "anon"})`;
		} else if (t.isVariableDeclarator(node) && t.isIdentifier(node.id))
			name = `Var(${node.id.name})`;
		else if (t.isObjectProperty(node) && t.isIdentifier(node.key))
			name = `Prop(${node.key.name})`;
		else if (t.isClassDeclaration(node)) name = `Class(${node.id?.name})`;
		parts.unshift(name);
		p = p.parentPath;
	}
	return parts.slice(-4).join(" > ");
}

// A simple structural hash or signature for a node to match them across files
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

async function runDiff(argv: any) {
	const { original, patched } = argv;

	console.log(chalk.blue(`Comparing ${original} -> ${patched}...`));

	const file1 = parseFile(original);
	const file2 = parseFile(patched);

	// Heuristic: Identify top-level nodes that changed.
	// We traverse both ASTs and collect signatures.

	const map1 = new Map<string, string>();
	const map2 = new Map<string, string>();

	const collect = (ast: any, map: Map<string, string>) => {
		traverse.default(ast, {
			enter(path: any) {
				const node = path.node;
				// We focus on "Identifiable" nodes
				if (
					t.isFunctionDeclaration(node) ||
					t.isVariableDeclarator(node) ||
					(t.isObjectProperty(node) && t.isIdentifier(node.key))
				) {
					const sig = getNodeSignature(node);
					const code = generator.default(node, { minified: true }).code;

					// Store the full path signature to disambiguate
					const breadcrumb = generateBreadcrumbs(path);
					const fullSig = `${breadcrumb} > ${sig}`;

					// Only store if not already there (first occurrence)
					if (!map.has(fullSig)) {
						map.set(fullSig, code);
					}
				}
			},
		});
	};

	console.log(chalk.gray("Scanning structure..."));
	collect(file1.ast, map1);
	collect(file2.ast, map2);

	let changes = 0;

	// Compare
	for (const [sig, code2] of map2.entries()) {
		if (map1.has(sig)) {
			// biome-ignore lint/style/noNonNullAssertion: guaranteed by has check
			const code1 = map1.get(sig)!;
			if (code1 !== code2) {
				changes++;
				console.log(chalk.yellow("-".repeat(60)));
				console.log(chalk.green(`CHANGED: ${sig}`));

				// Format for display
				let pretty1 = code1;
				let pretty2 = code2;
				try {
					pretty1 = generator.default(parse(code1).program.body[0], {
						minified: false,
					}).code;
					pretty2 = generator.default(parse(code2).program.body[0], {
						minified: false,
					}).code;
				} catch {}

				const diff = Diff.diffLines(pretty1, pretty2);
				diff.forEach((part) => {
					// Only show changed lines and a bit of context if we could implemented it,
					// but diffLines gives everything. We'll just colorize.
					const color = part.added
						? chalk.green
						: part.removed
							? chalk.red
							: chalk.gray;
					if (part.added || part.removed) {
						// Indent changes
						process.stdout.write(color(part.value.replace(/^/gm, "  ")));
					}
				});
				console.log("\n");
			}
		}
	}

	if (changes === 0) {
		console.log(
			chalk.gray("No structural changes detected in identified nodes."),
		);
	} else {
		console.log(chalk.blue(`Found ${changes} modified nodes.`));
	}
}

main();
