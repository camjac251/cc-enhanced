import * as t from "@babel/types";
import { type NodePath, traverse } from "../babel.js";
import type { Patch, PatchAstPass } from "../types.js";
import {
	getMemberPropertyName,
	getObjectKeyName,
	getObjectPropertyByName,
	getVerifyAst,
} from "./ast-helpers.js";

const WORKFLOW_RUN_FIELD = "spawnedByWorkflowRunId";
const WORKFLOW_MESSAGE =
	"Workflow-owned agents cannot receive SendMessage deliveries or resumes. Use the Workflow tool to continue, retry, or resume the workflow run.";
const STRUCTURED_OUTPUT_HINT =
	" One or more required properties are embedded as XML-like tags inside another string. Call StructuredOutput with separate JSON properties that match the schema; do not place <field> tags inside a string.";
const STRUCTURED_OUTPUT_ERROR = "Output does not match required schema:";
const STRUCTURED_OUTPUT_LABEL = "StructuredOutput schema mismatch:";

type CandidateState = "patched" | "unpatched" | "other";

interface WorkflowMetadataCandidate {
	node: t.ObjectExpression;
	workflowRunName: string;
	extraMetadataName: string;
	catchCallPath: NodePath<t.CallExpression>;
	errorReporterName: string;
	state: CandidateState;
}

interface SendMessageCandidate {
	methodPath: NodePath<t.ObjectMethod>;
	metadataName: string;
	observerPath: NodePath<t.IfStatement>;
	state: CandidateState;
}

interface StructuredOutputCandidate {
	methodPath: NodePath<t.ObjectMethod>;
	throwPath: NodePath<t.ThrowStatement>;
	inputName: string;
	validatorName: string;
	messageArgument: t.Expression;
	state: CandidateState;
}

function getObjectPatternBinding(
	functionNode: t.Function,
	propertyName: string,
): string | null {
	for (const parameter of functionNode.params) {
		if (!t.isObjectPattern(parameter)) continue;
		for (const property of parameter.properties) {
			if (
				t.isObjectProperty(property) &&
				getObjectKeyName(property.key) === propertyName &&
				t.isIdentifier(property.value)
			) {
				return property.value.name;
			}
		}
	}
	return null;
}

function textNodeContains(node: t.Node, text: string): boolean {
	if (t.isStringLiteral(node)) return node.value.includes(text);
	if (t.isTemplateLiteral(node)) {
		return node.quasis.some((quasi) =>
			(quasi.value.cooked ?? quasi.value.raw).includes(text),
		);
	}
	return false;
}

function nodeContainsText(node: t.Node, text: string): boolean {
	if (textNodeContains(node, text)) return true;
	let found = false;
	t.traverseFast(node, (child) => {
		if (!found && textNodeContains(child, text)) found = true;
	});
	return found;
}

function nodeContainsObjectKey(node: t.Node, keyName: string): boolean {
	let found = false;
	if (t.isObjectProperty(node) && getObjectKeyName(node.key) === keyName) {
		return true;
	}
	t.traverseFast(node, (child) => {
		if (
			!found &&
			t.isObjectProperty(child) &&
			getObjectKeyName(child.key) === keyName
		) {
			found = true;
		}
	});
	return found;
}

function nodeContainsName(node: t.Node, name: string): boolean {
	if (
		(t.isIdentifier(node) && node.name === name) ||
		((t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) &&
			getMemberPropertyName(node) === name)
	) {
		return true;
	}
	let found = false;
	t.traverseFast(node, (child) => {
		if (
			!found &&
			((t.isIdentifier(child) && child.name === name) ||
				((t.isMemberExpression(child) || t.isOptionalMemberExpression(child)) &&
					getMemberPropertyName(child) === name))
		) {
			found = true;
		}
	});
	return found;
}

function isWorkflowRunSpread(
	property: t.ObjectExpression["properties"][number],
	workflowRunName: string,
): boolean {
	if (
		!t.isSpreadElement(property) ||
		!t.isLogicalExpression(property.argument, { operator: "&&" }) ||
		!t.isIdentifier(property.argument.left, { name: workflowRunName }) ||
		!t.isObjectExpression(property.argument.right)
	) {
		return false;
	}
	const properties = property.argument.right.properties;
	if (properties.length !== 1) return false;
	const workflowProperty = properties[0];
	return (
		t.isObjectProperty(workflowProperty) &&
		getObjectKeyName(workflowProperty.key) === WORKFLOW_RUN_FIELD &&
		t.isIdentifier(workflowProperty.value, { name: workflowRunName })
	);
}

