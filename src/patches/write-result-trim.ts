import template from "@babel/template";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";
import {
	findToolMethod,
	findToolObject,
	getObjectKeyName,
	getVerifyAst,
} from "./ast-helpers.js";

const buildWriteBody = template.default.statements(`
	return {
		tool_use_id: TOOL_ID,
		type: "tool_result",
		content: \`The file \${FILE_PATH} has been \${
			TYPE === "create" ? "created" : TYPE === "update" ? "updated" : TYPE
		}.\`,
	};
`);

/**
 * Trim the FileWrite tool result message to a minimal status string.
 */
export const shrinkWriteResult: Patch = {
	tag: "write-result-trim",

	astPasses: () => [
		{
			pass: "mutate",
			visitor: createShrinkWriteResultMutator(),
		},
	],

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst)
			return "Unable to parse AST for write-result-trim verification";

		let foundWriteTool = false;
		let foundPatchedMapMethod = false;
		traverse.default(verifyAst, {
			ObjectExpression(path: any) {
				if (!findToolObject(path, "Write")) return;
				foundWriteTool = true;

				const mapMethod = findToolMethod(
					path.node,
					"mapToolResultToToolResultBlockParam",
				);
				if (!mapMethod || !t.isObjectMethod(mapMethod)) return;

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
						t.isObjectProperty(p) && getObjectKeyName(p.key) === "content",
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

function createShrinkWriteResultMutator(): traverse.Visitor {
	return {
		ObjectExpression(path: any) {
			if (!findToolObject(path, "Write")) return;

			const mapMethod = findToolMethod(
				path.node,
				"mapToolResultToToolResultBlockParam",
			);
			if (!mapMethod || !t.isObjectMethod(mapMethod)) return;

			mapMethod.params = [
				t.objectPattern([
					t.objectProperty(t.identifier("filePath"), t.identifier("A")),
					t.objectProperty(t.identifier("type"), t.identifier("B")),
				]),
				t.identifier("G"),
			];

			mapMethod.body = t.blockStatement(
				buildWriteBody({
					TOOL_ID: t.identifier("G"),
					FILE_PATH: t.identifier("A"),
					TYPE: t.identifier("B"),
				}),
			);
		},
	};
}
