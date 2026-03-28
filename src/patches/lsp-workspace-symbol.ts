import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";
import { getVerifyAst } from "./ast-helpers.js";

/**
 * Fix workspaceSymbol to accept a query parameter instead of always
 * sending {query: ""}. Without this, language servers return no results.
 *
 * Two changes:
 * 1. Schema: add optional `query` string field to the workspaceSymbol variant
 * 2. Mapping: use H.query (the input param) instead of hardcoded ""
 *
 * GitHub issues: #17149, #30948
 */

// === Schema patch ===
// Find: h.strictObject({ operation: h.literal("workspaceSymbol"), filePath: ..., line: ..., character: ... })
// Add:  query: h.string().optional().describe("Symbol name to search for")

function isZodLiteral(node: t.Node, value: string): boolean {
	// Match: <z>.literal("workspaceSymbol")
	if (!t.isCallExpression(node)) return false;
	if (!t.isMemberExpression(node.callee)) return false;
	if (
		!t.isIdentifier(node.callee.property, { name: "literal" }) &&
		!t.isStringLiteral(node.callee.property, { value: "literal" })
	)
		return false;
	return (
		node.arguments.length >= 1 &&
		t.isStringLiteral(node.arguments[0], { value })
	);
}

function findPropertyByKey(
	props: t.ObjectExpression["properties"],
	key: string,
): t.ObjectProperty | null {
	for (const p of props) {
		if (!t.isObjectProperty(p)) continue;
		if (t.isIdentifier(p.key, { name: key })) return p;
		if (t.isStringLiteral(p.key, { value: key })) return p;
	}
	return null;
}

function createMutateVisitor(): traverse.Visitor {
	let schemaPatched = false;
	let mappingPatched = false;

	return {
		// 1. Schema: find the strictObject call for workspaceSymbol
		CallExpression(path) {
			const node = path.node;

			// Match: z.strictObject({ operation: z.literal("workspaceSymbol"), ... })
			if (!t.isMemberExpression(node.callee)) return;
			const methodName = t.isIdentifier(node.callee.property)
				? node.callee.property.name
				: t.isStringLiteral(node.callee.property)
					? node.callee.property.value
					: null;
			if (methodName !== "strictObject") return;
			if (node.arguments.length < 1) return;

			const objArg = node.arguments[0];
			if (!t.isObjectExpression(objArg)) return;

			const opProp = findPropertyByKey(objArg.properties, "operation");
			if (!opProp || !isZodLiteral(opProp.value, "workspaceSymbol")) return;

			// Already has query field?
			if (findPropertyByKey(objArg.properties, "query")) {
				schemaPatched = true;
				return;
			}

			// Build: query: z.string().optional().describe("Symbol name to search for")
			// We need the zod namespace identifier used on the input schema
			const zodNs = t.isIdentifier(node.callee.object)
				? node.callee.object.name
				: null;
			if (!zodNs) return;

			// h.string().optional().describe("Symbol name to search for")
			const hString = t.callExpression(
				t.memberExpression(t.identifier(zodNs), t.identifier("string")),
				[],
			);
			const hOptional = t.callExpression(
				t.memberExpression(hString, t.identifier("optional")),
				[],
			);
			const hDescribe = t.callExpression(
				t.memberExpression(hOptional, t.identifier("describe")),
				[t.stringLiteral("Symbol name to search for")],
			);

			objArg.properties.push(
				t.objectProperty(t.identifier("query"), hDescribe),
			);
			schemaPatched = true;
		},

		// 2. Mapping: find case "workspaceSymbol" -> {query: ""} and replace with {query: H.query || ""}
		StringLiteral(path) {
			if (path.node.value !== "") return;
			if (mappingPatched) return;

			// Must be inside { query: "" }
			const propPath = path.parentPath;
			if (!propPath?.isObjectProperty()) return;
			const key = t.isIdentifier(propPath.node.key)
				? propPath.node.key.name
				: t.isStringLiteral(propPath.node.key)
					? propPath.node.key.value
					: null;
			if (key !== "query") return;

			// Must be inside { method: "workspace/symbol", params: { query: "" } }
			const paramsObj = propPath.parentPath;
			if (!paramsObj?.isObjectExpression()) return;
			const outerProp = paramsObj.parentPath;
			if (!outerProp?.isObjectProperty()) return;
			const outerKey = t.isIdentifier(outerProp.node.key)
				? outerProp.node.key.name
				: null;
			if (outerKey !== "params") return;

			const returnObj = outerProp.parentPath;
			if (!returnObj?.isObjectExpression()) return;
			const methodProp = findPropertyByKey(returnObj.node.properties, "method");
			if (
				!methodProp ||
				!t.isStringLiteral(methodProp.value, {
					value: "workspace/symbol",
				})
			)
				return;

			// Find the switch case parameter name (H in: case "workspaceSymbol": return { ... params: { query: H.query || "" } })
			// Walk up to the SwitchCase, then to the SwitchStatement to get the discriminant
			const switchCase = path.findParent((p) => p.isSwitchCase());
			if (!switchCase?.isSwitchCase()) return;
			const switchStmt = switchCase.parentPath;
			if (!switchStmt?.isSwitchStatement()) return;

			// The switch discriminant might be a member expression or identifier
			// In the function, it's the input param. We need to find it.
			// The function parameter is used in other cases like H.operation, H.filePath, etc.
			// Simplest: find the identifier used in other case return values
			// e.g., textDocument: { uri: A } (A is derived from H)
			// Actually, looking at the code, the switch function takes H as first param.
			// Let's find the enclosing function's first parameter.
			const fnPath = path.getFunctionParent();
			if (!fnPath) return;
			const fnNode = fnPath.node as
				| t.FunctionDeclaration
				| t.FunctionExpression
				| t.ArrowFunctionExpression;
			if (fnNode.params.length < 1) return;
			const inputParam = fnNode.params[0];
			if (!t.isIdentifier(inputParam)) return;
			const inputName = inputParam.name;

			// Replace "" with inputParam.query || ""
			// H.query || ""
			const replacement = t.logicalExpression(
				"||",
				t.memberExpression(t.identifier(inputName), t.identifier("query")),
				t.stringLiteral(""),
			);
			path.replaceWith(replacement);
			mappingPatched = true;
		},

		Program: {
			exit() {
				const parts = [];
				if (schemaPatched) parts.push("schema");
				if (mappingPatched) parts.push("mapping");
				if (parts.length > 0) {
					console.log(`LSP workspaceSymbol: patched ${parts.join(" + ")}`);
				}
			},
		},
	};
}