function classifyMetadataWrite(
	path: NodePath<t.ObjectExpression>,
	workflowRunName: string,
): {
	catchCallPath: NodePath<t.CallExpression>;
	errorReporterName: string;
	state: CandidateState;
} | null {
	const metadataCallPath = path.parentPath;
	if (!metadataCallPath?.isCallExpression()) return null;
	const catchMemberPath = metadataCallPath.parentPath;
	if (
		!catchMemberPath?.isMemberExpression() ||
		catchMemberPath.node.object !== metadataCallPath.node ||
		getMemberPropertyName(catchMemberPath.node) !== "catch"
	) {
		return null;
	}
	const catchCallPath = catchMemberPath.parentPath;
	if (
		!catchCallPath?.isCallExpression() ||
		catchCallPath.node.callee !== catchMemberPath.node ||
		catchCallPath.node.arguments.length !== 1
	) {
		return null;
	}

	const awaitPath = catchCallPath.parentPath;
	const catchArgument = catchCallPath.node.arguments[0];
	if (t.isIdentifier(catchArgument)) {
		return {
			catchCallPath,
			errorReporterName: catchArgument.name,
			state: awaitPath?.isAwaitExpression() ? "other" : "unpatched",
		};
	}
	if (
		!awaitPath?.isAwaitExpression() ||
		!t.isArrowFunctionExpression(catchArgument) ||
		catchArgument.params.length !== 1 ||
		!t.isIdentifier(catchArgument.params[0]) ||
		!t.isBlockStatement(catchArgument.body) ||
		catchArgument.body.body.length !== 2
	) {
		return null;
	}

	const errorName = catchArgument.params[0].name;
	const [reportStatement, throwStatement] = catchArgument.body.body;
	if (
		!t.isExpressionStatement(reportStatement) ||
		!t.isCallExpression(reportStatement.expression) ||
		!t.isIdentifier(reportStatement.expression.callee) ||
		reportStatement.expression.arguments.length !== 1 ||
		!t.isIdentifier(reportStatement.expression.arguments[0], {
			name: errorName,
		}) ||
		!t.isIfStatement(throwStatement) ||
		!t.isIdentifier(throwStatement.test, { name: workflowRunName }) ||
		!t.isThrowStatement(throwStatement.consequent) ||
		!t.isIdentifier(throwStatement.consequent.argument, { name: errorName })
	) {
		return null;
	}
	return {
		catchCallPath,
		errorReporterName: reportStatement.expression.callee.name,
		state: "patched",
	};
}

function classifyWorkflowMetadata(
	path: NodePath<t.ObjectExpression>,
): WorkflowMetadataCandidate | null {
	const functionPath = path.getFunctionParent();
	if (!functionPath || !t.isFunction(functionPath.node)) return null;
	const workflowRunName = getObjectPatternBinding(
		functionPath.node,
		WORKFLOW_RUN_FIELD,
	);
	const extraMetadataName = getObjectPatternBinding(
		functionPath.node,
		"extraMetadata",
	);
	if (!workflowRunName || !extraMetadataName) return null;
	if (!getObjectPropertyByName(path.node, "agentType")) return null;
	if (!nodeContainsObjectKey(path.node, "parentAgentId")) return null;
	if (!nodeContainsObjectKey(path.node, "spawnDepth")) return null;
	if (
		!t.isCallExpression(path.parent) ||
		path.parent.arguments[2] !== path.node
	) {
		return null;
	}
	const metadataWrite = classifyMetadataWrite(path, workflowRunName);
	if (!metadataWrite) return null;

	const finalProperty = path.node.properties.at(-1);
	if (
		!t.isSpreadElement(finalProperty) ||
		!t.isIdentifier(finalProperty.argument, { name: extraMetadataName })
	) {
		return null;
	}

	const workflowSpreads = path.node.properties.filter((property) =>
		isWorkflowRunSpread(property, workflowRunName),
	);
	const metadataState: CandidateState =
		workflowSpreads.length === 0
			? "unpatched"
			: workflowSpreads.length === 1 &&
					path.node.properties.at(-2) === workflowSpreads[0]
				? "patched"
				: "other";
	const state: CandidateState =
		metadataState === "other" || metadataWrite.state === "other"
			? "other"
			: metadataState === "patched" && metadataWrite.state === "patched"
				? "patched"
				: "unpatched";
	return {
		node: path.node,
		workflowRunName,
		extraMetadataName,
		catchCallPath: metadataWrite.catchCallPath,
		errorReporterName: metadataWrite.errorReporterName,
		state,
	};
}

