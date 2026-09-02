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
const AGENT_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
const AGENT_EFFORT_BINDING = "__claudeCodeAgentEffortOverride";
const AGENT_TYPE = "The type of specialized agent to use for this task";
const AGENT_MODEL_DESCRIPTION =
	'Optional model override for this agent. Accepts a built-in model alias (for example, "fable", "opus", "sonnet", or "haiku"), "inherit", or a full model ID available through /model and exposed by the active provider. Takes precedence over the agent definition\'s model frontmatter. If omitted, uses the agent definition\'s model or inherits from the parent; "inherit" always uses the parent model. Ignored for subagent_type: "fork"; forks always inherit the parent model.';
const AGENT_EFFORT_DESCRIPTION =
	'Optional effort override for this agent. Accepts "low", "medium", "high", "xhigh", or "max" and takes precedence over the selected agent definition\'s effort without changing its subagent_type, prompt, tools, or permissions. If omitted, preserves the selected definition\'s effort or normal inheritance. Ignored for subagent_type: "fork"; forks always inherit the parent effort.';

type MemberCall = t.CallExpression & { callee: t.MemberExpression };

interface AgentModelSchemaShape {
	object: t.ObjectExpression;
	describeCall: MemberCall;
	optionalCall: MemberCall;
	kind: "aliases" | "nonempty-string" | "other";
	receiver: t.Expression | null;
}

interface AgentEffortSchemaShape {
	describeCall: MemberCall;
	optionalCall: MemberCall;
	kind: "named-levels" | "other";
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
	const argument = describeCall?.arguments[0] as t.Node | undefined;
	const direct = getStaticString(argument);
	if (direct !== null) return direct;
	if (!argument) return null;
	const fragments: string[] = [];
	t.traverseFast(argument, (node) => {
		const value = getStaticString(node);
		if (value !== null) fragments.push(value);
	});
	return fragments.length > 0 ? fragments.join(" ") : null;
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
		getObjectPropertyByName(node, "description") !== null &&
		getObjectPropertyByName(node, "prompt") !== null &&
		isDescribedWith(node, "subagent_type", AGENT_TYPE) &&
		isAgentModelDescription(getPropertyDescription(node, "model")) &&
		getObjectPropertyByName(node, "run_in_background") !== null
	);
}

function isAliasEnumSchema(node: t.Node): boolean {
	if (!t.isCallExpression(node) || node.arguments.length !== 1) return false;
	const values = node.arguments[0];
	if (!t.isArrayExpression(values)) return false;
	// Recognize the built-in alias enum as a superset: every known alias must be
	// present, but the enum may also carry additional aliases the mutator will
	// discard when it widens the field to a full-ID string. Requiring exact
	// membership would let a routine upstream model addition block the widening.
	const present = new Set(
		values.elements
			.filter((element): element is t.StringLiteral =>
				t.isStringLiteral(element),
			)
			.map((element) => element.value),
	);
	return BUILTIN_MODEL_ALIASES.every((alias) => present.has(alias));
}

function getDescribedStringFactory(
	object: t.ObjectExpression,
): t.Expression | null {
	const descriptionProperty = getObjectPropertyByName(object, "description");
	if (!descriptionProperty) return null;
	const describeCall = getMemberCall(descriptionProperty.value, "describe");
	if (!describeCall) return null;
	const schemaCall = describeCall.callee.object;
	if (!t.isCallExpression(schemaCall) || schemaCall.arguments.length !== 0) {
		return null;
	}
	return t.isExpression(schemaCall.callee) ? schemaCall.callee : null;
}

function getNonemptyStringFactory(node: t.Node): t.Expression | null {
	const minCall = getMemberCall(node, "min");
	if (
		minCall?.arguments.length !== 1 ||
		!t.isNumericLiteral(minCall.arguments[0], { value: 1 })
	) {
		return null;
	}
	const trimCall = getMemberCall(minCall.callee.object, "trim");
	if (trimCall?.arguments.length !== 0) return null;
	const stringCall = trimCall.callee.object;
	if (!t.isCallExpression(stringCall) || stringCall.arguments.length !== 0) {
		return null;
	}
	return t.isExpression(stringCall.callee) ? stringCall.callee : null;
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
	const stringFactory = getDescribedStringFactory(object);
	if (!stringFactory) return null;

	if (isAliasEnumSchema(optionalCall.callee.object)) {
		return {
			object,
			describeCall,
			optionalCall,
			kind: "aliases",
			receiver: stringFactory,
		};
	}

	const patchedStringFactory = getNonemptyStringFactory(
		optionalCall.callee.object,
	);
	if (
		patchedStringFactory &&
		t.isNodesEquivalent(patchedStringFactory, stringFactory)
	) {
		return {
			object,
			describeCall,
			optionalCall,
			kind: "nonempty-string",
			receiver: stringFactory,
		};
	}

	return {
		object,
		describeCall,
		optionalCall,
		kind: "other",
		receiver: null,
	};
}

function getStringEnumValues(node: t.Node): string[] | null {
	if (!t.isCallExpression(node) || node.arguments.length !== 1) return null;
	const values = node.arguments[0];
	if (!t.isArrayExpression(values)) return null;
	const result: string[] = [];
	for (const element of values.elements) {
		if (!t.isStringLiteral(element)) return null;
		result.push(element.value);
	}
	return result;
}

function getAgentEffortSchemaShape(
	object: t.ObjectExpression,
): AgentEffortSchemaShape | null {
	const effortProperty = getObjectPropertyByName(object, "effort");
	if (!effortProperty) return null;
	const describeCall = getMemberCall(effortProperty.value, "describe");
	if (!describeCall) return null;
	const optionalCall = getMemberCall(describeCall.callee.object, "optional");
	if (!optionalCall) return null;
	const values = getStringEnumValues(optionalCall.callee.object);
	const kind =
		values?.length === AGENT_EFFORT_LEVELS.length &&
		AGENT_EFFORT_LEVELS.every((level, index) => values[index] === level)
			? "named-levels"
			: "other";
	return { describeCall, optionalCall, kind };
}

function buildAgentEffortSchema(
	modelSchema: AgentModelSchemaShape,
): t.CallExpression | null {
	const modelEnum = modelSchema.optionalCall.callee.object;
	if (!t.isCallExpression(modelEnum) || !t.isExpression(modelEnum.callee)) {
		return null;
	}
	const effortEnum = t.callExpression(t.cloneNode(modelEnum.callee, true), [
		t.arrayExpression(
			AGENT_EFFORT_LEVELS.map((level) => t.stringLiteral(level)),
		),
	]);
	const optional = t.callExpression(
		t.memberExpression(effortEnum, t.identifier("optional")),
		[],
	);
	return t.callExpression(
		t.memberExpression(optional, t.identifier("describe")),
		[t.stringLiteral(AGENT_EFFORT_DESCRIPTION)],
	);
}

