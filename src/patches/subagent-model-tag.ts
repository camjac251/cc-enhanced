import * as t from "@babel/types";
import { type NodePath, traverse } from "../babel.js";
import type { Patch, PatchAstPass } from "../types.js";
import {
	getMemberPropertyName,
	getObjectKeyName,
	getObjectPropertyByName,
	getVerifyAst,
	isElementCall,
	isTrueLike,
} from "./ast-helpers.js";

const BUILTIN_MODEL_ALIASES = ["sonnet", "opus", "haiku", "fable"] as const;
const AGENT_DESCRIPTION = "A short (3-5 word) description of the task";
const AGENT_PROMPT = "The task for the agent to perform";
const AGENT_TYPE = "The type of specialized agent to use for this task";
const AGENT_MODEL_DESCRIPTION =
	'Optional model override for this agent. Accepts a built-in model alias (for example, "fable", "opus", "sonnet", or "haiku"), "inherit", or a full model ID available through /model and exposed by the active provider. Takes precedence over the agent definition\'s model frontmatter. If omitted, uses the agent definition\'s model or inherits from the parent; "inherit" always uses the parent model. Ignored for subagent_type: "fork"; forks always inherit the parent model.';

type MemberCall = t.CallExpression & { callee: t.MemberExpression };

interface AgentModelSchemaShape {
	describeCall: MemberCall;
	optionalCall: MemberCall;
	kind: "aliases" | "nonempty-string" | "other";
	receiver: t.Expression | null;
}