// === Verification ===

function verifyWorkspaceSymbol(code: string, ast?: t.File): true | string {
	const verifyAst = getVerifyAst(code, ast);
	if (!verifyAst)
		return "Unable to parse AST for lsp-workspace-symbol verification";

	let hasQueryInSchema = false;
	let hasQueryPassthrough = false;

	traverse.default(verifyAst, {
		CallExpression(path) {
			// Check schema has query field
			if (!t.isMemberExpression(path.node.callee)) return;
			const method = t.isIdentifier(path.node.callee.property)
				? path.node.callee.property.name
				: null;
			if (method !== "strictObject") return;
			if (path.node.arguments.length < 1) return;
			const obj = path.node.arguments[0];
			if (!t.isObjectExpression(obj)) return;

			const opProp = findPropertyByKey(obj.properties, "operation");
			if (!opProp || !isZodLiteral(opProp.value, "workspaceSymbol")) return;
			if (findPropertyByKey(obj.properties, "query")) hasQueryInSchema = true;
		},

		ObjectProperty(path) {
			// Check mapping uses query passthrough (not hardcoded "")
			if (!t.isIdentifier(path.node.key, { name: "query" })) return;
			if (
				!t.isStringLiteral(path.node.key) &&
				!t.isIdentifier(path.node.key, { name: "query" })
			)
				return;

			// Must be inside params of workspace/symbol return object
			const paramsObj = path.parentPath;
			if (!paramsObj?.isObjectExpression()) return;
			const outerProp = paramsObj.parentPath;
			if (!outerProp?.isObjectProperty()) return;
			if (!t.isIdentifier(outerProp.node.key, { name: "params" })) return;
			const returnObj = outerProp.parentPath;
			if (!returnObj?.isObjectExpression()) return;
			const methodProp = findPropertyByKey(returnObj.node.properties, "method");
			if (
				!methodProp ||
				!t.isStringLiteral(methodProp.value, {
					value: "workspace/symbol",
				})
			)
				return;

			// Value should be a LogicalExpression (H.query || ""), not a plain StringLiteral
			if (t.isLogicalExpression(path.node.value)) hasQueryPassthrough = true;
			// Also accept if it's a MemberExpression (H.query) without fallback
			if (t.isMemberExpression(path.node.value)) hasQueryPassthrough = true;
		},
	});

	if (!hasQueryInSchema) return "workspaceSymbol schema missing query field";
	if (!hasQueryPassthrough)
		return 'workspaceSymbol mapping still uses hardcoded ""';

	return true;
}

export const lspWorkspaceSymbol: Patch = {
	tag: "lsp-workspace-symbol",

	astPasses: () => [
		{
			pass: "mutate",
			visitor: createMutateVisitor(),
		},
	],

	verify: verifyWorkspaceSymbol,
};