function insertObjectPropertyAfter(
	object: t.ObjectExpression,
	afterName: string,
	property: t.ObjectProperty,
): boolean {
	const index = object.properties.findIndex(
		(candidate) =>
			t.isObjectProperty(candidate) &&
			getObjectKeyName(candidate.key) === afterName,
	);
	if (index < 0) return false;
	object.properties.splice(index + 1, 0, property);
	return true;
}

function buildNonemptyStringSchema(receiver: t.Expression): t.CallExpression {
	const stringCall = t.callExpression(t.cloneNode(receiver, true), []);
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
	t.traverseFast(node, (child) => {
		if (!found && predicate(child)) found = true;
	});
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

type PatchSiteState = "patched" | "unpatched" | "other";

interface ForkResolutionCandidate {
	path: NodePath<t.VariableDeclarator>;
	forkName: string;
	parentModelName: string;
	resolverCall: t.CallExpression;
	state: PatchSiteState;
}

function hasResolvedAgentModelReference(
	path: NodePath<t.VariableDeclarator>,
): boolean {
	if (!t.isIdentifier(path.node.id)) return false;
	const binding = path.scope.getBinding(path.node.id.name);
	return (
		binding?.referencePaths.some((reference) => {
			const parent = reference.parent;
			return (
				t.isObjectProperty(parent) &&
				parent.value === reference.node &&
				getObjectKeyName(parent.key) === "resolvedAgentModel"
			);
		}) ?? false
	);
}

function getResolverParentModelName(call: t.CallExpression): string | null {
	const parentModel = call.arguments[1];
	if (!t.isIdentifier(parentModel)) return null;
	const definitionModel = call.arguments[0];
	if (
		!t.isCallExpression(definitionModel) ||
		definitionModel.arguments.length < 2 ||
		!t.isIdentifier(definitionModel.arguments[1], {
			name: parentModel.name,
		})
	) {
		return null;
	}
	return parentModel.name;
}

function getForkLaunchCallShape(
	path: NodePath<t.VariableDeclarator>,
	call: t.CallExpression,
): {
	forkName: string;
	parentModelName: string;
} | null {
	if (call.arguments.length < 4) return null;
	const parentModelName = getResolverParentModelName(call);
	const rawOverride = call.arguments[2];
	let override: t.Node | null = t.isNode(rawOverride) ? rawOverride : null;
	if (t.isIdentifier(override)) {
		const binding = path.scope.getBinding(override.name);
		if (
			binding &&
			t.isVariableDeclarator(binding.path.node) &&
			t.isExpression(binding.path.node.init)
		) {
			override = binding.path.node.init;
		}
	}
	if (
		!parentModelName ||
		!t.isConditionalExpression(override) ||
		!t.isIdentifier(override.test) ||
		!t.isStringLiteral(override.consequent, { value: "inherit" }) ||
		!t.isIdentifier(override.alternate)
	) {
		return null;
	}
	return { forkName: override.test.name, parentModelName };
}

function classifyForkLaunchResolution(
	path: NodePath<t.VariableDeclarator>,
): ForkResolutionCandidate | null {
	const initializer = path.node.init;
	if (!t.isCallExpression(initializer)) return null;
	const shape = getForkLaunchCallShape(path, initializer);
	if (!shape || !hasResolvedAgentModelReference(path)) return null;
	return { path, resolverCall: initializer, state: "patched", ...shape };
}

/**
 * Follow a single alias-wrapper indirection on the selected-agent binding.
 * A resume-time wrapper can re-expose the selected agent unchanged apart from
 * extra fields spread over it: `wrapped = cond ? { ...selected, extra } :
 * selected`. The fork flag lives on `selected`'s own binding, so when the init
 * matches that alias shape (the alternate is an identifier that the consequent
 * object also spreads), return that identifier's initializer. Otherwise return
 * the init unchanged. Anchors on the alias identity, never on the names of the
 * extra fields the wrapper adds.
 */
function unwrapSelectedAgentAlias(
	init: t.Expression | null | undefined,
	path: NodePath<t.VariableDeclarator>,
): t.Expression | null | undefined {
	if (
		!t.isConditionalExpression(init) ||
		!t.isIdentifier(init.alternate) ||
		!t.isObjectExpression(init.consequent)
	) {
		return init;
	}
	const aliasName = init.alternate.name;
	const spreadsAlias = init.consequent.properties.some(
		(property) =>
			t.isSpreadElement(property) &&
			t.isIdentifier(property.argument, { name: aliasName }),
	);
	if (!spreadsAlias) return init;
	const aliasBinding = path.scope.getBinding(aliasName);
	if (!aliasBinding || !t.isVariableDeclarator(aliasBinding.path.node)) {
		return init;
	}
	return aliasBinding.path.node.init;
}

function getSelectedAgentForkName(
	path: NodePath<t.VariableDeclarator>,
	selectedAgentName: string,
): string | null {
	const binding = path.scope.getBinding(selectedAgentName);
	if (!binding || !t.isVariableDeclarator(binding.path.node)) return null;
	const initializer = unwrapSelectedAgentAlias(binding.path.node.init, path);
	if (!initializer) return null;
	const forkNames: string[] = [];
	const collectForkFallback = (node: t.Node): void => {
		if (
			t.isLogicalExpression(node, { operator: "??" }) &&
			t.isIdentifier(node.left) &&
			t.isConditionalExpression(node.right) &&
			t.isIdentifier(node.right.test) &&
			t.isIdentifier(node.right.consequent) &&
			t.isIdentifier(node.right.alternate)
		) {
			forkNames.push(node.right.test.name);
		}
	};
	collectForkFallback(initializer);
	t.traverseFast(initializer, collectForkFallback);
	return forkNames.length === 1 ? forkNames[0] : null;
}

function getForkResumeCallShape(
	path: NodePath<t.VariableDeclarator>,
	call: t.CallExpression,
): { forkName: string; parentModelName: string } | null {
	if (call.arguments.length < 4) return null;
	const parentModelName = getResolverParentModelName(call);
	const definitionModel = call.arguments[0];
	const override = call.arguments[2];
	if (
		!parentModelName ||
		!t.isCallExpression(definitionModel) ||
		!t.isIdentifier(definitionModel.arguments[0]) ||
		!t.isConditionalExpression(override) ||
		!isMetadataPropertyExpression(
			override.test,
			getOptionalMemberBase(override.test, "isObserver") ?? "",
			"isObserver",
		) ||
		!isVoidZero(override.consequent)
	) {
		return null;
	}
	const forkName = getSelectedAgentForkName(
		path,
		definitionModel.arguments[0].name,
	);
	return forkName ? { forkName, parentModelName } : null;
}

function classifyForkResumeResolution(
	path: NodePath<t.VariableDeclarator>,
): ForkResolutionCandidate | null {
	const initializer = path.node.init;
	if (t.isCallExpression(initializer)) {
		const shape = getForkResumeCallShape(path, initializer);
		if (!shape || !hasResolvedAgentModelReference(path)) return null;
		return { path, resolverCall: initializer, state: "unpatched", ...shape };
	}
	if (
		!t.isConditionalExpression(initializer) ||
		!t.isIdentifier(initializer.test) ||
		!t.isIdentifier(initializer.consequent) ||
		!t.isCallExpression(initializer.alternate)
	) {
		return null;
	}
	const shape = getForkResumeCallShape(path, initializer.alternate);
	if (!shape || !hasResolvedAgentModelReference(path)) return null;
	const state: PatchSiteState =
		initializer.test.name === shape.forkName &&
		initializer.consequent.name === shape.parentModelName
			? "patched"
			: "other";
	return { path, resolverCall: initializer.alternate, state, ...shape };
}

function applyForkInheritance(candidate: ForkResolutionCandidate): void {
	if (candidate.state !== "unpatched") return;
	candidate.path.node.init = t.conditionalExpression(
		t.identifier(candidate.forkName),
		t.identifier(candidate.parentModelName),
		candidate.resolverCall,
	);
	candidate.state = "patched";
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
	path: NodePath<t.ObjectExpression>;
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
		t.isIdentifier(node, { name: "undefined" }) ||
		(t.isUnaryExpression(node, { operator: "void" }) &&
			t.isNumericLiteral(node.argument, { value: 0 }))
	);
}

