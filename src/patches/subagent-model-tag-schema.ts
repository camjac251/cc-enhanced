import * as t from "@babel/types";
import {
	getMemberPropertyName,
	getObjectKeyName,
	getObjectPropertyByName,
} from "./ast-helpers.js";

const BUILTIN_MODEL_ALIASES = ["sonnet", "opus", "haiku", "fable"] as const;
const AGENT_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export const AGENT_EFFORT_BINDING = "__claudeCodeAgentEffortOverride";
const AGENT_TYPE = "The type of specialized agent to use for this task";
export const AGENT_MODEL_DESCRIPTION =
	'Optional model override for this agent. Accepts a built-in model alias (for example, "fable", "opus", "sonnet", or "haiku"), "inherit", or a full model ID available through /model and exposed by the active provider. Takes precedence over the agent definition\'s model frontmatter. If omitted, uses the agent definition\'s model or inherits from the parent; "inherit" always uses the parent model. Ignored for subagent_type: "fork"; forks always inherit the parent model.';
export const AGENT_EFFORT_DESCRIPTION =
	'Optional effort override for this agent. Accepts "low", "medium", "high", "xhigh", or "max" and takes precedence over the selected agent definition\'s effort without changing its subagent_type, prompt, tools, or permissions. If omitted, preserves the selected definition\'s effort or normal inheritance. Ignored for subagent_type: "fork"; forks always inherit the parent effort.';

type MemberCall = t.CallExpression & { callee: t.MemberExpression };

export interface AgentModelSchemaShape {
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

export function getStaticString(
	node: t.Node | null | undefined,
): string | null {
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

export function isAgentInputSchemaObject(node: t.ObjectExpression): boolean {
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

export function getAgentModelSchemaShape(
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

export function getAgentEffortSchemaShape(
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

export function buildAgentEffortSchema(
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

export function insertObjectPropertyAfter(
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

export function buildNonemptyStringSchema(
	receiver: t.Expression,
): t.CallExpression {
	const stringCall = t.callExpression(t.cloneNode(receiver, true), []);
	const trimCall = t.callExpression(
		t.memberExpression(stringCall, t.identifier("trim")),
		[],
	);
	return t.callExpression(t.memberExpression(trimCall, t.identifier("min")), [
		t.numericLiteral(1),
	]);
}
