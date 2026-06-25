import * as t from "@babel/types";
import { traverse, type Visitor } from "../babel.js";
import { parse } from "../loader.js";
import type { Patch } from "../types.js";
import {
	getMemberPropertyName,
	getObjectPropertyByName,
	getVerifyAst,
	hasObjectKeyName,
} from "./ast-helpers.js";

/**
 * LSP filename-routing schema patch.
 *
 * Extends the per-server LSP plugin-manifest schema (the `strictObject` that
 * carries both `command` and `extensionToLanguage`) with two optional fields:
 *   - `filenames`:        record(basename -> languageId)
 *   - `filenamePatterns`: record(glob -> languageId)
 *
 * The schema is a Zod `strictObject`, so without this patch those keys are
 * rejected and a plugin can only match files by extension. The runtime routing
 * that consumes these fields lives in the `lsp-multi-server` patch (the
 * `_lspByName` helper); this patch only widens the accepted manifest shape.
 *
 * Both fields are emitted as
 *   `<zod>.record(<zod>.string().min(1), <zod>.string().min(1)).optional()`
 * mirroring the sibling `extensionToLanguage` record. The zod alias is lifted
 * from the `strictObject` call's own callee object, so no minified identifier
 * is hardcoded.
 */

const NEW_FIELDS = ["filenames", "filenamePatterns"] as const;

function isLspServerSchemaCall(node: t.CallExpression): boolean {
	const callee = node.callee;
	if (!t.isMemberExpression(callee)) return false;
	if (getMemberPropertyName(callee) !== "strictObject") return false;
	const arg = node.arguments[0];
	if (!t.isObjectExpression(arg)) return false;
	const hasCommand = arg.properties.some((p) => hasObjectKeyName(p, "command"));
	const hasExtMap = arg.properties.some((p) =>
		hasObjectKeyName(p, "extensionToLanguage"),
	);
	return hasCommand && hasExtMap;
}

function buildRecordOptional(zodName: string): t.Expression {
	const program = parse(
		`(${zodName}.record(${zodName}.string().min(1), ${zodName}.string().min(1)).optional())`,
	);
	const stmt = program.program.body[0];
	if (!t.isExpressionStatement(stmt)) {
		throw new Error("lsp-filename-schema: failed to build record expression");
	}
	return stmt.expression;
}

function isRecordOptional(node: t.Node | null | undefined): boolean {
	// Expect `<zod>.record(...).optional()`.
	if (!node || !t.isCallExpression(node)) return false;
	const optCallee = node.callee;
	if (!t.isMemberExpression(optCallee)) return false;
	if (getMemberPropertyName(optCallee) !== "optional") return false;
	const inner = optCallee.object;
	if (!t.isCallExpression(inner)) return false;
	const recCallee = inner.callee;
	return (
		t.isMemberExpression(recCallee) &&
		getMemberPropertyName(recCallee) === "record"
	);
}

function createMutateVisitor(): Visitor {
	let added = 0;
	return {
		CallExpression(path) {
			const node = path.node;
			if (!isLspServerSchemaCall(node)) return;
			const arg = node.arguments[0];
			if (!t.isObjectExpression(arg)) return;
			// Idempotency: skip if already extended.
			if (arg.properties.some((p) => hasObjectKeyName(p, "filenames"))) return;
			const callee = node.callee as t.MemberExpression;
			const zod = callee.object;
			if (!t.isIdentifier(zod)) return;
			for (const field of NEW_FIELDS) {
				arg.properties.push(
					t.objectProperty(t.identifier(field), buildRecordOptional(zod.name)),
				);
			}
			added++;
		},
		Program: {
			exit() {
				if (added > 0) {
					console.log(`LSP filename schema: extended ${added} schema(s)`);
				}
			},
		},
	};
}

function verifyFilenameSchema(code: string, ast?: t.File): true | string {
	const verifyAst = getVerifyAst(code, ast);
	if (!verifyAst)
		return "Unable to parse AST for lsp-filename-schema verification";

	let foundSchema = false;
	let ok = false;
	traverse(verifyAst, {
		CallExpression(path) {
			if (!isLspServerSchemaCall(path.node)) return;
			foundSchema = true;
			const arg = path.node.arguments[0];
			if (!t.isObjectExpression(arg)) return;
			const filenames = getObjectPropertyByName(arg, "filenames");
			const patterns = getObjectPropertyByName(arg, "filenamePatterns");
			if (
				filenames &&
				patterns &&
				isRecordOptional(filenames.value) &&
				isRecordOptional(patterns.value)
			) {
				ok = true;
			}
		},
	});

	if (!foundSchema)
		return "LSP per-server schema (strictObject with command + extensionToLanguage) not found";
	if (!ok) return "filenames/filenamePatterns not added as record().optional()";
	return true;
}

export const lspFilenameSchema: Patch = {
	tag: "lsp-filename-schema",

	astPasses: () => [
		{
			pass: "mutate",
			visitor: createMutateVisitor(),
		},
	],

	verify: verifyFilenameSchema,
};
