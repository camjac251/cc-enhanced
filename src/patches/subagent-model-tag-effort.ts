import * as t from "@babel/types";
import type { NodePath } from "../babel.js";
import {
	getMemberPropertyName,
	getObjectKeyName,
	getObjectPropertyByName,
} from "./ast-helpers.js";
import type { ForkResolutionCandidate } from "./subagent-model-tag-fork.js";
import {
	getOptionalMemberBase,
	isMetadataPropertyExpression,
	isVoidZero,
	nodeContains,
} from "./subagent-model-tag-helpers.js";
import {
	AGENT_EFFORT_BINDING,
	getStaticString,
	insertObjectPropertyAfter,
} from "./subagent-model-tag-schema.js";

export interface ResumeOptionsCandidate {
	path: NodePath<t.ObjectExpression>;
	node: t.ObjectExpression;
	metadataName: string;
	functionNode: t.Node;
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

export function classifyResumeOptionsObject(
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

	return {
		path,
		node: path.node,
		metadataName,
		functionNode: functionPath.node,
	};
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

export interface AgentCallCandidate {
	path: NodePath<t.ObjectMethod>;
	input: t.ObjectPattern;
}

export interface AgentLaunchOptionsCandidate {
	node: t.ObjectExpression;
	functionNode: t.Node;
	selectedAgentName: string;
}

export interface RemoteAgentRequestCandidate {
	node: t.ObjectExpression;
	functionNode: t.Node;
}

export interface MetadataMirrorCandidate {
	node: t.ObjectExpression;
	metadataName: string;
}

export interface TeammateLaunchInputCandidate {
	node: t.ObjectExpression;
	functionNode: t.Node;
}

export interface TeammateSessionOptionsCandidate {
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

export function classifyAgentCall(
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

export function classifyAgentLaunchOptions(
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

export function classifyRemoteAgentRequest(
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

export function classifyTeammateLaunchInput(
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

export function classifyTeammateSessionOptions(
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

export function classifyMetadataMirror(
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

export function patchAgentCallEffort(
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

export function hasAgentCallEffortContract(
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

export function patchResumeEffort(options: ResumeOptionsCandidate): boolean {
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

export function hasResumeEffortContract(
	options: ResumeOptionsCandidate,
): boolean {
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

export function patchMetadataEffortMirror(
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

export function hasMetadataEffortMirror(
	candidate: MetadataMirrorCandidate,
): boolean {
	return (
		candidate.node.properties.filter((property) =>
			isMetadataEffortMirrorSpread(property, candidate.metadataName),
		).length === 1
	);
}