function addWorkflowMetadata(candidate: WorkflowMetadataCandidate): void {
	if (candidate.state !== "unpatched") return;
	const finalProperty = candidate.node.properties.at(-1);
	if (
		!finalProperty ||
		!t.isSpreadElement(finalProperty) ||
		!t.isIdentifier(finalProperty.argument, {
			name: candidate.extraMetadataName,
		})
	) {
		return;
	}
	const insertionIndex = candidate.node.properties.length - 1;
	candidate.node.properties.splice(
		insertionIndex,
		0,
		t.spreadElement(
			t.logicalExpression(
				"&&",
				t.identifier(candidate.workflowRunName),
				t.objectExpression([
					t.objectProperty(
						t.identifier(WORKFLOW_RUN_FIELD),
						t.identifier(candidate.workflowRunName),
					),
				]),
			),
		),
	);
	const errorName =
		candidate.catchCallPath.scope.generateUidIdentifier("metadataError");
	candidate.catchCallPath.node.arguments[0] = t.arrowFunctionExpression(
		[t.cloneNode(errorName)],
		t.blockStatement([
			t.expressionStatement(
				t.callExpression(t.identifier(candidate.errorReporterName), [
					t.cloneNode(errorName),
				]),
			),
			t.ifStatement(
				t.identifier(candidate.workflowRunName),
				t.throwStatement(t.cloneNode(errorName)),
			),
		]),
	);
	candidate.catchCallPath.replaceWith(
		t.awaitExpression(t.cloneNode(candidate.catchCallPath.node, true)),
	);
	candidate.state = "patched";
}

function getIdentifierMemberName(
	node: t.Node | null | undefined,
	propertyName: string,
): string | null {
	if (!t.isMemberExpression(node) && !t.isOptionalMemberExpression(node)) {
		return null;
	}
	if (getMemberPropertyName(node) !== propertyName) return null;
	return t.isIdentifier(node.object) ? node.object.name : null;
}

function isSendMessageMethod(path: NodePath<t.ObjectMethod>): boolean {
	return (
		getObjectKeyName(path.node.key) === "call" &&
		nodeContainsText(
			path.node,
			"Observers report via ObserverReport, not SendMessage",
		) &&
		nodeContainsText(path.node, "Message queued for delivery to") &&
		nodeContainsText(path.node, "had no active task; resumed from transcript")
	);
}

