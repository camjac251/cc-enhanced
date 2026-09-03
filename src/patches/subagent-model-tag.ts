import * as t from "@babel/types";
import { type NodePath, traverse } from "../babel.js";
import type { Patch, PatchAstPass } from "../types.js";
import {
	getObjectKeyName,
	getVerifyAst,
	isElementCall,
	isTrueLike,
} from "./ast-helpers.js";
import {
	type AgentCallCandidate,
	type AgentLaunchOptionsCandidate,
	classifyAgentCall,
	classifyAgentLaunchOptions,
	classifyMetadataMirror,
	classifyRemoteAgentRequest,
	classifyResumeOptionsObject,
	classifyTeammateLaunchInput,
	classifyTeammateSessionOptions,
	hasAgentCallEffortContract,
	hasMetadataEffortMirror,
	hasResumeEffortContract,
	type MetadataMirrorCandidate,
	patchAgentCallEffort,
	patchMetadataEffortMirror,
	patchResumeEffort,
	type RemoteAgentRequestCandidate,
	type ResumeOptionsCandidate,
	type TeammateLaunchInputCandidate,
	type TeammateSessionOptionsCandidate,
} from "./subagent-model-tag-effort.js";
import {
	applyForkInheritance,
	classifyForkLaunchResolution,
	classifyForkResumeResolution,
	type ForkResolutionCandidate,
} from "./subagent-model-tag-fork.js";
import { nodeContains } from "./subagent-model-tag-helpers.js";
import {
	AGENT_EFFORT_DESCRIPTION,
	AGENT_MODEL_DESCRIPTION,
	type AgentModelSchemaShape,
	buildAgentEffortSchema,
	buildNonemptyStringSchema,
	getAgentEffortSchemaShape,
	getAgentModelSchemaShape,
	getStaticString,
	insertObjectPropertyAfter,
	isAgentInputSchemaObject,
} from "./subagent-model-tag-schema.js";

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

function createSubagentModelPasses(): PatchAstPass[] {
	const candidates: NodePath<t.IfStatement>[] = [];
	const schemaCandidates: AgentModelSchemaShape[] = [];
	const resumeOptionsCandidates: ResumeOptionsCandidate[] = [];
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
					const resumeOptions = classifyResumeOptionsObject(path);
					if (resumeOptions) resumeOptionsCandidates.push(resumeOptions);
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
		// The fork resolvers are hard requirements because the patch mutates them.
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
