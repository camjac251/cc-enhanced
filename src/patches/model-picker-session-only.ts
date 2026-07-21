import * as t from "@babel/types";
import { type NodePath, traverse } from "../babel.js";
import type { Patch, PatchAstPass } from "../types.js";
import {
	collectSubagentModelEnvArrays,
	getObjectKeyName,
	getVerifyAst,
	isSubagentModelEnvArray,
} from "./ast-helpers.js";

const SESSION_ONLY_ENV = "CLAUDE_CODE_MODEL_PICKER_SESSION_ONLY";
const DEFAULT_HEADER =
	"Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.";
const SESSION_ONLY_HEADER =
	"Switch between models for this session. Your selection is not saved as the default for new sessions.";
const PICKER_PROPERTIES = [
	"initial",
	"sessionModel",
	"onSelect",
	"onSetDefault",
	"onCancel",
	"isStandaloneCommand",
	"showFastModeNotice",
	"headerText",
	"options",
	"skipSettingsWrite",
] as const;

interface PickerComponentCandidate {
	path: NodePath<t.FunctionDeclaration>;
	declarationIndex: number;
	onSetDefaultName: string;
	headerName: string;
	headerDeclarator: t.VariableDeclarator;
}

function getStaticString(node: t.Node | null | undefined): string | null {
	if (t.isStringLiteral(node)) return node.value;
	if (
		t.isTemplateLiteral(node) &&
		node.expressions.length === 0 &&
		node.quasis.length === 1
	) {
		return node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
	}
	return null;
}

function isVoidZero(node: t.Node | null | undefined): boolean {
	return (
		t.isUnaryExpression(node, { operator: "void" }) &&
		t.isNumericLiteral(node.argument, { value: 0 })
	);
}

function isProcessEnvMember(node: t.Node, envName: string): boolean {
	if (!t.isMemberExpression(node) || node.computed) return false;
	if (getObjectKeyName(node.property) !== envName) return false;
	const envObject = node.object;
	if (
		!t.isMemberExpression(envObject) ||
		envObject.computed ||
		getObjectKeyName(envObject.property) !== "env"
	) {
		return false;
	}
	return (
		t.isIdentifier(envObject.object, { name: "process" }) ||
		(t.isMemberExpression(envObject.object) &&
			!envObject.object.computed &&
			t.isIdentifier(envObject.object.object, { name: "globalThis" }) &&
			getObjectKeyName(envObject.object.property) === "process")
	);
}

function processEnvMember(envName: string): t.MemberExpression {
	return t.memberExpression(
		t.memberExpression(t.identifier("process"), t.identifier("env")),
		t.identifier(envName),
	);
}

function isSessionOnlyPresence(node: t.Node | null | undefined): boolean {
	return (
		t.isBinaryExpression(node, { operator: "!==" }) &&
		isProcessEnvMember(node.left, SESSION_ONLY_ENV) &&
		isVoidZero(node.right)
	);
}

function getPatternBinding(
	pattern: t.ObjectPattern,
	propertyName: string,
): string | null {
	for (const property of pattern.properties) {
		if (
			t.isObjectProperty(property) &&
			getObjectKeyName(property.key) === propertyName &&
			t.isIdentifier(property.value)
		) {
			return property.value.name;
		}
	}
	return null;
}

function patternHasProperties(pattern: t.ObjectPattern): boolean {
	const keys = new Set(
		pattern.properties.map((property) =>
			t.isObjectProperty(property) ? getObjectKeyName(property.key) : null,
		),
	);
	return PICKER_PROPERTIES.every((key) => keys.has(key));
}

function getHeaderDeclarator(
	statements: readonly t.Statement[],
	headerName: string,
): t.VariableDeclarator | null {
	const matches: t.VariableDeclarator[] = [];
	for (const statement of statements) {
		if (!t.isVariableDeclaration(statement)) continue;
		for (const declaration of statement.declarations) {
			const initializer = declaration.init;
			if (
				!t.isLogicalExpression(initializer, { operator: "??" }) ||
				!t.isIdentifier(initializer.left, { name: headerName })
			) {
				continue;
			}
			const fallback = t.isConditionalExpression(initializer.right)
				? initializer.right.alternate
				: initializer.right;
			if (getStaticString(fallback) === DEFAULT_HEADER)
				matches.push(declaration);
		}
	}
	return matches.length === 1 ? matches[0] : null;
}

function classifyPickerComponent(
	path: NodePath<t.FunctionDeclaration>,
): PickerComponentCandidate | null {
	if (!path.node.id || path.node.params.length !== 1) return null;
	const statements = path.node.body.body;
	for (const [index, statement] of statements.entries()) {
		if (!t.isVariableDeclaration(statement) || statement.kind !== "let") {
			continue;
		}
		const pattern = statement.declarations.find(
			(
				declaration,
			): declaration is t.VariableDeclarator & {
				id: t.ObjectPattern;
			} =>
				t.isObjectPattern(declaration.id) &&
				patternHasProperties(declaration.id),
		)?.id;
		if (!pattern) continue;
		const onSetDefaultName = getPatternBinding(pattern, "onSetDefault");
		const headerName = getPatternBinding(pattern, "headerText");
		if (!onSetDefaultName || !headerName) return null;
		const headerDeclarator = getHeaderDeclarator(statements, headerName);
		if (!headerDeclarator) return null;
		return {
			path,
			declarationIndex: index,
			onSetDefaultName,
			headerName,
			headerDeclarator,
		};
	}
	return null;
}

