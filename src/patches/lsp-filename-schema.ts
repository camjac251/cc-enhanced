import * as t from "@babel/types";
import { traverse, type Visitor } from "../babel.js";
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
 * Extends the per-server LSP plugin-manifest object schema that carries both
 * `command` and `extensionToLanguage` with two optional fields:
 *   - `filenames`:        record(basename -> languageId)
 *   - `filenamePatterns`: record(glob -> languageId)
 *
 * The object schema rejects unknown keys, so without this patch a plugin can
 * only match files by extension. The runtime routing that consumes these
 * fields lives in the `lsp-multi-server` patch (the `_lspByName` helper); this
 * patch only widens the accepted manifest shape.
 *
 * Both fields reuse the sibling `extensionToLanguage` record factory and its
 * language-id value validator, but take their key validator from `command`
 * instead. `extensionToLanguage` validates keys as file extensions, which
 * requires a leading dot; reusing it would reject the extensionless basenames
 * (`Dockerfile`, `Makefile`) and the glob patterns these fields exist to match.
 */

const NEW_FIELDS = ["filenames", "filenamePatterns"] as const;

function getLspServerSchemaObject(
	node: t.CallExpression,
): t.ObjectExpression | null {
	const arg = node.arguments[0];
	if (!t.isObjectExpression(arg)) return null;
	const hasCommand = arg.properties.some((p) => hasObjectKeyName(p, "command"));
	const hasExtMap = arg.properties.some((p) =>
		hasObjectKeyName(p, "extensionToLanguage"),
	);
	return hasCommand && hasExtMap ? arg : null;
}

function getLspRecordBase(
	schemaObject: t.ObjectExpression,
): t.CallExpression | null {
	const extensionMap = getObjectPropertyByName(
		schemaObject,
		"extensionToLanguage",
	);
	if (!extensionMap || !t.isExpression(extensionMap.value)) return null;
	let current: t.Expression = extensionMap.value;
	while (
		t.isCallExpression(current) &&
		t.isMemberExpression(current.callee) &&
		["describe", "refine"].includes(
			getMemberPropertyName(current.callee) ?? "",
		) &&
		t.isExpression(current.callee.object)
	) {
		current = current.callee.object;
	}
	return t.isCallExpression(current) && current.arguments.length >= 2
		? current
		: null;
}

/**
 * The base string schema behind `command`, with any `refine` and `describe`
 * wrappers removed, so filename keys only have to be non-empty strings.
 */
function getCommandStringBase(
	schemaObject: t.ObjectExpression,
): t.Expression | null {
	const command = getObjectPropertyByName(schemaObject, "command");
	if (!command || !t.isExpression(command.value)) return null;
	let current: t.Expression = command.value;
	while (
		t.isCallExpression(current) &&
		t.isMemberExpression(current.callee) &&
		["describe", "refine"].includes(
			getMemberPropertyName(current.callee) ?? "",
		) &&
		t.isExpression(current.callee.object)
	) {
		current = current.callee.object;
	}
	return current;
}

function buildRecordOptional(
	recordBase: t.CallExpression,
	keyBase: t.Expression,
): t.CallExpression {
	const record = t.callExpression(t.cloneNode(recordBase.callee, true), [
		t.cloneNode(keyBase, true),
		t.cloneNode(recordBase.arguments[1] as t.Expression, true),
	]);
	return t.callExpression(
		t.memberExpression(record, t.identifier("optional")),
		[],
	);
}

function isRecordOptional(
	node: t.Node | null | undefined,
	recordBase: t.CallExpression,
	keyBase: t.Expression,
): boolean {
	if (!node || !t.isCallExpression(node)) return false;
	const optCallee = node.callee;
	if (!t.isMemberExpression(optCallee)) return false;
	if (getMemberPropertyName(optCallee) !== "optional") return false;
	const inner = optCallee.object;
	if (!t.isCallExpression(inner) || inner.arguments.length !== 2) return false;
	if (!t.isNodesEquivalent(inner.callee, recordBase.callee)) return false;
	if (!t.isNodesEquivalent(inner.arguments[0], keyBase)) return false;
	return t.isNodesEquivalent(inner.arguments[1], recordBase.arguments[1]);
}

function createMutateVisitor(): Visitor {
	let added = 0;
	return {
		CallExpression(path) {
			const node = path.node;
			const arg = getLspServerSchemaObject(node);
			if (!arg) return;
			// Idempotency: skip if already extended.
			if (arg.properties.some((p) => hasObjectKeyName(p, "filenames"))) return;
			const recordBase = getLspRecordBase(arg);
			if (!recordBase) return;
			const keyBase = getCommandStringBase(arg);
			if (!keyBase) return;
			for (const field of NEW_FIELDS) {
				arg.properties.push(
					t.objectProperty(
						t.identifier(field),
						buildRecordOptional(recordBase, keyBase),
					),
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
			const arg = getLspServerSchemaObject(path.node);
			if (!arg) return;
			foundSchema = true;
			const recordBase = getLspRecordBase(arg);
			if (!recordBase) return;
			const keyBase = getCommandStringBase(arg);
			if (!keyBase) return;
			const filenames = getObjectPropertyByName(arg, "filenames");
			const patterns = getObjectPropertyByName(arg, "filenamePatterns");
			if (
				filenames &&
				patterns &&
				isRecordOptional(filenames.value, recordBase, keyBase) &&
				isRecordOptional(patterns.value, recordBase, keyBase)
			) {
				ok = true;
			}
		},
	});

	if (!foundSchema)
		return "LSP per-server object schema with command + extensionToLanguage not found";
	if (!ok)
		return "filenames/filenamePatterns not added as string record().optional()";
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
