import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as parser from "@babel/parser";
import * as t from "@babel/types";
import { traverse } from "./babel.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const scanRoots = ["src", "scripts"].map((dir) => path.join(repoRoot, dir));

function collectSourceFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectSourceFiles(entryPath));
		} else if (entry.isFile() && entry.name.endsWith(".ts")) {
			files.push(entryPath);
		}
	}
	return files;
}

function isNothingLiteral(node: t.Node): boolean {
	return t.isNullLiteral(node) || t.isIdentifier(node, { name: "undefined" });
}

// In `traverse(parent, opts, scope, state, parentPath)` the fifth argument is
// the NodePath of `parent`, which is what `path.traverse()` supplies. A path in
// the fourth (state) slot leaves `parentPath` undefined, and scope registration
// then fails with "Couldn't find a Program".
test("bare traverse() never puts a NodePath in the state slot", () => {
	const offenders: string[] = [];

	for (const root of scanRoots) {
		for (const file of collectSourceFiles(root)) {
			const ast = parser.parse(readFileSync(file, "utf-8"), {
				sourceType: "module",
				plugins: ["typescript"],
			});

			traverse(ast, {
				CallExpression(callPath) {
					const { callee, arguments: args } = callPath.node;
					if (!t.isIdentifier(callee, { name: "traverse" })) return;
					if (args.length < 4) return;
					if (isNothingLiteral(args[3])) return;
					offenders.push(
						`${path.relative(repoRoot, file)}:${callPath.node.loc?.start.line ?? 0}`,
					);
				},
			});
		}
	}

	assert.deepEqual(
		offenders,
		[],
		`Use someNodePath.traverse(visitors) for sub-tree traversal instead of a bare traverse() with a path in the state slot: ${offenders.join(", ")}`,
	);
});