function isMetadataPropertyExpression(
	node: t.Node | null | undefined,
	metadataName: string,
	propertyName: string,
): boolean {
	// Only OptionalMemberExpression carries optional-chain semantics; a plain
	// MemberExpression is never an optional read.
	return (
		t.isOptionalMemberExpression(node) &&
		t.isIdentifier(node.object, { name: metadataName }) &&
		getMemberPropertyName(node) === propertyName
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
	if (!t.isOptionalMemberExpression(node)) {
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
		path,
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
		const resolverCall = t.isCallExpression(initializer)
			? initializer
			: t.isConditionalExpression(initializer) &&
					t.isCallExpression(initializer.alternate)
				? initializer.alternate
				: null;
		if (!resolverCall || resolverCall.arguments.length < 4) {
			continue;
		}
		const override = resolverCall.arguments[2];
		const resolverState: LifecycleSiteState =
			isObserverAwareMetadataModelExpression(
				override as t.Node,
				options.metadataName,
			)
				? "patched"
				: "other";
		resolved.push({ options, resolverCall, resolverState });
	}
	return resolved;
}

const AGENT_CALL_INPUT_KEYS = [
	"prompt",
	"subagent_type",
	"description",
	"model",
	"run_in_background",
	"name",
	"isolation",
	"cwd",
] as const;

const AGENT_LAUNCH_OPTION_KEYS = [
	"agentDefinition",
	"promptMessages",
	"toolUseContext",
	"canUseTool",
	"isAsync",
	"querySource",
	"model",
	"override",
	"availableTools",
	"description",
] as const;

const REMOTE_AGENT_REQUEST_KEYS = [
	"initialMessage",
	"source",
	"model",
	"branchName",
	"signal",
	"storageV5",
	"credentials",
] as const;

const TEAMMATE_LAUNCH_INPUT_KEYS = [
	"name",
	"prompt",
	"description",
	"use_splitpane",
	"plan_mode_required",
	"model",
	"agent_type",
	"invokingRequestId",
] as const;

const TEAMMATE_SESSION_OPTION_KEYS = [
	"planModeRequired",
	"permissionMode",
	"proactivityLevel",
	"sessionEffort",
	"skipModel",
] as const;

interface AgentCallCandidate {
	path: NodePath<t.ObjectMethod>;
	input: t.ObjectPattern;
}

interface AgentLaunchOptionsCandidate {
	node: t.ObjectExpression;
	functionNode: t.Node;
	selectedAgentName: string;
}

interface RemoteAgentRequestCandidate {
	node: t.ObjectExpression;
	functionNode: t.Node;
}

interface MetadataMirrorCandidate {
	node: t.ObjectExpression;
	metadataName: string;
}

interface TeammateLaunchInputCandidate {
	node: t.ObjectExpression;
	functionNode: t.Node;
}

interface TeammateSessionOptionsCandidate {
	node: t.ObjectExpression;
	inputName: string;
}

function getObjectPatternProperty(
	pattern: t.ObjectPattern,
	propertyName: string,
): t.ObjectProperty | null {
	for (const property of pattern.properties) {
		if (
			t.isObjectProperty(property) &&
			getObjectKeyName(property.key) === propertyName
		) {
			return property;
		}
	}
	return null;
}

function getPatternBindingName(
	pattern: t.ObjectPattern,
	propertyName: string,
): string | null {
	const property = getObjectPatternProperty(pattern, propertyName);
	return property && t.isIdentifier(property.value)
		? property.value.name
		: null;
}

function classifyAgentCall(
	path: NodePath<t.ObjectMethod>,
): AgentCallCandidate | null {
	if (getObjectKeyName(path.node.key) !== "call" || !path.node.async)
		return null;
	const input = path.node.params[0];
	if (!t.isObjectPattern(input)) return null;
	if (
		!AGENT_CALL_INPUT_KEYS.every((key) => getObjectPatternProperty(input, key))
	) {
		return null;
	}
	return { path, input };
}

function classifyAgentLaunchOptions(
	path: NodePath<t.ObjectExpression>,
): AgentLaunchOptionsCandidate | null {
	if (
		!AGENT_LAUNCH_OPTION_KEYS.every((key) =>
			Boolean(getObjectPropertyByName(path.node, key)),
		)
	) {
		return null;
	}
	const definition = getObjectPropertyByName(path.node, "agentDefinition");
	if (!definition || !t.isIdentifier(definition.value)) return null;
	const functionPath = path.getFunctionParent();
	if (!functionPath) return null;
	return {
		node: path.node,
		functionNode: functionPath.node,
		selectedAgentName: definition.value.name,
	};
}

function classifyRemoteAgentRequest(
	path: NodePath<t.ObjectExpression>,
): RemoteAgentRequestCandidate | null {
	if (
		!REMOTE_AGENT_REQUEST_KEYS.every((key) =>
			Boolean(getObjectPropertyByName(path.node, key)),
		)
	) {
		return null;
	}
	const source = getObjectPropertyByName(path.node, "source");
	if (getStaticString(source?.value as t.Node | undefined) !== "remote_agent") {
		return null;
	}
	const functionPath = path.getFunctionParent();
	if (!functionPath) return null;
	return { node: path.node, functionNode: functionPath.node };
}

function classifyTeammateLaunchInput(
	path: NodePath<t.ObjectExpression>,
): TeammateLaunchInputCandidate | null {
	if (
		!TEAMMATE_LAUNCH_INPUT_KEYS.every((key) =>
			Boolean(getObjectPropertyByName(path.node, key)),
		)
	) {
		return null;
	}
	const functionPath = path.getFunctionParent();
	if (!functionPath) return null;
	return { node: path.node, functionNode: functionPath.node };
}

function classifyTeammateSessionOptions(
	path: NodePath<t.ObjectExpression>,
): TeammateSessionOptionsCandidate | null {
	if (
		!TEAMMATE_SESSION_OPTION_KEYS.every((key) =>
			Boolean(getObjectPropertyByName(path.node, key)),
		)
	) {
		return null;
	}
	let current: NodePath | null = path.parentPath;
	while (current) {
		if (t.isFunction(current.node)) {
			const input = current.node.params[0];
			if (t.isIdentifier(input)) {
				return { node: path.node, inputName: input.name };
			}
		}
		current = current.parentPath;
	}
	return null;
}

function getMemberBaseName(
	node: t.Node | null | undefined,
	propertyName: string,
): string | null {
	if (
		!t.isMemberExpression(node) ||
		getMemberPropertyName(node) !== propertyName ||
		!t.isIdentifier(node.object)
	) {
		return null;
	}
	return node.object.name;
}

function classifyMetadataMirror(
	path: NodePath<t.ObjectExpression>,
): MetadataMirrorCandidate | null {
	const typeProperty = getObjectPropertyByName(path.node, "type");
	const agentTypeProperty = getObjectPropertyByName(path.node, "agentType");
	if (
		getStaticString(typeProperty?.value as t.Node | undefined) !==
			"agent_metadata" ||
		!agentTypeProperty
	) {
		return null;
	}
	const metadataName = getMemberBaseName(agentTypeProperty.value, "agentType");
	if (!metadataName) return null;
	const hasModel = path.node.properties.some(
		(property) =>
			t.isSpreadElement(property) &&
			nodeContains(property.argument, (node) => {
				return getMemberBaseName(node, "model") === metadataName;
			}),
	);
	const hasPermissionMode = path.node.properties.some(
		(property) =>
			t.isSpreadElement(property) &&
			nodeContains(property.argument, (node) => {
				return getMemberBaseName(node, "permissionMode") === metadataName;
			}),
	);
	return hasModel && hasPermissionMode
		? { node: path.node, metadataName }
		: null;
}

function getResolverSelectedAgentName(call: t.CallExpression): string | null {
	const definitionModel = call.arguments[0];
	if (
		!t.isCallExpression(definitionModel) ||
		!t.isIdentifier(definitionModel.arguments[0])
	) {
		return null;
	}
	return definitionModel.arguments[0].name;
}

function buildVoidZero(): t.UnaryExpression {
	return t.unaryExpression("void", t.numericLiteral(0));
}

function buildOptionalMember(
	objectName: string,
	propertyName: string,
): t.OptionalMemberExpression {
	return t.optionalMemberExpression(
		t.identifier(objectName),
		t.identifier(propertyName),
		false,
		true,
	);
}

function isIdentifierNotVoid(
	node: t.Node | null | undefined,
	identifierName: string,
): boolean {
	return (
		t.isBinaryExpression(node, { operator: "!==" }) &&
		t.isIdentifier(node.left, { name: identifierName }) &&
		isVoidZero(node.right)
	);
}

function isNonForkEffortCondition(
	node: t.Node | null | undefined,
	forkName: string,
	effortName: string,
): boolean {
	return (
		t.isLogicalExpression(node, { operator: "&&" }) &&
		t.isUnaryExpression(node.left, { operator: "!" }) &&
		t.isIdentifier(node.left.argument, { name: forkName }) &&
		isIdentifierNotVoid(node.right, effortName)
	);
}

function isSelectedAgentEffortObject(
	node: t.Node | null | undefined,
	selectedAgentName: string,
	effortValue: (node: t.Node) => boolean,
): boolean {
	if (!t.isObjectExpression(node)) return false;
	const spreadCount = node.properties.filter(
		(property) =>
			t.isSpreadElement(property) &&
			t.isIdentifier(property.argument, { name: selectedAgentName }),
	).length;
	const effortProperties = node.properties.filter(
		(property): property is t.ObjectProperty =>
			t.isObjectProperty(property) &&
			getObjectKeyName(property.key) === "effort",
	);
	return (
		spreadCount === 1 &&
		effortProperties.length === 1 &&
		effortValue(effortProperties[0].value)
	);
}

function isAgentEffortOverrideStatement(
	node: t.Node,
	forkName: string,
	effortName: string,
	selectedAgentName: string,
): boolean {
	if (!t.isIfStatement(node)) return false;
	if (!isNonForkEffortCondition(node.test, forkName, effortName)) return false;
	const statements = t.isBlockStatement(node.consequent)
		? node.consequent.body
		: [node.consequent];
	if (statements.length !== 1 || !t.isExpressionStatement(statements[0])) {
		return false;
	}
	const assignment = statements[0].expression;
	return (
		t.isAssignmentExpression(assignment, { operator: "=" }) &&
		t.isIdentifier(assignment.left, { name: selectedAgentName }) &&
		isSelectedAgentEffortObject(assignment.right, selectedAgentName, (value) =>
			t.isIdentifier(value, { name: effortName }),
		)
	);
}

function buildAgentEffortOverrideStatement(
	forkName: string,
	effortName: string,
	selectedAgentName: string,
): t.IfStatement {
	return t.ifStatement(
		t.logicalExpression(
			"&&",
			t.unaryExpression("!", t.identifier(forkName)),
			t.binaryExpression("!==", t.identifier(effortName), buildVoidZero()),
		),
		t.blockStatement([
			t.expressionStatement(
				t.assignmentExpression(
					"=",
					t.identifier(selectedAgentName),
					t.objectExpression([
						t.spreadElement(t.identifier(selectedAgentName)),
						t.objectProperty(t.identifier("effort"), t.identifier(effortName)),
					]),
				),
			),
		]),
	);
}

function isExtraMetadataEffortExpression(
	node: t.Node | null | undefined,
	forkName: string,
	effortName: string,
): boolean {
	if (
		!t.isConditionalExpression(node) ||
		!isNonForkEffortCondition(node.test, forkName, effortName) ||
		!isVoidZero(node.alternate) ||
		!t.isObjectExpression(node.consequent)
	) {
		return false;
	}
	const effort = getObjectPropertyByName(node.consequent, "effort");
	return (
		node.consequent.properties.length === 1 &&
		effort !== null &&
		t.isIdentifier(effort.value, { name: effortName })
	);
}

function isSelectedAgentEffortMember(
	node: t.Node | null | undefined,
	selectedAgentName: string,
): boolean {
	return (
		t.isMemberExpression(node) &&
		t.isIdentifier(node.object, { name: selectedAgentName }) &&
		getMemberPropertyName(node) === "effort"
	);
}

function isInputEffortMember(
	node: t.Node | null | undefined,
	inputName: string,
): boolean {
	return getMemberBaseName(node, "effort") === inputName;
}

function isTeammateSessionEffortExpression(
	node: t.Node | null | undefined,
	inputName: string,
): boolean {
	if (
		!t.isConditionalExpression(node) ||
		!t.isBinaryExpression(node.test, { operator: "!==" }) ||
		!isInputEffortMember(node.test.left, inputName) ||
		!isVoidZero(node.test.right) ||
		!t.isObjectExpression(node.consequent)
	) {
		return false;
	}
	const kind = getObjectPropertyByName(node.consequent, "kind");
	const value = getObjectPropertyByName(node.consequent, "value");
	return (
		node.consequent.properties.length === 2 &&
		getStaticString(kind?.value as t.Node | undefined) === "level" &&
		value !== null &&
		isInputEffortMember(value.value, inputName) &&
		getMemberBaseName(node.alternate, "sessionEffort") !== null
	);
}

function patchTeammateEffort(
	call: AgentCallCandidate,
	launchInputs: TeammateLaunchInputCandidate[],
	sessionOptions: TeammateSessionOptionsCandidate[],
	effortName: string,
): boolean {
	const matchingLaunches = launchInputs.filter(
		(candidate) => candidate.functionNode === call.path.node,
	);
	if (
		matchingLaunches.length !== 1 ||
		(sessionOptions.length !== 0 && sessionOptions.length !== 2)
	) {
		return false;
	}
	const launch = matchingLaunches[0].node;
	const subagentTypeName = getPatternBindingName(call.input, "subagent_type");
	const agentType = getObjectPropertyByName(launch, "agent_type");
	if (
		!subagentTypeName ||
		!agentType ||
		countMatchingNodes(agentType.value, (node) =>
			t.isIdentifier(node, { name: subagentTypeName }),
		) !== 1
	) {
		return false;
	}
	let launchEffort = getObjectPropertyByName(launch, "effort");
	if (!launchEffort) {
		if (
			!insertObjectPropertyAfter(
				launch,
				"model",
				t.objectProperty(t.identifier("effort"), t.identifier(effortName)),
			)
		) {
			return false;
		}
		launchEffort = getObjectPropertyByName(launch, "effort");
	}

	for (const candidate of sessionOptions) {
		const property = getObjectPropertyByName(candidate.node, "sessionEffort");
		if (!property) return false;
		if (
			isTeammateSessionEffortExpression(property.value, candidate.inputName)
		) {
			continue;
		}
		if (getMemberBaseName(property.value, "sessionEffort") === null) {
			return false;
		}
		if (!t.isExpression(property.value)) return false;
		const fallback = t.cloneNode(property.value, true);
		const inputEffort = t.memberExpression(
			t.identifier(candidate.inputName),
			t.identifier("effort"),
		);
		property.value = t.conditionalExpression(
			t.binaryExpression("!==", t.cloneNode(inputEffort), buildVoidZero()),
			t.objectExpression([
				t.objectProperty(t.identifier("kind"), t.stringLiteral("level")),
				t.objectProperty(t.identifier("value"), inputEffort),
			]),
			fallback,
		);
	}

	return (
		launchEffort !== null &&
		t.isIdentifier(launchEffort.value, { name: effortName }) &&
		sessionOptions.every((candidate) => {
			const property = getObjectPropertyByName(candidate.node, "sessionEffort");
			return (
				property !== null &&
				isTeammateSessionEffortExpression(property.value, candidate.inputName)
			);
		})
	);
}

function hasTeammateEffortContract(
	call: AgentCallCandidate,
	launchInputs: TeammateLaunchInputCandidate[],
	sessionOptions: TeammateSessionOptionsCandidate[],
	effortName: string,
): boolean {
	const matchingLaunches = launchInputs.filter(
		(candidate) => candidate.functionNode === call.path.node,
	);
	if (
		matchingLaunches.length !== 1 ||
		(sessionOptions.length !== 0 && sessionOptions.length !== 2)
	) {
		return false;
	}
	const launch = matchingLaunches[0].node;
	const subagentTypeName = getPatternBindingName(call.input, "subagent_type");
	const agentType = getObjectPropertyByName(launch, "agent_type");
	const launchEffort = getObjectPropertyByName(launch, "effort");
	return (
		subagentTypeName !== null &&
		agentType !== null &&
		countMatchingNodes(agentType.value, (node) =>
			t.isIdentifier(node, { name: subagentTypeName }),
		) === 1 &&
		launchEffort !== null &&
		t.isIdentifier(launchEffort.value, { name: effortName }) &&
		sessionOptions.every((candidate) => {
			const property = getObjectPropertyByName(candidate.node, "sessionEffort");
			return (
				property !== null &&
				isTeammateSessionEffortExpression(property.value, candidate.inputName)
			);
		})
	);
}

function countMatchingNodes(
	root: t.Node,
	predicate: (node: t.Node) => boolean,
): number {
	let count = 0;
	t.traverseFast(root, (node) => {
		if (predicate(node)) count++;
	});
	return count;
}

function patchAgentCallEffort(
	call: AgentCallCandidate,
	forkLaunches: ForkResolutionCandidate[],
	launchOptions: AgentLaunchOptionsCandidate[],
	remoteRequests: RemoteAgentRequestCandidate[],
	teammateLaunchInputs: TeammateLaunchInputCandidate[],
	teammateSessionOptions: TeammateSessionOptionsCandidate[],
): boolean {
	const matchingForks = forkLaunches.filter(
		(candidate) => candidate.path.getFunctionParent()?.node === call.path.node,
	);
	const matchingOptions = launchOptions.filter(
		(candidate) => candidate.functionNode === call.path.node,
	);
	const matchingRemote = remoteRequests.filter(
		(candidate) => candidate.functionNode === call.path.node,
	);
	if (
		matchingForks.length !== 1 ||
		matchingOptions.length !== 1 ||
		matchingRemote.length !== 1
	) {
		return false;
	}

	const fork = matchingForks[0];
	const selectedAgentName = getResolverSelectedAgentName(fork.resolverCall);
	if (
		!selectedAgentName ||
		matchingOptions[0].selectedAgentName !== selectedAgentName
	) {
		return false;
	}

	let effortName = getPatternBindingName(call.input, "effort");
	if (!effortName) {
		const modelIndex = call.input.properties.findIndex(
			(property) =>
				t.isObjectProperty(property) &&
				getObjectKeyName(property.key) === "model",
		);
		if (modelIndex < 0) return false;
		effortName = AGENT_EFFORT_BINDING;
		call.input.properties.splice(
			modelIndex + 1,
			0,
			t.objectProperty(t.identifier("effort"), t.identifier(effortName)),
		);
	}
	if (effortName !== AGENT_EFFORT_BINDING) return false;

	let overrideCount = countMatchingNodes(call.path.node.body, (node) =>
		isAgentEffortOverrideStatement(
			node,
			fork.forkName,
			effortName,
			selectedAgentName,
		),
	);
	if (overrideCount === 0) {
		const declarationPath = fork.path.parentPath;
		if (!declarationPath?.isVariableDeclaration()) return false;
		const binding = fork.path.scope.getBinding(selectedAgentName);
		if (
			!binding ||
			!t.isVariableDeclarator(binding.path.node) ||
			!binding.path.parentPath?.isVariableDeclaration() ||
			binding.path.parentPath.node.kind === "const"
		) {
			return false;
		}
		declarationPath.insertBefore(
			buildAgentEffortOverrideStatement(
				fork.forkName,
				effortName,
				selectedAgentName,
			),
		);
		overrideCount = 1;
	}

	const options = matchingOptions[0].node;
	let extraMetadata = getObjectPropertyByName(options, "extraMetadata");
	if (!extraMetadata) {
		const value = t.conditionalExpression(
			t.logicalExpression(
				"&&",
				t.unaryExpression("!", t.identifier(fork.forkName)),
				t.binaryExpression("!==", t.identifier(effortName), buildVoidZero()),
			),
			t.objectExpression([
				t.objectProperty(t.identifier("effort"), t.identifier(effortName)),
			]),
			buildVoidZero(),
		);
		if (
			!insertObjectPropertyAfter(
				options,
				"model",
				t.objectProperty(t.identifier("extraMetadata"), value),
			)
		) {
			return false;
		}
		extraMetadata = getObjectPropertyByName(options, "extraMetadata");
	}

	const remote = matchingRemote[0].node;
	let remoteEffort = getObjectPropertyByName(remote, "effort");
	if (!remoteEffort) {
		if (
			!insertObjectPropertyAfter(
				remote,
				"model",
				t.objectProperty(
					t.identifier("effort"),
					t.memberExpression(
						t.identifier(selectedAgentName),
						t.identifier("effort"),
					),
				),
			)
		) {
			return false;
		}
		remoteEffort = getObjectPropertyByName(remote, "effort");
	}
	const teammatePatched = patchTeammateEffort(
		call,
		teammateLaunchInputs,
		teammateSessionOptions,
		effortName,
	);

	return (
		overrideCount === 1 &&
		extraMetadata !== null &&
		isExtraMetadataEffortExpression(
			extraMetadata.value,
			fork.forkName,
			effortName,
		) &&
		remoteEffort !== null &&
		isSelectedAgentEffortMember(remoteEffort.value, selectedAgentName) &&
		teammatePatched
	);
}

function hasAgentCallEffortContract(
	call: AgentCallCandidate,
	forkLaunches: ForkResolutionCandidate[],
	launchOptions: AgentLaunchOptionsCandidate[],
	remoteRequests: RemoteAgentRequestCandidate[],
	teammateLaunchInputs: TeammateLaunchInputCandidate[],
	teammateSessionOptions: TeammateSessionOptionsCandidate[],
): boolean {
	const effortName = getPatternBindingName(call.input, "effort");
	if (effortName !== AGENT_EFFORT_BINDING) return false;
	const matchingForks = forkLaunches.filter(
		(candidate) => candidate.path.getFunctionParent()?.node === call.path.node,
	);
	const matchingOptions = launchOptions.filter(
		(candidate) => candidate.functionNode === call.path.node,
	);
	const matchingRemote = remoteRequests.filter(
		(candidate) => candidate.functionNode === call.path.node,
	);
	if (
		matchingForks.length !== 1 ||
		matchingOptions.length !== 1 ||
		matchingRemote.length !== 1
	) {
		return false;
	}
	const fork = matchingForks[0];
	const selectedAgentName = getResolverSelectedAgentName(fork.resolverCall);
	if (
		!selectedAgentName ||
		matchingOptions[0].selectedAgentName !== selectedAgentName
	) {
		return false;
	}
	const overrideCount = countMatchingNodes(call.path.node.body, (node) =>
		isAgentEffortOverrideStatement(
			node,
			fork.forkName,
			effortName,
			selectedAgentName,
		),
	);
	const extraMetadata = getObjectPropertyByName(
		matchingOptions[0].node,
		"extraMetadata",
	);
	const remoteEffort = getObjectPropertyByName(
		matchingRemote[0].node,
		"effort",
	);
	return (
		overrideCount === 1 &&
		extraMetadata !== null &&
		isExtraMetadataEffortExpression(
			extraMetadata.value,
			fork.forkName,
			effortName,
		) &&
		remoteEffort !== null &&
		isSelectedAgentEffortMember(remoteEffort.value, selectedAgentName) &&
		hasTeammateEffortContract(
			call,
			teammateLaunchInputs,
			teammateSessionOptions,
			effortName,
		)
	);
}

function isResumeEffortCondition(
	node: t.Node | null | undefined,
	metadataName: string,
): boolean {
	if (!t.isLogicalExpression(node, { operator: "&&" })) return false;
	const nonFork = node.left;
	const hasEffort = node.right;
	return (
		t.isBinaryExpression(nonFork, { operator: "!==" }) &&
		isMetadataPropertyExpression(nonFork.left, metadataName, "isFork") &&
		t.isBooleanLiteral(nonFork.right, { value: true }) &&
		t.isBinaryExpression(hasEffort, { operator: "!==" }) &&
		isMetadataPropertyExpression(hasEffort.left, metadataName, "effort") &&
		isVoidZero(hasEffort.right)
	);
}

function isResumeEffortStatement(
	node: t.Node,
	metadataName: string,
	selectedAgentName: string,
): boolean {
	if (
		!t.isIfStatement(node) ||
		!isResumeEffortCondition(node.test, metadataName)
	) {
		return false;
	}
	const statements = t.isBlockStatement(node.consequent)
		? node.consequent.body
		: [node.consequent];
	if (statements.length !== 1 || !t.isExpressionStatement(statements[0])) {
		return false;
	}
	const assignment = statements[0].expression;
	return (
		t.isAssignmentExpression(assignment, { operator: "=" }) &&
		t.isIdentifier(assignment.left, { name: selectedAgentName }) &&
		isSelectedAgentEffortObject(assignment.right, selectedAgentName, (value) =>
			isMetadataPropertyExpression(value, metadataName, "effort"),
		)
	);
}

function buildResumeEffortStatement(
	metadataName: string,
	selectedAgentName: string,
): t.IfStatement {
	return t.ifStatement(
		t.logicalExpression(
			"&&",
			t.binaryExpression(
				"!==",
				buildOptionalMember(metadataName, "isFork"),
				t.booleanLiteral(true),
			),
			t.binaryExpression(
				"!==",
				buildOptionalMember(metadataName, "effort"),
				buildVoidZero(),
			),
		),
		t.blockStatement([
			t.expressionStatement(
				t.assignmentExpression(
					"=",
					t.identifier(selectedAgentName),
					t.objectExpression([
						t.spreadElement(t.identifier(selectedAgentName)),
						t.objectProperty(
							t.identifier("effort"),
							buildOptionalMember(metadataName, "effort"),
						),
					]),
				),
			),
		]),
	);
}

function patchResumeEffort(options: ResumeOptionsCandidate): boolean {
	const definition = getObjectPropertyByName(options.node, "agentDefinition");
	if (!definition || !t.isIdentifier(definition.value)) return false;
	const selectedAgentName = definition.value.name;
	let count = countMatchingNodes(options.functionNode, (node) =>
		isResumeEffortStatement(node, options.metadataName, selectedAgentName),
	);
	if (count === 0) {
		const binding = options.path.scope.getBinding(selectedAgentName);
		if (
			!binding ||
			!t.isVariableDeclarator(binding.path.node) ||
			!binding.path.parentPath?.isVariableDeclaration() ||
			binding.path.parentPath.node.kind === "const"
		) {
			return false;
		}
		binding.path.parentPath.insertAfter(
			buildResumeEffortStatement(options.metadataName, selectedAgentName),
		);
		count = 1;
	}
	return count === 1;
}

function hasResumeEffortContract(options: ResumeOptionsCandidate): boolean {
	const definition = getObjectPropertyByName(options.node, "agentDefinition");
	if (!definition || !t.isIdentifier(definition.value)) return false;
	const selectedAgentName = definition.value.name;
	return (
		countMatchingNodes(options.functionNode, (node) =>
			isResumeEffortStatement(node, options.metadataName, selectedAgentName),
		) === 1
	);
}

function isMetadataEffortMirrorSpread(
	property: t.ObjectExpression["properties"][number],
	metadataName: string,
): boolean {
	if (
		!t.isSpreadElement(property) ||
		!t.isLogicalExpression(property.argument, { operator: "&&" })
	) {
		return false;
	}
	const guard = property.argument.left;
	const payload = property.argument.right;
	if (
		!t.isBinaryExpression(guard, { operator: "!==" }) ||
		getMemberBaseName(guard.left, "effort") !== metadataName ||
		!isVoidZero(guard.right) ||
		!t.isObjectExpression(payload) ||
		payload.properties.length !== 1
	) {
		return false;
	}
	const effort = getObjectPropertyByName(payload, "effort");
	return (
		effort !== null &&
		getMemberBaseName(effort.value, "effort") === metadataName
	);
}

function patchMetadataEffortMirror(
	candidate: MetadataMirrorCandidate,
): boolean {
	let matching = candidate.node.properties.filter((property) =>
		isMetadataEffortMirrorSpread(property, candidate.metadataName),
	);
	if (matching.length === 0) {
		const modelIndex = candidate.node.properties.findIndex(
			(property) =>
				t.isSpreadElement(property) &&
				nodeContains(property.argument, (node) => {
					return getMemberBaseName(node, "model") === candidate.metadataName;
				}),
		);
		if (modelIndex < 0) return false;
		const effortMember = t.memberExpression(
			t.identifier(candidate.metadataName),
			t.identifier("effort"),
		);
		candidate.node.properties.splice(
			modelIndex + 1,
			0,
			t.spreadElement(
				t.logicalExpression(
					"&&",
					t.binaryExpression("!==", t.cloneNode(effortMember), buildVoidZero()),
					t.objectExpression([
						t.objectProperty(t.identifier("effort"), effortMember),
					]),
				),
			),
		);
		matching = candidate.node.properties.filter((property) =>
			isMetadataEffortMirrorSpread(property, candidate.metadataName),
		);
	}
	return matching.length === 1;
}

function hasMetadataEffortMirror(candidate: MetadataMirrorCandidate): boolean {
	return (
		candidate.node.properties.filter((property) =>
			isMetadataEffortMirrorSpread(property, candidate.metadataName),
		).length === 1
	);
}

function createSubagentModelPasses(): PatchAstPass[] {
	const candidates: NodePath<t.IfStatement>[] = [];
	const schemaCandidates: AgentModelSchemaShape[] = [];
	const launchMetadataCandidates: LaunchMetadataCandidate[] = [];
	const resumeOptionsCandidates: ResumeOptionsCandidate[] = [];
	const resolvedModelCandidates: ResolvedModelCandidate[] = [];
	const forkLaunchCandidates: ForkResolutionCandidate[] = [];
	const forkResumeCandidates: ForkResolutionCandidate[] = [];
	const agentCallCandidates: AgentCallCandidate[] = [];
	const agentLaunchOptionsCandidates: AgentLaunchOptionsCandidate[] = [];
	const remoteAgentRequestCandidates: RemoteAgentRequestCandidate[] = [];
	const metadataMirrorCandidates: MetadataMirrorCandidate[] = [];
	const teammateLaunchInputCandidates: TeammateLaunchInputCandidate[] = [];
	const teammateSessionOptionsCandidates: TeammateSessionOptionsCandidate[] =
		[];
	let guardedCount = 0;
	let uiPatched = false;
	let schemaPatched = false;
	let effortSchemaPatched = false;
	let agentCallEffortPatched = false;
	let resumeEffortPatched = false;
	let metadataMirrorPatched = false;
	let lifecyclePatched = false;
	let forkLaunchPatched = false;
	let forkResumePatched = false;

	return [
		{
			pass: "discover",
			visitor: {
				ObjectMethod(path) {
					const agentCall = classifyAgentCall(path);
					if (agentCall) agentCallCandidates.push(agentCall);
				},
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
					const launchOptions = classifyAgentLaunchOptions(path);
					if (launchOptions) {
						agentLaunchOptionsCandidates.push(launchOptions);
					}
					const remoteRequest = classifyRemoteAgentRequest(path);
					if (remoteRequest) remoteAgentRequestCandidates.push(remoteRequest);
					const metadataMirror = classifyMetadataMirror(path);
					if (metadataMirror) metadataMirrorCandidates.push(metadataMirror);
					const teammateLaunch = classifyTeammateLaunchInput(path);
					if (teammateLaunch) {
						teammateLaunchInputCandidates.push(teammateLaunch);
					}
					const teammateSession = classifyTeammateSessionOptions(path);
					if (teammateSession) {
						teammateSessionOptionsCandidates.push(teammateSession);
					}
				},
				VariableDeclarator(path) {
					const forkLaunch = classifyForkLaunchResolution(path);
					if (forkLaunch) forkLaunchCandidates.push(forkLaunch);
					const forkResume = classifyForkResumeResolution(path);
					if (forkResume) forkResumeCandidates.push(forkResume);
				},
			},
		},
		{
			pass: "mutate",
			visitor: {
				Program: {
					exit() {
						if (forkLaunchCandidates.length === 1) {
							applyForkInheritance(forkLaunchCandidates[0]);
							forkLaunchPatched = forkLaunchCandidates[0].state === "patched";
						}

						if (forkResumeCandidates.length === 1) {
							applyForkInheritance(forkResumeCandidates[0]);
							forkResumePatched = forkResumeCandidates[0].state === "patched";
						}

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
							let effortSchema = getAgentEffortSchemaShape(schema.object);
							if (!effortSchema && schema.kind === "aliases") {
								const value = buildAgentEffortSchema(schema);
								if (
									value &&
									insertObjectPropertyAfter(
										schema.object,
										"model",
										t.objectProperty(t.identifier("effort"), value),
									)
								) {
									effortSchema = getAgentEffortSchemaShape(schema.object);
								}
							}
							if (effortSchema?.kind === "named-levels") {
								effortSchema.describeCall.arguments = [
									t.stringLiteral(AGENT_EFFORT_DESCRIPTION),
								];
								effortSchemaPatched = true;
							}
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

						if (agentCallCandidates.length === 1 && effortSchemaPatched) {
							agentCallEffortPatched = patchAgentCallEffort(
								agentCallCandidates[0],
								forkLaunchCandidates,
								agentLaunchOptionsCandidates,
								remoteAgentRequestCandidates,
								teammateLaunchInputCandidates,
								teammateSessionOptionsCandidates,
							);
						}

						if (resumeOptionsCandidates.length === 1) {
							resumeEffortPatched = patchResumeEffort(
								resumeOptionsCandidates[0],
							);
						}

						if (metadataMirrorCandidates.length === 1) {
							metadataMirrorPatched = patchMetadataEffortMirror(
								metadataMirrorCandidates[0],
							);
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
						if (!forkLaunchPatched || !forkResumePatched) {
							console.warn(
								`Subagent model tag: Could not preserve fork inheritance at launch and resume (launch: ${forkLaunchPatched}, resume: ${forkResumePatched})`,
							);
						}
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

						if (!effortSchemaPatched) {
							console.warn(
								"Subagent model tag: Could not add the Agent per-call effort schema",
							);
						}
						if (!agentCallEffortPatched) {
							console.warn(
								`Subagent model tag: Could not patch the Agent effort launch contract (calls: ${agentCallCandidates.length}, options: ${agentLaunchOptionsCandidates.length}, remote requests: ${remoteAgentRequestCandidates.length}, teammate launches: ${teammateLaunchInputCandidates.length}, teammate backends: ${teammateSessionOptionsCandidates.length})`,
							);
						}
						if (!resumeEffortPatched) {
							console.warn(
								"Subagent model tag: Could not patch the Agent effort resume contract",
							);
						}
						if (!metadataMirrorPatched) {
							console.warn(
								`Subagent model tag: Could not patch the Agent effort transcript mirror (${metadataMirrorCandidates.length} candidates)`,
							);
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
 * Let Agent and Workflow calls select full provider model IDs, let Agent calls
 * override effort without replacing the selected definition or teammate type,
 * persist explicit selections across resume, preserve parent inheritance for
 * forks, and hide redundant row tags under a global subagent model override.
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
		const forkLaunchCandidates: ForkResolutionCandidate[] = [];
		const forkResumeCandidates: ForkResolutionCandidate[] = [];
		const agentCallCandidates: AgentCallCandidate[] = [];
		const agentLaunchOptionsCandidates: AgentLaunchOptionsCandidate[] = [];
		const remoteAgentRequestCandidates: RemoteAgentRequestCandidate[] = [];
		const resumeOptionsCandidates: ResumeOptionsCandidate[] = [];
		const metadataMirrorCandidates: MetadataMirrorCandidate[] = [];
		const teammateLaunchInputCandidates: TeammateLaunchInputCandidate[] = [];
		const teammateSessionOptionsCandidates: TeammateSessionOptionsCandidate[] =
			[];

		traverse(verifyAst, {
			ObjectMethod(path) {
				const agentCall = classifyAgentCall(path);
				if (agentCall) agentCallCandidates.push(agentCall);
			},
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
				const launchOptions = classifyAgentLaunchOptions(path);
				if (launchOptions) {
					agentLaunchOptionsCandidates.push(launchOptions);
				}
				const remoteRequest = classifyRemoteAgentRequest(path);
				if (remoteRequest) remoteAgentRequestCandidates.push(remoteRequest);
				const resumeOptions = classifyResumeOptionsObject(path);
				if (resumeOptions) resumeOptionsCandidates.push(resumeOptions);
				const metadataMirror = classifyMetadataMirror(path);
				if (metadataMirror) metadataMirrorCandidates.push(metadataMirror);
				const teammateLaunch = classifyTeammateLaunchInput(path);
				if (teammateLaunch) {
					teammateLaunchInputCandidates.push(teammateLaunch);
				}
				const teammateSession = classifyTeammateSessionOptions(path);
				if (teammateSession) {
					teammateSessionOptionsCandidates.push(teammateSession);
				}
			},
			VariableDeclarator(path) {
				const forkLaunch = classifyForkLaunchResolution(path);
				if (forkLaunch) forkLaunchCandidates.push(forkLaunch);
				const forkResume = classifyForkResumeResolution(path);
				if (forkResume) forkResumeCandidates.push(forkResume);
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
		const effortSchema = getAgentEffortSchemaShape(agentModelSchema.object);
		if (effortSchema?.kind !== "named-levels") {
			return "Agent effort schema does not expose the exact named effort levels";
		}
		if (
			getStaticString(
				effortSchema.describeCall.arguments[0] as t.Node | undefined,
			) !== AGENT_EFFORT_DESCRIPTION
		) {
			return "Agent effort schema guidance does not preserve arbitrary agent definitions";
		}
		// The child-model launch metadata, resume options, and resume resolver are
		// native upstream shapes this patch reads but never writes: the override it
		// widens relies on that persistence, but a benign upstream refactor of those
		// lists must not fail the patch. Their drift is surfaced as a diagnostic
		// warning from the mutate pass, not as a verification failure here. The fork
		// resolvers below stay hard because the patch actively mutates them.
		if (forkLaunchCandidates.length !== 1) {
			return `Fork launch model resolution is ambiguous or missing (${forkLaunchCandidates.length} sites found)`;
		}
		if (forkLaunchCandidates[0].state !== "patched") {
			return "Fork launch does not preserve the parent model";
		}
		if (forkResumeCandidates.length !== 1) {
			return `Fork resume model resolution is ambiguous or missing (${forkResumeCandidates.length} sites found)`;
		}
		if (forkResumeCandidates[0].state !== "patched") {
			return "Fork resume does not preserve the parent model";
		}
		if (agentCallCandidates.length !== 1) {
			return `Agent call effort input is ambiguous or missing (${agentCallCandidates.length} sites found)`;
		}
		if (
			!hasAgentCallEffortContract(
				agentCallCandidates[0],
				forkLaunchCandidates,
				agentLaunchOptionsCandidates,
				remoteAgentRequestCandidates,
				teammateLaunchInputCandidates,
				teammateSessionOptionsCandidates,
			)
		) {
			return "Agent call does not preserve the selected agent while applying and persisting effort";
		}
		if (resumeOptionsCandidates.length !== 1) {
			return `Agent effort resume options are ambiguous or missing (${resumeOptionsCandidates.length} sites found)`;
		}
		if (!hasResumeEffortContract(resumeOptionsCandidates[0])) {
			return "Agent effort is not restored safely during resume";
		}
		if (metadataMirrorCandidates.length !== 1) {
			return `Agent metadata mirror is ambiguous or missing (${metadataMirrorCandidates.length} sites found)`;
		}
		if (!hasMetadataEffortMirror(metadataMirrorCandidates[0])) {
			return "Agent metadata mirror does not retain effort";
		}
		return true;
	},
};
