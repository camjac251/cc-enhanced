import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";
import { resolveStringValue } from "./ast-helpers.js";

/**
 * Trim the FileWrite tool result message to a minimal status string.
 */
export const shrinkWriteResult: Patch = {
	tag: "write-result-trim",

	ast: (ast) => {
		traverse.default(ast, {
			ObjectExpression(path: any) {
				const nameProp = path.node.properties.find(
					(p: any) =>
						t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "name" }),
				) as t.ObjectProperty | undefined;
				if (!nameProp) return;

				const nameVal =
					(t.isStringLiteral(nameProp.value) && nameProp.value.value) ||
					(t.isIdentifier(nameProp.value)
						? path.scope.getBinding(nameProp.value.name)?.path.node.init?.value
						: null);
				if (nameVal !== "Write") return;

				const mapMethod = path.node.properties.find(
					(p: any) =>
						t.isObjectMethod(p) &&
						t.isIdentifier(p.key, {
							name: "mapToolResultToToolResultBlockParam",
						}),
				) as t.ObjectMethod | undefined;
				if (!mapMethod) return;

				mapMethod.params = [
					t.objectPattern([
						t.objectProperty(t.identifier("filePath"), t.identifier("A")),
						t.objectProperty(t.identifier("type"), t.identifier("B")),
					]),
					t.identifier("G"),
				];

				mapMethod.body = t.blockStatement([
					t.returnStatement(
						t.objectExpression([
							t.objectProperty(t.identifier("tool_use_id"), t.identifier("G")),
							t.objectProperty(
								t.identifier("type"),
								t.stringLiteral("tool_result"),
							),
							t.objectProperty(
								t.identifier("content"),
								t.templateLiteral(
									[
										t.templateElement({
											raw: "The file ",
											cooked: "The file ",
										}),
										t.templateElement({
											raw: " has been ",
											cooked: " has been ",
										}),
										t.templateElement({ raw: ".", cooked: "." }, true),
									],
									[
										t.identifier("A"),
										t.conditionalExpression(
											t.binaryExpression(
												"===",
												t.identifier("B"),
												t.stringLiteral("create"),
											),
											t.stringLiteral("created"),
											t.conditionalExpression(
												t.binaryExpression(
													"===",
													t.identifier("B"),
													t.stringLiteral("update"),
												),
												t.stringLiteral("updated"),
												t.identifier("B"),
											),
										),
									],
								),
							),
						]),
					),
				]);
			},
		});
	},

	verify: (code, ast) => {
		if (!ast) return "Missing AST for write-result-trim verification";

		let foundWriteTool = false;
		let foundPatchedMapMethod = false;
		traverse.default(ast, {
			ObjectExpression(path: any) {
				const nameProp = path.node.properties.find(
					(p: any) =>
						t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "name" }),
				) as t.ObjectProperty | undefined;
				if (!nameProp) return;

				const toolName = resolveStringValue(path, nameProp.value as any);
				if (toolName !== "Write") return;
				foundWriteTool = true;

				const mapMethod = path.node.properties.find(
					(p: any) =>
						t.isObjectMethod(p) &&
						t.isIdentifier(p.key, {
							name: "mapToolResultToToolResultBlockParam",
						}),
				) as t.ObjectMethod | undefined;
				if (!mapMethod) return;

				const paramsOk =
					mapMethod.params.length === 2 &&
					t.isObjectPattern(mapMethod.params[0]) &&
					t.isIdentifier(mapMethod.params[1]);
				if (!paramsOk) return;

				// Verify patched body: return { ..., content: `The file ${...}` }
				const ret = mapMethod.body.body[0];
				if (!t.isReturnStatement(ret) || !t.isObjectExpression(ret.argument))
					return;
				const contentProp = ret.argument.properties.find(
					(p: any) =>
						t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "content" }),
				) as t.ObjectProperty | undefined;
				if (!contentProp || !t.isTemplateLiteral(contentProp.value)) return;
				const hasTemplate = contentProp.value.quasis.some((q) =>
					q.value.raw.includes("The file "),
				);
				if (!hasTemplate) return;

				foundPatchedMapMethod = true;
			},
		});
		if (!foundWriteTool) {
			return "Write tool definition not found for write-result-trim verification";
		}
		if (!foundPatchedMapMethod) {
			return "Write tool mapToolResultToToolResultBlockParam is not patched";
		}

		// Negative check: old verbose output should be gone
		if (code.includes("Here's the result of running `cat -n`")) {
			return "Write result still contains verbose cat -n output";
		}
		return true;
	},
};