function classifySendMessageMethod(
	path: NodePath<t.ObjectMethod>,
): SendMessageCandidate | null {
	if (!isSendMessageMethod(path)) return null;
	const lifecycleBlocks: NodePath<t.IfStatement>[] = [];
	path.traverse({
		IfStatement(innerPath) {
			if (
				nodeContainsText(innerPath.node.test, "agent-live") &&
				nodeContainsText(innerPath.node.test, "agent-stopped") &&
				nodeContainsText(innerPath.node.test, "agent-evicted")
			) {
				lifecycleBlocks.push(innerPath);
			}
		},
	});
	if (lifecycleBlocks.length !== 1) return null;
	const lifecycleBlock = lifecycleBlocks[0];
	if (!t.isBlockStatement(lifecycleBlock.node.consequent)) return null;

	const observerPaths: NodePath<t.IfStatement>[] = [];
	lifecycleBlock.traverse({
		IfStatement(innerPath) {
			if (
				getIdentifierMemberName(innerPath.node.test, "isObserver") !== null &&
				t.isReturnStatement(innerPath.node.consequent)
			) {
				observerPaths.push(innerPath);
			}
		},
	});
	if (observerPaths.length !== 1) return null;
	const observerPath = observerPaths[0];
	const metadataName = getIdentifierMemberName(
		observerPath.node.test,
		"isObserver",
	);
	if (!metadataName) return null;
	const workflowGuards: NodePath<t.IfStatement>[] = [];
	const unavailableGuards: NodePath<t.IfStatement>[] = [];
	lifecycleBlock.traverse({
		IfStatement(innerPath) {
			if (
				t.isUnaryExpression(innerPath.node.test, { operator: "!" }) &&
				t.isIdentifier(innerPath.node.test.argument, {
					name: metadataName,
				}) &&
				t.isReturnStatement(innerPath.node.consequent)
			) {
				unavailableGuards.push(innerPath);
			}
			if (
				getIdentifierMemberName(innerPath.node.test, WORKFLOW_RUN_FIELD) ===
					metadataName &&
				nodeContainsText(innerPath.node.consequent, WORKFLOW_MESSAGE)
			) {
				workflowGuards.push(innerPath);
			}
		},
	});
	const state: CandidateState =
		workflowGuards.length === 0 && unavailableGuards.length === 0
			? "unpatched"
			: workflowGuards.length === 1 && unavailableGuards.length === 1
				? "patched"
				: "other";
	return { methodPath: path, metadataName, observerPath, state };
}

function buildWorkflowSendGuard(metadataName: string): t.IfStatement {
	return t.ifStatement(
		t.optionalMemberExpression(
			t.identifier(metadataName),
			t.identifier(WORKFLOW_RUN_FIELD),
			false,
			true,
		),
		t.returnStatement(
			t.objectExpression([
				t.objectProperty(
					t.identifier("data"),
					t.objectExpression([
						t.objectProperty(t.identifier("success"), t.booleanLiteral(false)),
						t.objectProperty(
							t.identifier("message"),
							t.stringLiteral(WORKFLOW_MESSAGE),
						),
					]),
				),
			]),
		),
	);
}

function addWorkflowSendGuard(candidate: SendMessageCandidate): void {
	if (candidate.state !== "unpatched") return;
	candidate.observerPath.insertBefore(
		t.ifStatement(
			t.unaryExpression("!", t.identifier(candidate.metadataName)),
			t.cloneNode(candidate.observerPath.node.consequent, true),
		),
	);
	candidate.observerPath.insertAfter(
		buildWorkflowSendGuard(candidate.metadataName),
	);
	candidate.state = "patched";
}

function isStructuredOutputMethod(path: NodePath<t.ObjectMethod>): boolean {
	return (
		getObjectKeyName(path.node.key) === "call" &&
		nodeContainsText(path.node, STRUCTURED_OUTPUT_ERROR) &&
		nodeContainsText(path.node, STRUCTURED_OUTPUT_LABEL)
	);
}

function getNewErrorMessage(
	throwPath: NodePath<t.ThrowStatement>,
): t.Expression | null {
	const argument = throwPath.node.argument;
	if (!t.isNewExpression(argument)) return null;
	const firstArgument = argument.arguments[0];
	return firstArgument && t.isExpression(firstArgument) ? firstArgument : null;
}

function isGuidedStructuredOutputMessage(node: t.Expression): boolean {
	if (
		!t.isBinaryExpression(node, { operator: "+" }) ||
		!nodeContainsText(node.left, STRUCTURED_OUTPUT_ERROR) ||
		!t.isConditionalExpression(node.right) ||
		!t.isStringLiteral(node.right.consequent, {
			value: STRUCTURED_OUTPUT_HINT,
		}) ||
		!t.isStringLiteral(node.right.alternate, { value: "" })
	) {
		return false;
	}
	const condition = node.right.test;
	return (
		nodeContainsText(condition, "required") &&
		nodeContainsName(condition, "missingProperty") &&
		nodeContainsName(condition, "errors") &&
		nodeContainsName(condition, "includes") &&
		nodeContainsName(condition, "values")
	);
}

