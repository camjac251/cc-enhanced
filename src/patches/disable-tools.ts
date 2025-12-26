import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { PatchContext } from "../types.js";

const TARGET_TOOLS = new Set([
	"Grep",
	"Glob",
	"WebSearch",
	"WebFetch",
	"NotebookEdit",
]);

function resolveName(
	path: any,
	node: t.Expression | t.Pattern | null | undefined,
): string | null {
	if (!node) return null;
	if (t.isStringLiteral(node)) return node.value;
	if (t.isIdentifier(node)) {
		const binding = path.scope.getBinding(node.name);
		if (binding && t.isVariableDeclarator(binding.path.node)) {
			const init = binding.path.node.init;
			if (t.isStringLiteral(init)) return init.value;
		}
	}
	return null;
}

function disableIsEnabled(obj: t.ObjectExpression) {
	let patched = false;
	for (const prop of obj.properties) {
		if (
			t.isObjectMethod(prop) &&
			t.isIdentifier(prop.key, { name: "isEnabled" })
		) {
			prop.body = t.blockStatement([
				t.returnStatement(t.booleanLiteral(false)),
			]);
			patched = true;
		} else if (
			t.isObjectProperty(prop) &&
			t.isIdentifier(prop.key, { name: "isEnabled" })
		) {
			prop.value = t.booleanLiteral(false);
			patched = true;
		}
	}
	if (!patched) {
		obj.properties.push(
			t.objectMethod(
				"method",
				t.identifier("isEnabled"),
				[],
				t.blockStatement([t.returnStatement(t.booleanLiteral(false))]),
			),
		);
	}
}

export function disableTools(ast: any, ctx: PatchContext) {
	traverse.default(ast, {
		ObjectExpression(path: any) {
			const nameProp = path.node.properties.find(
				(p: any) =>
					t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "name" }),
			) as t.ObjectProperty | undefined;
			if (!nameProp) return;

			const toolName = resolveName(path, nameProp.value as any);
			if (!toolName) return;

			if (TARGET_TOOLS.has(toolName)) {
				console.log(`Disabling tool: ${toolName}`);
				disableIsEnabled(path.node);
				ctx.report.tools_disabled = true;
			}
		},
	});
}
