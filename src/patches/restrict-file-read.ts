import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { parse } from "../loader.js";
import type { PatchContext } from "../types.js";

const GUARD_CODE = `function _guard() {
  if (!/\\.(png|jpe?g|gif|bmp|webp|tiff|heic|heif|pdf)$/i.test(A || "")) {
    return {
      result: !1,
      behavior: "ask",
      message: "FileRead is limited to images and PDFs in this patched build.",
      errorCode: 14
    };
  }
}`;

export function restrictFileRead(ast: any, ctx: PatchContext) {
	traverse.default(ast, {
		ObjectExpression(path: any) {
			// Find objects with name: I3 (string literal "Read")
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
			if (nameVal !== "Read") return;

			const validateProp = path.node.properties.find(
				(p: any) =>
					t.isObjectMethod(p) &&
					t.isIdentifier(p.key, { name: "validateInput" }),
			) as t.ObjectMethod | undefined;
			if (!validateProp) return;

			// Avoid double-inserting
			const guardStr = "/\\.(png|jpe?g|gif|bmp|webp|tiff|heic|heif|pdf)$/i";
			if (
				validateProp.body.body.some((stmt) =>
					JSON.stringify(stmt).includes(guardStr),
				)
			)
				return;

			const guardFn = parse(GUARD_CODE).program
				.body[0] as t.FunctionDeclaration;
			validateProp.body.body.unshift(...guardFn.body.body);
			ctx.report.file_read_restricted = true;
		},
	});
}