function classifyStructuredOutputMethod(
	path: NodePath<t.ObjectMethod>,
): StructuredOutputCandidate | null {
	if (!isStructuredOutputMethod(path)) return null;
	const inputParameter = path.node.params[0];
	if (!t.isIdentifier(inputParameter)) return null;

	const candidates: StructuredOutputCandidate[] = [];
	path.traverse({
		ThrowStatement(throwPath) {
			const messageArgument = getNewErrorMessage(throwPath);
			if (
				!messageArgument ||
				!nodeContainsText(messageArgument, STRUCTURED_OUTPUT_ERROR)
			) {
				return;
			}
			const validationParent = throwPath.findParent((parent) =>
				parent.isIfStatement(),
			);
			if (!validationParent?.isIfStatement()) return;
			const validationPath = validationParent as NodePath<t.IfStatement>;
			const test = validationPath.node.test;
			if (
				!t.isUnaryExpression(test, { operator: "!" }) ||
				!t.isCallExpression(test.argument) ||
				!t.isIdentifier(test.argument.callee) ||
				!t.isIdentifier(test.argument.arguments[0], {
					name: inputParameter.name,
				})
			) {
				return;
			}
			candidates.push({
				methodPath: path,
				throwPath,
				inputName: inputParameter.name,
				validatorName: test.argument.callee.name,
				messageArgument,
				state: isGuidedStructuredOutputMessage(messageArgument)
					? "patched"
					: "unpatched",
			});
		},
	});
	return candidates.length === 1 ? candidates[0] : null;
}

function member(object: t.Expression, property: string): t.MemberExpression {
	return t.memberExpression(object, t.identifier(property));
}

function buildStructuredOutputCondition(
	candidate: StructuredOutputCandidate,
): t.Expression {
	const errorName =
		candidate.throwPath.scope.generateUidIdentifier("schemaError");
	const valueName =
		candidate.throwPath.scope.generateUidIdentifier("schemaValue");
	const errors = member(t.identifier(candidate.validatorName), "errors");
	const errorParams = member(t.cloneNode(errorName), "params");
	const missingProperty = member(t.cloneNode(errorParams), "missingProperty");
	const openingTag = t.binaryExpression(
		"+",
		t.stringLiteral("<"),
		t.cloneNode(missingProperty),
	);
	const fullTag = t.binaryExpression("+", openingTag, t.stringLiteral(">"));
	const valueIncludesTag = t.callExpression(
		member(t.cloneNode(valueName), "includes"),
		[fullTag],
	);
	const values = t.callExpression(member(t.identifier("Object"), "values"), [
		t.logicalExpression(
			"??",
			t.identifier(candidate.inputName),
			t.objectExpression([]),
		),
	]);
	const anyValueContainsTag = t.callExpression(member(values, "some"), [
		t.arrowFunctionExpression(
			[t.cloneNode(valueName)],
			t.logicalExpression(
				"&&",
				t.binaryExpression(
					"===",
					t.unaryExpression("typeof", t.cloneNode(valueName)),
					t.stringLiteral("string"),
				),
				valueIncludesTag,
			),
		),
	]);
	const errorMatches = t.logicalExpression(
		"&&",
		t.binaryExpression(
			"===",
			member(t.cloneNode(errorName), "keyword"),
			t.stringLiteral("required"),
		),
		t.logicalExpression(
			"&&",
			t.cloneNode(errorParams),
			t.logicalExpression(
				"&&",
				t.binaryExpression(
					"===",
					t.unaryExpression("typeof", t.cloneNode(missingProperty)),
					t.stringLiteral("string"),
				),
				anyValueContainsTag,
			),
		),
	);
	const someErrorMatches = t.callExpression(
		member(t.cloneNode(errors), "some"),
		[t.arrowFunctionExpression([t.cloneNode(errorName)], errorMatches)],
	);
	return t.logicalExpression(
		"&&",
		t.callExpression(member(t.identifier("Array"), "isArray"), [
			t.cloneNode(errors),
		]),
		someErrorMatches,
	);
}