function isSessionOnlyGuardStatement(
	statement: t.Statement | undefined,
	onSetDefaultName: string,
): boolean {
	if (!t.isIfStatement(statement) || !isSessionOnlyPresence(statement.test)) {
		return false;
	}
	const assignment = t.isBlockStatement(statement.consequent)
		? statement.consequent.body[0]
		: statement.consequent;
	return (
		t.isExpressionStatement(assignment) &&
		t.isAssignmentExpression(assignment.expression, { operator: "=" }) &&
		t.isIdentifier(assignment.expression.left, {
			name: onSetDefaultName,
		}) &&
		isVoidZero(assignment.expression.right)
	);
}

// Anchor the guard on its own shape (session-only presence test disabling the
// picker's default-setter) anywhere in the component body rather than at a fixed
// offset from the destructuring, so an upstream statement inserted between the
// two does not read as unpatched.
function hasSessionOnlyGuard(candidate: PickerComponentCandidate): boolean {
	return candidate.path.node.body.body.some((statement) =>
		isSessionOnlyGuardStatement(statement, candidate.onSetDefaultName),
	);
}

function hasSessionOnlyHeader(candidate: PickerComponentCandidate): boolean {
	const initializer = candidate.headerDeclarator.init;
	if (!t.isLogicalExpression(initializer, { operator: "??" })) return false;
	const fallback = initializer.right;
	return (
		t.isConditionalExpression(fallback) &&
		isSessionOnlyPresence(fallback.test) &&
		getStaticString(fallback.consequent) === SESSION_ONLY_HEADER &&
		getStaticString(fallback.alternate) === DEFAULT_HEADER
	);
}

function patchPickerComponent(candidate: PickerComponentCandidate): boolean {
	if (!hasSessionOnlyGuard(candidate)) {
		candidate.path.node.body.body.splice(
			candidate.declarationIndex + 1,
			0,
			t.ifStatement(
				t.binaryExpression(
					"!==",
					processEnvMember(SESSION_ONLY_ENV),
					t.unaryExpression("void", t.numericLiteral(0)),
				),
				t.expressionStatement(
					t.assignmentExpression(
						"=",
						t.identifier(candidate.onSetDefaultName),
						t.unaryExpression("void", t.numericLiteral(0)),
					),
				),
			),
		);
	}
	if (!hasSessionOnlyHeader(candidate)) {
		const initializer = candidate.headerDeclarator.init;
		if (
			!t.isLogicalExpression(initializer, { operator: "??" }) ||
			getStaticString(initializer.right) !== DEFAULT_HEADER
		) {
			return false;
		}
		initializer.right = t.conditionalExpression(
			t.binaryExpression(
				"!==",
				processEnvMember(SESSION_ONLY_ENV),
				t.unaryExpression("void", t.numericLiteral(0)),
			),
			t.stringLiteral(SESSION_ONLY_HEADER),
			t.stringLiteral(DEFAULT_HEADER),
		);
	}
	return hasSessionOnlyGuard(candidate) && hasSessionOnlyHeader(candidate);
}

function getEnvironmentArrayState(
	array: t.ArrayExpression,
): "stock" | "patched" | "other" {
	const matches = array.elements.filter((element) =>
		t.isStringLiteral(element, { value: SESSION_ONLY_ENV }),
	).length;
	if (matches === 0) return "stock";
	return matches === 1 ? "patched" : "other";
}

function patchEnvironmentArray(array: t.ArrayExpression): boolean {
	const state = getEnvironmentArrayState(array);
	if (state === "patched") return true;
	if (state !== "stock") return false;
	array.elements.push(t.stringLiteral(SESSION_ONLY_ENV));
	return true;
}

function createModelPickerSessionOnlyPasses(): PatchAstPass[] {
	const candidates: PickerComponentCandidate[] = [];
	const environmentArrays: t.ArrayExpression[] = [];
	let patched = false;

	return [
		{
			pass: "discover",
			visitor: {
				FunctionDeclaration(path) {
					const candidate = classifyPickerComponent(path);
					if (candidate) candidates.push(candidate);
				},
				ArrayExpression(path) {
					if (isSubagentModelEnvArray(path.node)) {
						environmentArrays.push(path.node);
					}
				},
			},
		},
		{
			pass: "finalize",
			visitor: {
				Program: {
					exit() {
						if (candidates.length !== 1) return;
						const componentPatched = patchPickerComponent(candidates[0]);
						const environmentPatched =
							environmentArrays.length > 0 &&
							environmentArrays.every((array) => patchEnvironmentArray(array));
						patched = componentPatched && environmentPatched;
						if (!patched) {
							console.warn(
								`Session-only model picker: Could not patch unique picker surfaces (components: ${candidates.length}, environment arrays: ${environmentArrays.length})`,
							);
						}
					},
				},
			},
		},
	];
}

export const modelPickerSessionOnly: Patch = {
	tag: "model-picker-session-only",
	astPasses: () => createModelPickerSessionOnlyPasses(),
	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) {
			return "Unable to parse AST during model-picker-session-only verification";
		}
		const candidates: PickerComponentCandidate[] = [];
		const environmentArrays = collectSubagentModelEnvArrays(verifyAst);
		traverse(verifyAst, {
			FunctionDeclaration(path) {
				const candidate = classifyPickerComponent(path);
				if (candidate) candidates.push(candidate);
			},
		});
		if (candidates.length !== 1) {
			return `Model picker component is ambiguous or missing (${candidates.length} sites found)`;
		}
		if (!hasSessionOnlyGuard(candidates[0])) {
			return "Model picker does not disable default-setting in session-only mode";
		}
		if (!hasSessionOnlyHeader(candidates[0])) {
			return "Model picker does not describe session-only selection";
		}
		if (environmentArrays.length === 0) {
			return "Session-only picker environment forwarding not found";
		}
		if (
			environmentArrays.some(
				(array) => getEnvironmentArrayState(array) !== "patched",
			)
		) {
			return "Child process environment forwarding omits session-only picker mode";
		}
		return true;
	},
};
