import * as t from "@babel/types";
import { type NodePath, traverse } from "../babel.js";
import type { Patch, PatchAstPass } from "../types.js";
import {
	findToolMethod,
	findToolObject,
	getObjectKeyName,
	getObjectPropertyByName,
	getVerifyAst,
} from "./ast-helpers.js";

const WORKFLOW_INLINE_ALLOW_ENV = "CLAUDE_CODE_ALLOW_DYNAMIC_WORKFLOWS";
const WORKFLOW_REVIEW_MESSAGE = "Review dynamic workflow before running";

type PatchSiteState = "patched" | "unpatched" | "other";

interface WorkflowPermissionCandidate {
	path: NodePath<t.ObjectMethod>;
	inputName: string;
	contextName: string;
	finalAskIndex: number;
	state: PatchSiteState;
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

function countMatchingNodes(
	node: t.Node | null | undefined,
	predicate: (value: t.Node) => boolean,
): number {
	if (!node) return 0;
	let count = predicate(node) ? 1 : 0;
	t.traverseFast(node, (child) => {
		if (predicate(child)) count++;
	});
	return count;
}

function envMember(name: string): t.MemberExpression {
	return t.memberExpression(
		t.memberExpression(t.identifier("process"), t.identifier("env")),
		t.identifier(name),
	);
}

function isProcessEnvMember(node: t.Node, envName: string): boolean {
	if (!t.isMemberExpression(node) || node.computed) return false;
	if (
		getObjectKeyName(node.property as t.Expression | t.Identifier) !== envName
	) {
		return false;
	}

	const envObject = node.object;
	if (!t.isMemberExpression(envObject) || envObject.computed) return false;
	if (
		getObjectKeyName(envObject.property as t.Expression | t.Identifier) !==
		"env"
	) {
		return false;
	}

	const processObject = envObject.object;
	if (t.isIdentifier(processObject, { name: "process" })) return true;

	return (
		t.isMemberExpression(processObject) &&
		!processObject.computed &&
		t.isIdentifier(processObject.object, { name: "globalThis" }) &&
		getObjectKeyName(processObject.property as t.Expression | t.Identifier) ===
			"process"
	);
}

function flattenLogicalAnd(node: t.Expression): t.Expression[] {
	if (t.isLogicalExpression(node, { operator: "&&" })) {
		return [...flattenLogicalAnd(node.left), ...flattenLogicalAnd(node.right)];
	}
	return [node];
}

function getReturnedObject(
	statement: t.Statement | null | undefined,
): t.ObjectExpression | null {
	if (!t.isReturnStatement(statement)) return null;
	return t.isObjectExpression(statement.argument) ? statement.argument : null;
}

function hasStaticObjectString(
	object: t.ObjectExpression,
	propertyName: string,
	value: string,
): boolean {
	const property = getObjectPropertyByName(object, propertyName);
	return getStaticString(property?.value as t.Node | undefined) === value;
}

function getWorkflowReviewReturn(
	statement: t.Statement | null | undefined,
): t.ObjectExpression | null {
	const object = getReturnedObject(statement);
	if (!object) return null;
	return hasStaticObjectString(object, "behavior", "ask") &&
		hasStaticObjectString(object, "message", WORKFLOW_REVIEW_MESSAGE)
		? object
		: null;
}

function isInlineScriptAccess(node: t.Node, inputName: string): boolean {
	return (
		t.isMemberExpression(node) &&
		!node.computed &&
		t.isIdentifier(node.object, { name: inputName }) &&
		getObjectKeyName(node.property as t.Expression | t.Identifier) === "script"
	);
}

function isUndefinedExpression(node: t.Node): boolean {
	return (
		t.isUnaryExpression(node, { operator: "void" }) &&
		t.isNumericLiteral(node.argument, { value: 0 })
	);
}

function isUndefinedInputPropertyCheck(
	node: t.Node,
	inputName: string,
	propertyName: string,
): boolean {
	if (!t.isBinaryExpression(node, { operator: "===" })) return false;
	const isProperty = (value: t.Node): boolean =>
		t.isMemberExpression(value) &&
		!value.computed &&
		t.isIdentifier(value.object, { name: inputName }) &&
		getObjectKeyName(value.property as t.Expression | t.Identifier) ===
			propertyName;
	return (
		(isProperty(node.left) && isUndefinedExpression(node.right)) ||
		(isProperty(node.right) && isUndefinedExpression(node.left))
	);
}

function isWorkflowAllowEnvTest(node: t.Node): boolean {
	if (!t.isBinaryExpression(node, { operator: "===" })) return false;
	return (
		(isProcessEnvMember(node.left, WORKFLOW_INLINE_ALLOW_ENV) &&
			getStaticString(node.right) === "1") ||
		(isProcessEnvMember(node.right, WORKFLOW_INLINE_ALLOW_ENV) &&
			getStaticString(node.left) === "1")
	);
}

function isWorkflowValidationTest(
	node: t.Node,
	inputName: string,
	contextName: string,
): boolean {
	if (!t.isBinaryExpression(node, { operator: "===" })) return false;
	const isValidationResult = (value: t.Node): boolean => {
		if (
			!t.isMemberExpression(value) ||
			value.computed ||
			getObjectKeyName(value.property as t.Expression | t.Identifier) !==
				"result" ||
			!t.isAwaitExpression(value.object) ||
			!t.isCallExpression(value.object.argument)
		) {
			return false;
		}
		const call = value.object.argument;
		return (
			t.isMemberExpression(call.callee) &&
			!call.callee.computed &&
			t.isThisExpression(call.callee.object) &&
			getObjectKeyName(call.callee.property as t.Expression | t.Identifier) ===
				"validateInput" &&
			call.arguments.length === 2 &&
			t.isIdentifier(call.arguments[0], { name: inputName }) &&
			t.isIdentifier(call.arguments[1], { name: contextName })
		);
	};
	return (
		(isValidationResult(node.left) &&
			t.isBooleanLiteral(node.right, { value: true })) ||
		(isValidationResult(node.right) &&
			t.isBooleanLiteral(node.left, { value: true }))
	);
}

function getSingleReturn(statement: t.Statement): t.ReturnStatement | null {
	if (t.isReturnStatement(statement)) return statement;
	if (
		t.isBlockStatement(statement) &&
		statement.body.length === 1 &&
		t.isReturnStatement(statement.body[0])
	) {
		return statement.body[0];
	}
	return null;
}

function isWorkflowInlineAllowGuard(
	statement: t.Statement | null | undefined,
	inputName: string,
	contextName: string,
): boolean {
	if (!t.isIfStatement(statement) || !t.isExpression(statement.test)) {
		return false;
	}
	const operands = flattenLogicalAnd(statement.test);
	if (
		operands.length !== 5 ||
		!operands.some(isWorkflowAllowEnvTest) ||
		!operands.some((operand) => isInlineScriptAccess(operand, inputName)) ||
		!operands.some((operand) =>
			isUndefinedInputPropertyCheck(operand, inputName, "name"),
		) ||
		!operands.some((operand) =>
			isUndefinedInputPropertyCheck(operand, inputName, "scriptPath"),
		) ||
		!operands.some((operand) =>
			isWorkflowValidationTest(operand, inputName, contextName),
		)
	) {
		return false;
	}
	const returned = getSingleReturn(statement.consequent);
	const object = getReturnedObject(returned);
	if (!object || !hasStaticObjectString(object, "behavior", "allow")) {
		return false;
	}
	const updatedInput = getObjectPropertyByName(object, "updatedInput");
	return (
		updatedInput !== null &&
		t.isIdentifier(updatedInput.value, { name: inputName })
	);
}

function isWorkflowToolObject(path: NodePath<t.ObjectMethod>): boolean {
	const parent = path.parentPath;
	if (!parent?.isObjectExpression()) return false;
	if (!findToolObject(parent, "Workflow")) return false;

	const aliases = getObjectPropertyByName(parent.node, "aliases");
	const hasRunWorkflowAlias =
		aliases !== null &&
		t.isArrayExpression(aliases.value) &&
		aliases.value.elements.some((element) =>
			t.isStringLiteral(element, { value: "RunWorkflow" }),
		);
	const validateInput = findToolMethod(parent.node, "validateInput");
	const checkPermissions = findToolMethod(parent.node, "checkPermissions");
	const userFacingName = findToolMethod(parent.node, "userFacingName");
	const hasWorkflowName =
		t.isObjectMethod(userFacingName) &&
		userFacingName.body.body.some(
			(statement) =>
				t.isReturnStatement(statement) &&
				getStaticString(statement.argument) === "Workflow",
		);

	return (
		hasRunWorkflowAlias &&
		t.isObjectMethod(validateInput) &&
		checkPermissions === path.node &&
		hasWorkflowName
	);
}

function classifyWorkflowPermission(
	path: NodePath<t.ObjectMethod>,
): WorkflowPermissionCandidate | null {
	if (
		getObjectKeyName(path.node.key) !== "checkPermissions" ||
		!path.node.async ||
		!isWorkflowToolObject(path) ||
		path.node.params.length < 2 ||
		!t.isIdentifier(path.node.params[0]) ||
		!t.isIdentifier(path.node.params[1])
	) {
		return null;
	}
	const statements = path.node.body.body;
	const reviewIndexes = statements
		.map((statement, index) =>
			getWorkflowReviewReturn(statement) ? index : -1,
		)
		.filter((index) => index !== -1);
	if (
		reviewIndexes.length !== 1 ||
		reviewIndexes[0] !== statements.length - 1
	) {
		return null;
	}
	const finalAskIndex = reviewIndexes[0];
	const reviewReturn = getWorkflowReviewReturn(statements[finalAskIndex]);
	const updatedInput = reviewReturn
		? getObjectPropertyByName(reviewReturn, "updatedInput")
		: null;
	if (!updatedInput || !t.isExpression(updatedInput.value)) return null;

	const inputName = path.node.params[0].name;
	const contextName = path.node.params[1].name;
	const preceding = statements[finalAskIndex - 1];
	const hasGuard = isWorkflowInlineAllowGuard(
		preceding,
		inputName,
		contextName,
	);
	const allowEnvCount = countMatchingNodes(path.node.body, (child) =>
		isProcessEnvMember(child, WORKFLOW_INLINE_ALLOW_ENV),
	);
	return {
		path,
		inputName,
		contextName,
		finalAskIndex,
		state:
			hasGuard && allowEnvCount === 1
				? "patched"
				: allowEnvCount > 0
					? "other"
					: "unpatched",
	};
}

function buildWorkflowInlineAllowGuard(
	inputName: string,
	contextName: string,
): t.IfStatement {
	return t.ifStatement(
		t.logicalExpression(
			"&&",
			t.logicalExpression(
				"&&",
				t.logicalExpression(
					"&&",
					t.binaryExpression(
						"===",
						envMember(WORKFLOW_INLINE_ALLOW_ENV),
						t.stringLiteral("1"),
					),
					t.memberExpression(t.identifier(inputName), t.identifier("script")),
				),
				t.binaryExpression(
					"===",
					t.memberExpression(t.identifier(inputName), t.identifier("name")),
					t.unaryExpression("void", t.numericLiteral(0), true),
				),
			),
			t.logicalExpression(
				"&&",
				t.binaryExpression(
					"===",
					t.memberExpression(
						t.identifier(inputName),
						t.identifier("scriptPath"),
					),
					t.unaryExpression("void", t.numericLiteral(0), true),
				),
				t.binaryExpression(
					"===",
					t.memberExpression(
						t.awaitExpression(
							t.callExpression(
								t.memberExpression(
									t.thisExpression(),
									t.identifier("validateInput"),
								),
								[t.identifier(inputName), t.identifier(contextName)],
							),
						),
						t.identifier("result"),
					),
					t.booleanLiteral(true),
				),
			),
		),
		t.returnStatement(
			t.objectExpression([
				t.objectProperty(t.identifier("behavior"), t.stringLiteral("allow")),
				t.objectProperty(t.identifier("updatedInput"), t.identifier(inputName)),
			]),
		),
	);
}

function patchWorkflowPermission(
	candidate: WorkflowPermissionCandidate,
): boolean {
	if (candidate.state === "unpatched") {
		candidate.path.node.body.body.splice(
			candidate.finalAskIndex,
			0,
			buildWorkflowInlineAllowGuard(candidate.inputName, candidate.contextName),
		);
		candidate.state = "patched";
	}
	return candidate.state === "patched";
}

function createWorkflowInlineAllowPasses(): PatchAstPass[] {
	const candidates: WorkflowPermissionCandidate[] = [];
	let patched = false;

	return [
		{
			pass: "discover",
			visitor: {
				ObjectMethod(path) {
					const candidate = classifyWorkflowPermission(path);
					if (candidate) candidates.push(candidate);
				},
			},
		},
		{
			pass: "mutate",
			visitor: {
				Program: {
					exit() {
						if (candidates.length === 1) {
							patched = patchWorkflowPermission(candidates[0]);
						}
					},
				},
			},
		},
		{
			pass: "finalize",
			visitor: {
				Program: {
					exit() {
						if (!patched) {
							console.warn(
								`Workflow inline allow: Could not patch unique permission site (${candidates.length} candidates)`,
							);
						}
					},
				},
			},
		},
	];
}

/**
 * Allow validated inline Workflow scripts to skip the final interactive review
 * only when the routed launcher explicitly opts into trusted orchestration.
 */
export const workflowInlineAllow: Patch = {
	tag: "workflow-inline-allow",
	astPasses: () => createWorkflowInlineAllowPasses(),
	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) {
			return "Unable to parse AST during workflow-inline-allow verification";
		}

		const candidates: WorkflowPermissionCandidate[] = [];
		traverse(verifyAst, {
			ObjectMethod(path) {
				const candidate = classifyWorkflowPermission(path);
				if (candidate) candidates.push(candidate);
			},
		});

		if (candidates.length !== 1) {
			return `Inline Workflow permission site is ambiguous or missing (${candidates.length} sites found)`;
		}
		if (candidates[0].state !== "patched") {
			return "Inline Workflow scripts do not honor the explicit environment opt-in";
		}
		return true;
	},
};