function addStructuredOutputHint(candidate: StructuredOutputCandidate): void {
	if (candidate.state !== "unpatched") return;
	const argument = candidate.throwPath.node.argument;
	if (!t.isNewExpression(argument)) return;
	argument.arguments[0] = t.binaryExpression(
		"+",
		candidate.messageArgument,
		t.conditionalExpression(
			buildStructuredOutputCondition(candidate),
			t.stringLiteral(STRUCTURED_OUTPUT_HINT),
			t.stringLiteral(""),
		),
	);
	candidate.messageArgument = argument.arguments[0] as t.Expression;
	candidate.state = "patched";
}

function createWorkflowSafetyPasses(): PatchAstPass[] {
	const metadataCandidates: WorkflowMetadataCandidate[] = [];
	const sendMessageCandidates: SendMessageCandidate[] = [];
	const structuredOutputCandidates: StructuredOutputCandidate[] = [];
	let patched = false;

	return [
		{
			pass: "discover",
			visitor: {
				ObjectExpression(path) {
					const candidate = classifyWorkflowMetadata(path);
					if (candidate) metadataCandidates.push(candidate);
				},
				ObjectMethod(path) {
					const sendMessage = classifySendMessageMethod(path);
					if (sendMessage) sendMessageCandidates.push(sendMessage);
					const structuredOutput = classifyStructuredOutputMethod(path);
					if (structuredOutput) {
						structuredOutputCandidates.push(structuredOutput);
					}
				},
			},
		},
		{
			pass: "mutate",
			visitor: {
				Program: {
					exit() {
						if (
							metadataCandidates.length !== 1 ||
							sendMessageCandidates.length !== 1 ||
							structuredOutputCandidates.length !== 1
						) {
							return;
						}
						addWorkflowMetadata(metadataCandidates[0]);
						addWorkflowSendGuard(sendMessageCandidates[0]);
						addStructuredOutputHint(structuredOutputCandidates[0]);
						patched =
							metadataCandidates[0].state === "patched" &&
							sendMessageCandidates[0].state === "patched" &&
							structuredOutputCandidates[0].state === "patched";
					},
				},
			},
		},
		{
			pass: "finalize",
			visitor: {
				Program: {
					exit() {
						if (patched) return;
						console.warn(
							`Workflow safety: Expected one metadata, SendMessage, and StructuredOutput site (found ${metadataCandidates.length}, ${sendMessageCandidates.length}, ${structuredOutputCandidates.length})`,
						);
					},
				},
			},
		},
	];
}

/**
 * Keep workflow-owned agent lifecycles inside the workflow runtime and make
 * repeated malformed structured-output retries actionable.
 */
export const workflowSafety: Patch = {
	tag: "workflow-safety",
	astPasses: () => createWorkflowSafetyPasses(),
	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst)
			return "Unable to parse AST during workflow-safety verification";

		const metadataCandidates: WorkflowMetadataCandidate[] = [];
		const sendMessageCandidates: SendMessageCandidate[] = [];
		const structuredOutputCandidates: StructuredOutputCandidate[] = [];
		traverse(verifyAst, {
			ObjectExpression(path) {
				const candidate = classifyWorkflowMetadata(path);
				if (candidate) metadataCandidates.push(candidate);
			},
			ObjectMethod(path) {
				const sendMessage = classifySendMessageMethod(path);
				if (sendMessage) sendMessageCandidates.push(sendMessage);
				const structuredOutput = classifyStructuredOutputMethod(path);
				if (structuredOutput) {
					structuredOutputCandidates.push(structuredOutput);
				}
			},
		});

		if (metadataCandidates.length !== 1) {
			return `Workflow metadata site is ambiguous or missing (${metadataCandidates.length} found)`;
		}
		if (metadataCandidates[0].state !== "patched") {
			return "Workflow ownership metadata is not durably persisted before launch";
		}
		if (sendMessageCandidates.length !== 1) {
			return `SendMessage lifecycle site is ambiguous or missing (${sendMessageCandidates.length} found)`;
		}
		if (sendMessageCandidates[0].state !== "patched") {
			return "SendMessage does not fail closed for unavailable or workflow-owned metadata";
		}
		if (structuredOutputCandidates.length !== 1) {
			return `StructuredOutput validation site is ambiguous or missing (${structuredOutputCandidates.length} found)`;
		}
		if (structuredOutputCandidates[0].state !== "patched") {
			return "StructuredOutput schema errors do not explain embedded field tags";
		}
		return true;
	},
};
