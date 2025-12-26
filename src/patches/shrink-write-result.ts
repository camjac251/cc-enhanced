import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { PatchContext } from "../types.js";

// Trim the FileWrite tool result message to a minimal status string.
export function shrinkWriteResult(ast: any, ctx: PatchContext) {
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
									t.templateElement({ raw: "The file ", cooked: "The file " }),
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

			ctx.report.write_result_trimmed = true;
		},
	});
}