function getMemberCall(
	node: t.Node | null | undefined,
	methodName: string,
): MemberCall | null {
	if (!t.isCallExpression(node) || !t.isMemberExpression(node.callee)) {
		return null;
	}
	if (getMemberPropertyName(node.callee) !== methodName) return null;
	return node as MemberCall;
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

function isDescribedWith(
	object: t.ObjectExpression,
	propertyName: string,
	description: string,
): boolean {
	const property = getObjectPropertyByName(object, propertyName);
	if (!property) return false;
	const describeCall = getMemberCall(property.value, "describe");
	return (
		getStaticString(describeCall?.arguments[0] as t.Node | undefined) ===
		description
	);
}

function getPropertyDescription(
	object: t.ObjectExpression,
	propertyName: string,
): string | null {
	const property = getObjectPropertyByName(object, propertyName);
	if (!property) return null;
	const describeCall = getMemberCall(property.value, "describe");
	return getStaticString(describeCall?.arguments[0] as t.Node | undefined);
}

function isAgentModelDescription(description: string | null): boolean {
	if (!description) return false;
	return (
		description.includes("Optional model override for this agent") &&
		description.includes("agent definition's model frontmatter") &&
		description.includes('subagent_type: "fork"')
	);
}

function isAgentInputSchemaObject(node: t.ObjectExpression): boolean {
	return (
		isDescribedWith(node, "description", AGENT_DESCRIPTION) &&
		isDescribedWith(node, "prompt", AGENT_PROMPT) &&
		isDescribedWith(node, "subagent_type", AGENT_TYPE) &&
		isAgentModelDescription(getPropertyDescription(node, "model")) &&
		getObjectPropertyByName(node, "run_in_background") !== null
	);
}

function getEnumReceiver(node: t.Node): t.Expression | null {
	const enumCall = getMemberCall(node, "enum");
	if (enumCall?.arguments.length !== 1) return null;
	const values = enumCall.arguments[0];
	if (!t.isArrayExpression(values)) return null;
	if (values.elements.length !== BUILTIN_MODEL_ALIASES.length) return null;
	for (const [index, expected] of BUILTIN_MODEL_ALIASES.entries()) {
		if (!t.isStringLiteral(values.elements[index], { value: expected })) {
			return null;
		}
	}
	return t.isExpression(enumCall.callee.object) ? enumCall.callee.object : null;
}

function getNonemptyStringReceiver(node: t.Node): t.Expression | null {
	const minCall = getMemberCall(node, "min");
	if (
		minCall?.arguments.length !== 1 ||
		!t.isNumericLiteral(minCall.arguments[0], { value: 1 })
	) {
		return null;
	}
	const trimCall = getMemberCall(minCall.callee.object, "trim");
	if (trimCall?.arguments.length !== 0) return null;
	const stringCall = getMemberCall(trimCall.callee.object, "string");
	if (stringCall?.arguments.length !== 0) return null;
	return t.isExpression(stringCall.callee.object)
		? stringCall.callee.object
		: null;
}

function getAgentModelSchemaShape(
	object: t.ObjectExpression,
): AgentModelSchemaShape | null {
	const modelProperty = getObjectPropertyByName(object, "model");
	if (!modelProperty) return null;
	const describeCall = getMemberCall(modelProperty.value, "describe");
	if (!describeCall) return null;
	const optionalCall = getMemberCall(describeCall.callee.object, "optional");
	if (!optionalCall) return null;

	const enumReceiver = getEnumReceiver(optionalCall.callee.object);
	if (enumReceiver) {
		return {
			describeCall,
			optionalCall,
			kind: "aliases",
			receiver: enumReceiver,
		};
	}

	const stringReceiver = getNonemptyStringReceiver(optionalCall.callee.object);
	if (stringReceiver) {
		return {
			describeCall,
			optionalCall,
			kind: "nonempty-string",
			receiver: stringReceiver,
		};
	}

	return {
		describeCall,
		optionalCall,
		kind: "other",
		receiver: null,
	};
}

function buildNonemptyStringSchema(receiver: t.Expression): t.CallExpression {
	const stringCall = t.callExpression(
		t.memberExpression(t.cloneNode(receiver, true), t.identifier("string")),
		[],
	);
	const trimCall = t.callExpression(
		t.memberExpression(stringCall, t.identifier("trim")),
		[],
	);
	return t.callExpression(t.memberExpression(trimCall, t.identifier("min")), [
		t.numericLiteral(1),
	]);
}

/**
 * Identify if a node is a MemberExpression accessing the ".model" property.
 */
function isModelPropertyAccess(node: t.Node): boolean {
	return (
		t.isMemberExpression(node) &&
		!node.computed &&
		getObjectKeyName(node.property as t.Expression | t.Identifier) === "model"
	);
}

/**
 * Check if a node or any of its descendants match a predicate.
 */
function nodeContains(
	node: t.Node | null | undefined,
	predicate: (value: t.Node) => boolean,
): boolean {
	if (!node) return false;
	if (predicate(node)) return true;
	let found = false;
	traverse(
		node,
		{
			enter(path) {
				if (predicate(path.node)) {
					found = true;
					path.stop();
				}
			},
			noScope: true,
		},
		undefined,
		undefined,
	);
	return found;
}

/**
 * Identify if a node is a call to .push() that appears to be pushing a model tag UI element.
 */
function isModelTagPush(node: t.Node): boolean {
	if (!t.isCallExpression(node)) return false;
	if (!t.isMemberExpression(node.callee)) return false;
	if (getObjectKeyName(node.callee.property as any) !== "push") return false;
	if (node.arguments.length === 0) return false;

	const arg = node.arguments[0];
	if (!t.isExpression(arg)) return false;

	// The Agent-era model row is a keyed element whose React key is "model".
	// Under the automatic JSX runtime the key is the third positional argument
	// of the element-factory call: jsx(type, props, "model").
	const hasModelKey = nodeContains(
		arg,
		(n) =>
			isElementCall(n) && t.isStringLiteral(n.arguments[2], { value: "model" }),
	);
	if (!hasModelKey) return false;

	const hasSignal = nodeContains(
		arg,
		(n) =>
			t.isObjectProperty(n) &&
			getObjectKeyName(n.key) === "dimColor" &&
			isTrueLike(n.value),
	);

	return hasSignal;
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
	)
		return false;

	const envObject = node.object;
	if (!t.isMemberExpression(envObject) || envObject.computed) return false;
	if (
		getObjectKeyName(envObject.property as t.Expression | t.Identifier) !==
		"env"
	)
		return false;

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

function testContainsSubagentModelEnvGuard(test: t.Expression): boolean {
	// The mutator emits: (originalTest) && !process.env.CLAUDE_CODE_SUBAGENT_MODEL.
	// Verify must match that exact polarity and combinator. The previous
	// version returned true if the env member appeared anywhere in the test,
	// so `entry.model && process.env.CLAUDE_CODE_SUBAGENT_MODEL` (no `!`)
	// would also pass and incorrectly run the tag despite the env override
	// being set.
	const operands = flattenLogicalAnd(test);
	for (const operand of operands) {
		if (!t.isUnaryExpression(operand, { operator: "!" })) continue;
		if (isProcessEnvMember(operand.argument, "CLAUDE_CODE_SUBAGENT_MODEL")) {
			return true;
		}
	}
	return false;
}

/**
 * Stricter verify-side shape: the mutator emits `(originalTest) &&
 * !process.env.CLAUDE_CODE_SUBAGENT_MODEL`, so the guard is always the right
 * operand of a top-level `&&`. Requiring that position (rather than accepting
 * the guard anywhere among the flattened operands) closes the gap where an
 * unrelated top-level operand could satisfy the looser presence check.
 */
function isRightmostSubagentModelEnvGuard(test: t.Expression): boolean {
	if (!t.isLogicalExpression(test, { operator: "&&" })) return false;
	const right = test.right;
	return (
		t.isUnaryExpression(right, { operator: "!" }) &&
		isProcessEnvMember(right.argument, "CLAUDE_CODE_SUBAGENT_MODEL")
	);
}

function flattenLogicalAnd(node: t.Expression): t.Expression[] {
	if (t.isLogicalExpression(node, { operator: "&&" })) {
		return [...flattenLogicalAnd(node.left), ...flattenLogicalAnd(node.right)];
	}
	return [node];
}

function isCandidate(path: NodePath<t.IfStatement>): boolean {
	// 1. Does the test involve .model?
	if (!nodeContains(path.node.test, isModelPropertyAccess)) return false;

	// 2. Does the body contain a model tag push?
	if (!nodeContains(path.node.consequent, isModelTagPush)) return false;

	return true;
}

type LifecycleSiteState = "patched" | "other";

interface LaunchMetadataCandidate {
	node: t.ObjectExpression;
	modelName: string;
	state: LifecycleSiteState;
}

interface ResumeOptionsCandidate {
	node: t.ObjectExpression;
	metadataName: string;
	functionNode: t.Node;
	state: LifecycleSiteState;
}

interface ResolvedModelCandidate {
	path: NodePath<t.ObjectExpression>;
	modelName: string;
	functionNode: t.Node;
}

interface ResumeLifecycleCandidate {
	options: ResumeOptionsCandidate;
	resolverCall: t.CallExpression;
	resolverState: LifecycleSiteState;
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

function subtreeHasObjectKey(node: t.Node, keyName: string): boolean {
	let found = false;
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

function isVoidZero(node: t.Node | null | undefined): boolean {
	return (
		t.isUnaryExpression(node, { operator: "void" }) &&
		t.isNumericLiteral(node.argument, { value: 0 })
	);
}

function isMetadataPropertyExpression(
	node: t.Node | null | undefined,
	metadataName: string,
	propertyName: string,
): boolean {
	return (
		(t.isOptionalMemberExpression(node) || t.isMemberExpression(node)) &&
		t.isIdentifier(node.object, { name: metadataName }) &&
		getMemberPropertyName(node) === propertyName &&
		(node.optional === true || t.isOptionalMemberExpression(node))
	);
}

function isObserverAwareMetadataModelExpression(
	node: t.Node | null | undefined,
	metadataName: string,
): boolean {
	return (
		t.isConditionalExpression(node) &&
		isMetadataPropertyExpression(node.test, metadataName, "isObserver") &&
		isVoidZero(node.consequent) &&
		isMetadataPropertyExpression(node.alternate, metadataName, "model")
	);
}

function isRawModelMetadataSpread(
	property: t.ObjectExpression["properties"][number],
	modelName: string,
): boolean {
	if (
		!t.isSpreadElement(property) ||
		!t.isLogicalExpression(property.argument, { operator: "&&" })
	) {
		return false;
	}
	const guard = property.argument.left;
	if (!t.isIdentifier(guard, { name: modelName })) {
		return false;
	}
	const payload = property.argument.right;
	if (!t.isObjectExpression(payload) || payload.properties.length !== 1) {
		return false;
	}
	const modelProperty = payload.properties[0];
	return (
		t.isObjectProperty(modelProperty) &&
		getObjectKeyName(modelProperty.key) === "model" &&
		t.isIdentifier(modelProperty.value, { name: modelName })
	);
}

function classifyLaunchMetadataObject(
	path: NodePath<t.ObjectExpression>,
): LaunchMetadataCandidate | null {
	const functionPath = path.getFunctionParent();
	if (!functionPath || !t.isFunction(functionPath.node)) return null;
	const modelName = getObjectPatternBinding(functionPath.node, "model");
	const extraMetadataName = getObjectPatternBinding(
		functionPath.node,
		"extraMetadata",
	);
	if (!modelName || !extraMetadataName) return null;
	if (!getObjectPropertyByName(path.node, "agentType")) return null;
	if (!subtreeHasObjectKey(path.node, "parentAgentId")) return null;
	if (!subtreeHasObjectKey(path.node, "spawnDepth")) return null;
	if (
		!t.isCallExpression(path.parent) ||
		path.parent.arguments[2] !== path.node
	) {
		return null;
	}

	const finalProperty = path.node.properties.at(-1);
	if (
		!t.isSpreadElement(finalProperty) ||
		!t.isIdentifier(finalProperty.argument, { name: extraMetadataName })
	) {
		return null;
	}

	const modelSpreads = path.node.properties.filter((property) =>
		isRawModelMetadataSpread(property, modelName),
	);
	const state: LifecycleSiteState =
		modelSpreads.length === 1 && path.node.properties.at(-2) === modelSpreads[0]
			? "patched"
			: "other";
	return { node: path.node, modelName, state };
}

const RESUME_OPTION_KEYS = [
	"agentDefinition",
	"promptMessages",
	"toolUseContext",
	"canUseTool",
	"isAsync",
	"querySource",
	"spawnedBySkill",
	"model",
	"override",
	"availableTools",
	"forkContextMessages",
	"recordedUuids",
	"worktreePath",
	"worktreeBranch",
	"cwd",
	"spawnMode",
	"description",
	"name",
	"toolUseId",
	"contentReplacementState",
] as const;

function getOptionalMemberBase(
	node: t.Node | null | undefined,
	propertyName: string,
): string | null {
	if (!t.isOptionalMemberExpression(node) && !t.isMemberExpression(node)) {
		return null;
	}
	if (getMemberPropertyName(node) !== propertyName || node.optional !== true) {
		return null;
	}
	return t.isIdentifier(node.object) ? node.object.name : null;
}

function classifyResumeOptionsObject(
	path: NodePath<t.ObjectExpression>,
): ResumeOptionsCandidate | null {
	if (
		!RESUME_OPTION_KEYS.every((key) =>
			Boolean(getObjectPropertyByName(path.node, key)),
		)
	) {
		return null;
	}
	const functionPath = path.getFunctionParent();
	if (!functionPath) return null;

	const metadataNames = [
		"worktreeBranch",
		"cwd",
		"description",
		"name",
		"toolUseId",
	].map((key) => {
		const property = getObjectPropertyByName(path.node, key);
		return getOptionalMemberBase(property?.value as t.Node | undefined, key);
	});
	const metadataName = metadataNames[0];
	if (
		!metadataName ||
		metadataNames.some((candidate) => candidate !== metadataName)
	) {
		return null;
	}

	const modelProperty = getObjectPropertyByName(path.node, "model");
	const state: LifecycleSiteState = isObserverAwareMetadataModelExpression(
		modelProperty?.value as t.Node,
		metadataName,
	)
		? "patched"
		: "other";
	return {
		node: path.node,
		metadataName,
		functionNode: functionPath.node,
		state,
	};
}

const RESOLVED_MODEL_OBJECT_KEYS = [
	"prompt",
	"resolvedAgentModel",
	"isBuiltInAgent",
	"startTime",
	"agentType",
	"isAsync",
	"agentDepth",
	"source",
] as const;

function classifyResolvedModelObject(
	path: NodePath<t.ObjectExpression>,
): ResolvedModelCandidate | null {
	if (
		!RESOLVED_MODEL_OBJECT_KEYS.every((key) =>
			Boolean(getObjectPropertyByName(path.node, key)),
		)
	) {
		return null;
	}
	const modelProperty = getObjectPropertyByName(
		path.node,
		"resolvedAgentModel",
	);
	if (!modelProperty || !t.isIdentifier(modelProperty.value)) return null;
	const functionPath = path.getFunctionParent();
	if (!functionPath) return null;
	return {
		path,
		modelName: modelProperty.value.name,
		functionNode: functionPath.node,
	};
}

function resolveResumeLifecycleCandidates(
	optionsCandidates: ResumeOptionsCandidate[],
	modelCandidates: ResolvedModelCandidate[],
): ResumeLifecycleCandidate[] {
	const resolved: ResumeLifecycleCandidate[] = [];
	for (const options of optionsCandidates) {
		const matchingModels = modelCandidates.filter(
			(candidate) => candidate.functionNode === options.functionNode,
		);
		if (matchingModels.length !== 1) continue;
		const modelCandidate = matchingModels[0];
		const binding = modelCandidate.path.scope.getBinding(
			modelCandidate.modelName,
		);
		if (!binding || !t.isVariableDeclarator(binding.path.node)) continue;
		const initializer = binding.path.node.init;
		if (!t.isCallExpression(initializer) || initializer.arguments.length < 4) {
			continue;
		}
		const override = initializer.arguments[2];
		const resolverState: LifecycleSiteState =
			isObserverAwareMetadataModelExpression(
				override as t.Node,
				options.metadataName,
			)
				? "patched"
				: "other";
		resolved.push({ options, resolverCall: initializer, resolverState });
	}
	return resolved;
}

function createSubagentModelPasses(): PatchAstPass[] {
	const candidates: NodePath<t.IfStatement>[] = [];
	const schemaCandidates: AgentModelSchemaShape[] = [];
	const launchMetadataCandidates: LaunchMetadataCandidate[] = [];
	const resumeOptionsCandidates: ResumeOptionsCandidate[] = [];
	const resolvedModelCandidates: ResolvedModelCandidate[] = [];
	let guardedCount = 0;
	let uiPatched = false;
	let schemaPatched = false;
	let lifecyclePatched = false;

	return [
		{
			pass: "discover",
			visitor: {
				IfStatement(path) {
					if (!isCandidate(path)) return;

					const isGuarded = testContainsSubagentModelEnvGuard(path.node.test);

					if (isGuarded) {
						guardedCount++;
					} else {
						candidates.push(path);
					}
				},
				ObjectExpression(path) {
					if (isAgentInputSchemaObject(path.node)) {
						const shape = getAgentModelSchemaShape(path.node);
						if (shape) schemaCandidates.push(shape);
					}
					const launchMetadata = classifyLaunchMetadataObject(path);
					if (launchMetadata) launchMetadataCandidates.push(launchMetadata);
					const resumeOptions = classifyResumeOptionsObject(path);
					if (resumeOptions) resumeOptionsCandidates.push(resumeOptions);
					const resolvedModel = classifyResolvedModelObject(path);
					if (resolvedModel) resolvedModelCandidates.push(resolvedModel);
				},
			},
		},
		{
			pass: "mutate",
			visitor: {
				Program: {
					exit() {
						if (guardedCount === 1 && candidates.length === 0) {
							uiPatched = true;
						} else if (candidates.length === 1 && guardedCount === 0) {
							const candidate = candidates[0];
							candidate.node.test = t.logicalExpression(
								"&&",
								t.cloneNode(candidate.node.test),
								t.unaryExpression("!", envMember("CLAUDE_CODE_SUBAGENT_MODEL")),
							);
							uiPatched = true;
						}

						if (schemaCandidates.length === 1) {
							const schema = schemaCandidates[0];
							if (schema.kind === "aliases" && schema.receiver) {
								schema.optionalCall.callee.object = buildNonemptyStringSchema(
									schema.receiver,
								);
								schema.kind = "nonempty-string";
							}
							if (schema.kind === "nonempty-string") {
								schema.describeCall.arguments = [
									t.stringLiteral(AGENT_MODEL_DESCRIPTION),
								];
								schemaPatched = true;
							}
						}

						const resumeCandidates = resolveResumeLifecycleCandidates(
							resumeOptionsCandidates,
							resolvedModelCandidates,
						);
						if (
							launchMetadataCandidates.length === 1 &&
							resumeOptionsCandidates.length === 1 &&
							resumeCandidates.length === 1
						) {
							const launch = launchMetadataCandidates[0];
							const resume = resumeCandidates[0];
							if (
								launch.state === "patched" &&
								resume.options.state === "patched" &&
								resume.resolverState === "patched"
							) {
								lifecyclePatched = true;
							}
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
						if (!uiPatched) {
							const total = guardedCount + candidates.length;
							if (total > 1) {
								console.warn(
									`Subagent model tag: Ambiguous Agent model tag branches (${total} candidates); refusing to patch`,
								);
							} else if (total === 0) {
								console.warn(
									"Subagent model tag: Could not find unique Agent model tag branch to patch",
								);
							}
						}

						if (!schemaPatched) {
							if (schemaCandidates.length > 1) {
								console.warn(
									`Subagent model tag: Ambiguous Agent input schemas (${schemaCandidates.length} candidates); refusing to patch`,
								);
							} else if (schemaCandidates.length === 0) {
								console.warn(
									"Subagent model tag: Could not find unique Agent input schema to patch",
								);
							}
						}

						if (!lifecyclePatched) {
							console.warn(
								`Subagent model tag: Could not resolve unique child model lifecycle sites (launch metadata: ${launchMetadataCandidates.length}, resume options: ${resumeOptionsCandidates.length})`,
							);
						}
					},
				},
			},
		},
	];
}

/**
 * Let Agent-tool calls select aliases or full provider model IDs, while hiding
 * redundant row tags when CLAUDE_CODE_SUBAGENT_MODEL forces one global model.
 */
export const subagentModelTag: Patch = {
	tag: "subagent-model-tag",

	astPasses: () => createSubagentModelPasses(),

	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst)
			return "Unable to parse AST during subagent-model-tag verification";

		let patchedCount = 0;
		let unpatchedCount = 0;
		// Patched branches whose guard sits in the exact position the mutator
		// emits it (rightmost operand of a top-level &&), distinguishing a real
		// mutation from a guard that merely appears somewhere in the test.
		let rightShapeCount = 0;
		let agentSchemaCount = 0;
		const agentModelSchemas: AgentModelSchemaShape[] = [];
		const launchMetadataCandidates: LaunchMetadataCandidate[] = [];
		const resumeOptionsCandidates: ResumeOptionsCandidate[] = [];
		const resolvedModelCandidates: ResolvedModelCandidate[] = [];

		traverse(verifyAst, {
			IfStatement(path) {
				if (!isCandidate(path)) return;

				const isGuarded = testContainsSubagentModelEnvGuard(path.node.test);
				if (isGuarded) {
					patchedCount++;
					if (isRightmostSubagentModelEnvGuard(path.node.test)) {
						rightShapeCount++;
					}
				} else {
					unpatchedCount++;
				}
			},
			ObjectExpression(path) {
				if (isAgentInputSchemaObject(path.node)) {
					agentSchemaCount++;
					const shape = getAgentModelSchemaShape(path.node);
					if (shape) agentModelSchemas.push(shape);
				}
				const launchMetadata = classifyLaunchMetadataObject(path);
				if (launchMetadata) launchMetadataCandidates.push(launchMetadata);
				const resumeOptions = classifyResumeOptionsObject(path);
				if (resumeOptions) resumeOptionsCandidates.push(resumeOptions);
				const resolvedModel = classifyResolvedModelObject(path);
				if (resolvedModel) resolvedModelCandidates.push(resolvedModel);
			},
		});

		const total = patchedCount + unpatchedCount;
		if (total === 0) {
			return "Agent model tag branch not found";
		}
		if (total > 1) {
			return `Agent model tag branch is ambiguous (${total} branches found)`;
		}
		if (patchedCount === 0) {
			return "Agent model tag branch found but not patched";
		}
		if (rightShapeCount !== 1) {
			return "Agent model tag guard is not in the expected position";
		}
		if (agentSchemaCount === 0) {
			return "Agent input schema not found";
		}
		if (agentSchemaCount > 1) {
			return `Agent input schema is ambiguous (${agentSchemaCount} schemas found)`;
		}
		const agentModelSchema = agentModelSchemas[0];
		if (!agentModelSchema) {
			return "Agent model schema shape was not recognized";
		}
		if (agentModelSchema.kind === "aliases") {
			return "Agent model schema still limits overrides to built-in aliases";
		}
		if (agentModelSchema.kind !== "nonempty-string") {
			return "Agent model schema does not accept a nonempty string";
		}
		if (
			getStaticString(
				agentModelSchema.describeCall.arguments[0] as t.Node | undefined,
			) !== AGENT_MODEL_DESCRIPTION
		) {
			return "Agent model schema guidance does not advertise full model IDs";
		}
		if (launchMetadataCandidates.length !== 1) {
			return `Agent launch model metadata is ambiguous or missing (${launchMetadataCandidates.length} sites found)`;
		}
		if (launchMetadataCandidates[0].state !== "patched") {
			return "Agent launch metadata does not persist the raw model override";
		}
		if (resumeOptionsCandidates.length !== 1) {
			return `Agent resume options are ambiguous or missing (${resumeOptionsCandidates.length} sites found)`;
		}
		const resumeCandidates = resolveResumeLifecycleCandidates(
			resumeOptionsCandidates,
			resolvedModelCandidates,
		);
		if (resumeCandidates.length !== 1) {
			return `Agent resume model resolution is ambiguous or missing (${resumeCandidates.length} sites found)`;
		}
		const resume = resumeCandidates[0];
		if (resume.options.state !== "patched") {
			return "Agent resume options do not restore the persisted model override";
		}
		if (resume.resolverState !== "patched") {
			return "Agent resume resolution does not use the persisted model override";
		}
		return true;
	},
};
