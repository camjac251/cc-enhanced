import * as t from "@babel/types";
import { type NodePath, traverse } from "../babel.js";
import type { Patch, PatchAstPass } from "../types.js";
import {
	getMemberPropertyName,
	getObjectKeyName,
	getVerifyAst,
	isFalseLike,
} from "./ast-helpers.js";

type SiteState = "stock" | "patched" | "other";

interface CapabilityLookupCandidate {
	path: NodePath<t.Function>;
	functionName: string;
	gateName: string;
	modelName: string;
}

interface ContextResolverCandidate {
	path: NodePath<t.Function>;
	modelName: string;
	environmentName: string;
	fallbackIndex: number;
	state: SiteState;
}

interface AutoCompactEligibilityCandidate {
	path: NodePath<t.Function>;
	modelName: string;
	configuredWindowName: string;
	returnIndex: number;
	state: SiteState;
}

interface PatchAnalysis {
	lookup: CapabilityLookupCandidate;
	gate: t.FunctionDeclaration;
	gateState: SiteState;
	context: ContextResolverCandidate;
	eligibility: AutoCompactEligibilityCandidate;
}

function nodeHasMemberProperty(node: t.Node, propertyName: string): boolean {
	let found = false;
	t.traverseFast(node, (child) => {
		if (
			!found &&
			(t.isMemberExpression(child) || t.isOptionalMemberExpression(child)) &&
			getMemberPropertyName(child) === propertyName
		) {
			found = true;
		}
	});
	return found;
}

function nodeHasString(node: t.Node, value: string): boolean {
	let found = false;
	t.traverseFast(node, (child) => {
		if (!found && t.isStringLiteral(child, { value })) found = true;
	});
	return found;
}

function nodeHasMillionReturn(node: t.Node): boolean {
	let found = false;
	t.traverseFast(node, (child) => {
		if (
			!found &&
			t.isReturnStatement(child) &&
			t.isNumericLiteral(child.argument, { value: 1_000_000 })
		) {
			found = true;
		}
	});
	return found;
}

function getFunctionDeclarationName(path: NodePath<t.Function>): string | null {
	return t.isFunctionDeclaration(path.node) && path.node.id
		? path.node.id.name
		: null;
}

function getLeadingGateName(path: NodePath<t.Function>): string | null {
	if (!t.isBlockStatement(path.node.body)) return null;
	const [first, second] = path.node.body.body;
	const gate = t.isBlockStatement(first) ? second : first;
	if (!t.isIfStatement(gate)) return null;
	const test = gate.test;
	if (
		!t.isUnaryExpression(test, { operator: "!" }) ||
		!t.isCallExpression(test.argument) ||
		test.argument.arguments.length !== 0 ||
		!t.isIdentifier(test.argument.callee)
	) {
		return null;
	}
	const consequent = t.isBlockStatement(gate.consequent)
		? gate.consequent.body[0]
		: gate.consequent;
	if (!t.isReturnStatement(consequent) || consequent.argument !== null) {
		return null;
	}
	return test.argument.callee.name;
}

function classifyCapabilityLookup(
	path: NodePath<t.Function>,
): CapabilityLookupCandidate | null {
	const functionName = getFunctionDeclarationName(path);
	const modelParameter = path.node.params[0];
	const gateName = getLeadingGateName(path);
	if (!functionName || !t.isIdentifier(modelParameter) || !gateName)
		return null;
	if (!nodeHasMemberProperty(path.node, "id")) return null;
	if (!nodeHasMemberProperty(path.node, "toLowerCase")) return null;
	if (!nodeHasMemberProperty(path.node, "find")) return null;
	if (!nodeHasMemberProperty(path.node, "includes")) return null;
	return {
		path,
		functionName,
		gateName,
		modelName: modelParameter.name,
	};
}

function getEnvironmentFallback(
	statement: t.Statement,
): { environmentName: string } | null {
	if (
		!t.isVariableDeclaration(statement) ||
		statement.declarations.length !== 1
	) {
		return null;
	}
	const initializer = statement.declarations[0].init;
	if (
		!t.isMemberExpression(initializer) ||
		getMemberPropertyName(initializer) !== "CLAUDE_CODE_MAX_CONTEXT_TOKENS" ||
		!t.isIdentifier(initializer.object)
	) {
		return null;
	}
	return { environmentName: initializer.object.name };
}

function isOptionalMaxInputRead(
	node: t.Node | null | undefined,
	capabilityName: string,
): boolean {
	return (
		(t.isOptionalMemberExpression(node) || t.isMemberExpression(node)) &&
		t.isIdentifier(node.object, { name: capabilityName }) &&
		getMemberPropertyName(node) === "max_input_tokens" &&
		(node.optional === true || t.isOptionalMemberExpression(node))
	);
}

function isNumberSafeIntegerCall(node: t.Node, valueName: string): boolean {
	return (
		t.isCallExpression(node) &&
		t.isMemberExpression(node.callee) &&
		t.isIdentifier(node.callee.object, { name: "Number" }) &&
		getMemberPropertyName(node.callee) === "isSafeInteger" &&
		node.arguments.length === 1 &&
		t.isIdentifier(node.arguments[0], { name: valueName })
	);
}

function isCappedMetadataReturn(node: t.Statement, valueName: string): boolean {
	if (
		!t.isIfStatement(node) ||
		!t.isLogicalExpression(node.test, { operator: "&&" })
	) {
		return false;
	}
	if (!isNumberSafeIntegerCall(node.test.left, valueName)) return false;
	if (
		!t.isBinaryExpression(node.test.right, { operator: ">" }) ||
		!t.isIdentifier(node.test.right.left, { name: valueName }) ||
		!t.isNumericLiteral(node.test.right.right, { value: 0 })
	) {
		return false;
	}
	const consequent = t.isBlockStatement(node.consequent)
		? node.consequent.body[0]
		: node.consequent;
	if (
		!t.isReturnStatement(consequent) ||
		!t.isCallExpression(consequent.argument)
	) {
		return false;
	}
	const call = consequent.argument;
	return (
		t.isMemberExpression(call.callee) &&
		t.isIdentifier(call.callee.object, { name: "Math" }) &&
		getMemberPropertyName(call.callee) === "min" &&
		call.arguments.length === 2 &&
		t.isIdentifier(call.arguments[0], { name: valueName }) &&
		t.isNumericLiteral(call.arguments[1], { value: 1_000_000 })
	);
}

function isAutoSourceComparison(
	node: t.Node | null | undefined,
	modelName: string,
	configuredWindowName: string,
): node is t.BinaryExpression {
	return (
		t.isBinaryExpression(node, { operator: "!==" }) &&
		t.isMemberExpression(node.left) &&
		getMemberPropertyName(node.left) === "source" &&
		t.isCallExpression(node.left.object) &&
		node.left.object.arguments.length === 2 &&
		t.isIdentifier(node.left.object.arguments[0], { name: modelName }) &&
		t.isIdentifier(node.left.object.arguments[1], {
			name: configuredWindowName,
		}) &&
		t.isStringLiteral(node.right, { value: "auto" })
	);
}

function isPositiveMetadataCheck(node: t.Node, valueName: string): boolean {
	return (
		t.isBinaryExpression(node, { operator: ">" }) &&
		t.isIdentifier(node.left, { name: valueName }) &&
		t.isNumericLiteral(node.right, { value: 0 })
	);
}

function hasMetadataEligibilityBlock(
	statements: t.Statement[],
	returnIndex: number,
	lookupName: string,
	modelName: string,
	configuredWindowName: string,
): boolean {
	if (returnIndex < 1) return false;
	const declaration = statements[returnIndex - 1];
	const returnStatement = statements[returnIndex];
	if (
		!t.isVariableDeclaration(declaration) ||
		declaration.declarations.length !== 2 ||
		!t.isReturnStatement(returnStatement) ||
		!t.isLogicalExpression(returnStatement.argument, { operator: "||" }) ||
		!isAutoSourceComparison(
			returnStatement.argument.left,
			modelName,
			configuredWindowName,
		) ||
		!t.isLogicalExpression(returnStatement.argument.right, {
			operator: "&&",
		})
	) {
		return false;
	}
	const capability = declaration.declarations[0];
	const context = declaration.declarations[1];
	if (
		!t.isIdentifier(capability.id) ||
		!t.isCallExpression(capability.init) ||
		!t.isIdentifier(capability.init.callee, { name: lookupName }) ||
		capability.init.arguments.length !== 1 ||
		!t.isIdentifier(capability.init.arguments[0], { name: modelName }) ||
		!t.isIdentifier(context.id) ||
		!isOptionalMaxInputRead(context.init, capability.id.name)
	) {
		return false;
	}
	return (
		isNumberSafeIntegerCall(
			returnStatement.argument.right.left,
			context.id.name,
		) &&
		isPositiveMetadataCheck(
			returnStatement.argument.right.right,
			context.id.name,
		)
	);
}

function classifyAutoCompactEligibility(
	path: NodePath<t.Function>,
	lookupName: string,
): AutoCompactEligibilityCandidate | null {
	if (!t.isBlockStatement(path.node.body)) return null;
	if (path.node.params.length !== 2) return null;
	const modelParameter = path.node.params[0];
	const configuredWindowParameter = path.node.params[1];
	if (
		!t.isIdentifier(modelParameter) ||
		!t.isIdentifier(configuredWindowParameter)
	) {
		return null;
	}
	const candidates = path.node.body.body
		.map((statement, index) => ({ statement, index }))
		.filter(({ statement }) => {
			if (!t.isReturnStatement(statement) || !statement.argument) return false;
			if (
				isAutoSourceComparison(
					statement.argument,
					modelParameter.name,
					configuredWindowParameter.name,
				)
			) {
				return true;
			}
			return (
				t.isLogicalExpression(statement.argument, { operator: "||" }) &&
				isAutoSourceComparison(
					statement.argument.left,
					modelParameter.name,
					configuredWindowParameter.name,
				)
			);
		});
	if (candidates.length !== 1) return null;
	const candidate = candidates[0];
	const patched = hasMetadataEligibilityBlock(
		path.node.body.body,
		candidate.index,
		lookupName,
		modelParameter.name,
		configuredWindowParameter.name,
	);
	const state: SiteState = patched
		? "patched"
		: t.isReturnStatement(candidate.statement) &&
				isAutoSourceComparison(
					candidate.statement.argument,
					modelParameter.name,
					configuredWindowParameter.name,
				)
			? "stock"
			: "other";
	return {
		path,
		modelName: modelParameter.name,
		configuredWindowName: configuredWindowParameter.name,
		returnIndex: candidate.index,
		state,
	};
}

function hasMetadataContextBlock(
	statements: t.Statement[],
	fallbackIndex: number,
	lookupName: string,
	modelName: string,
): boolean {
	if (fallbackIndex < 2) return false;
	const declaration = statements[fallbackIndex - 2];
	const guard = statements[fallbackIndex - 1];
	if (
		!t.isVariableDeclaration(declaration) ||
		declaration.declarations.length !== 2
	) {
		return false;
	}
	const capability = declaration.declarations[0];
	const context = declaration.declarations[1];
	if (!t.isIdentifier(capability.id) || !t.isCallExpression(capability.init)) {
		return false;
	}
	if (
		!t.isIdentifier(capability.init.callee, { name: lookupName }) ||
		capability.init.arguments.length !== 1 ||
		!t.isIdentifier(capability.init.arguments[0], { name: modelName })
	) {
		return false;
	}
	if (
		!t.isIdentifier(context.id) ||
		!isOptionalMaxInputRead(context.init, capability.id.name)
	) {
		return false;
	}
	return isCappedMetadataReturn(guard, context.id.name);
}

function classifyContextResolver(
	path: NodePath<t.Function>,
	lookupName: string,
): ContextResolverCandidate | null {
	if (!t.isBlockStatement(path.node.body)) return null;
	const modelParameter = path.node.params[0];
	if (!t.isIdentifier(modelParameter)) return null;
	if (!nodeHasString(path.node, "claude-")) return null;
	if (!nodeHasMillionReturn(path.node)) return null;

	const statements = path.node.body.body;
	const fallbackSites = statements
		.map((statement, index) => ({
			index,
			fallback: getEnvironmentFallback(statement),
		}))
		.filter(
			(
				site,
			): site is { index: number; fallback: { environmentName: string } } =>
				Boolean(site.fallback),
		);
	if (fallbackSites.length !== 1) return null;
	const fallback = fallbackSites[0];
	const patched = hasMetadataContextBlock(
		statements,
		fallback.index,
		lookupName,
		modelParameter.name,
	);
	const state: SiteState = patched
		? "patched"
		: nodeHasMemberProperty(path.node, "max_input_tokens")
			? "other"
			: "stock";
	return {
		path,
		modelName: modelParameter.name,
		environmentName: fallback.fallback.environmentName,
		fallbackIndex: fallback.index,
		state,
	};
}

function isCapabilitySchema(node: t.ObjectExpression): boolean {
	if (node.properties.length !== 3) return false;
	const keys = node.properties.map((property) =>
		t.isObjectProperty(property) ? getObjectKeyName(property.key) : null,
	);
	return (
		keys.includes("id") &&
		keys.includes("max_input_tokens") &&
		keys.includes("max_tokens")
	);
}

function classifyGate(
	gate: t.FunctionDeclaration,
	environmentName: string,
): SiteState {
	if (!t.isBlockStatement(gate.body) || gate.body.body.length !== 1) {
		return "other";
	}
	const statement = gate.body.body[0];
	if (!t.isReturnStatement(statement)) return "other";
	if (isFalseLike(statement.argument)) return "stock";
	return t.isMemberExpression(statement.argument) &&
		t.isIdentifier(statement.argument.object, { name: environmentName }) &&
		getMemberPropertyName(statement.argument) ===
			"CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"
		? "patched"
		: "other";
}

function analyzePatchSites(
	functionPaths: NodePath<t.Function>[],
	schemaCount: number,
): PatchAnalysis | string {
	if (schemaCount !== 1) {
		return `Model capability schema is ambiguous or missing (${schemaCount} sites found)`;
	}
	const lookups = functionPaths
		.map((path) => classifyCapabilityLookup(path))
		.filter((candidate): candidate is CapabilityLookupCandidate =>
			Boolean(candidate),
		);
	if (lookups.length !== 1) {
		return `Model capability lookup is ambiguous or missing (${lookups.length} sites found)`;
	}
	const lookup = lookups[0];
	const contexts = functionPaths
		.map((path) => classifyContextResolver(path, lookup.functionName))
		.filter((candidate): candidate is ContextResolverCandidate =>
			Boolean(candidate),
		);
	if (contexts.length !== 1) {
		return `Context resolver is ambiguous or missing (${contexts.length} sites found)`;
	}
	const context = contexts[0];
	const eligibilitySites = functionPaths
		.map((path) => classifyAutoCompactEligibility(path, lookup.functionName))
		.filter((candidate): candidate is AutoCompactEligibilityCandidate =>
			Boolean(candidate),
		);
	if (eligibilitySites.length !== 1) {
		return `Auto-compact eligibility is ambiguous or missing (${eligibilitySites.length} sites found)`;
	}
	const binding = lookup.path.scope.getBinding(lookup.gateName);
	if (!binding || !t.isFunctionDeclaration(binding.path.node)) {
		return "Model capability feature gate binding was not found";
	}
	const gate = binding.path.node;
	return {
		lookup,
		gate,
		gateState: classifyGate(gate, context.environmentName),
		context,
		eligibility: eligibilitySites[0],
	};
}

function buildMetadataContextStatements(
	context: ContextResolverCandidate,
	lookupName: string,
): t.Statement[] {
	const capability =
		context.path.scope.generateUidIdentifier("modelCapabilities");
	const contextTokens =
		context.path.scope.generateUidIdentifier("modelContextTokens");
	return [
		t.variableDeclaration("let", [
			t.variableDeclarator(
				capability,
				t.callExpression(t.identifier(lookupName), [
					t.identifier(context.modelName),
				]),
			),
			t.variableDeclarator(
				contextTokens,
				t.optionalMemberExpression(
					t.cloneNode(capability),
					t.identifier("max_input_tokens"),
					false,
					true,
				),
			),
		]),
		t.ifStatement(
			t.logicalExpression(
				"&&",
				t.callExpression(
					t.memberExpression(
						t.identifier("Number"),
						t.identifier("isSafeInteger"),
					),
					[t.cloneNode(contextTokens)],
				),
				t.binaryExpression(
					">",
					t.cloneNode(contextTokens),
					t.numericLiteral(0),
				),
			),
			t.returnStatement(
				t.callExpression(
					t.memberExpression(t.identifier("Math"), t.identifier("min")),
					[t.cloneNode(contextTokens), t.numericLiteral(1_000_000)],
				),
			),
		),
	];
}

function patchMetadataEligibility(
	candidate: AutoCompactEligibilityCandidate,
	lookupName: string,
): boolean {
	if (candidate.state === "patched") return true;
	if (
		candidate.state !== "stock" ||
		!t.isBlockStatement(candidate.path.node.body)
	) {
		return false;
	}
	const statements = candidate.path.node.body.body;
	const returnStatement = statements[candidate.returnIndex];
	if (
		!t.isReturnStatement(returnStatement) ||
		!returnStatement.argument ||
		!isAutoSourceComparison(
			returnStatement.argument,
			candidate.modelName,
			candidate.configuredWindowName,
		)
	) {
		return false;
	}
	const capability =
		candidate.path.scope.generateUidIdentifier("modelCapabilities");
	const contextTokens =
		candidate.path.scope.generateUidIdentifier("modelContextTokens");
	const declaration = t.variableDeclaration("let", [
		t.variableDeclarator(
			capability,
			t.callExpression(t.identifier(lookupName), [
				t.identifier(candidate.modelName),
			]),
		),
		t.variableDeclarator(
			contextTokens,
			t.optionalMemberExpression(
				t.cloneNode(capability),
				t.identifier("max_input_tokens"),
				false,
				true,
			),
		),
	]);
	returnStatement.argument = t.logicalExpression(
		"||",
		returnStatement.argument,
		t.logicalExpression(
			"&&",
			t.callExpression(
				t.memberExpression(
					t.identifier("Number"),
					t.identifier("isSafeInteger"),
				),
				[t.cloneNode(contextTokens)],
			),
			t.binaryExpression(">", t.cloneNode(contextTokens), t.numericLiteral(0)),
		),
	);
	statements.splice(candidate.returnIndex, 0, declaration);
	return true;
}

function createModelContextMetadataPasses(): PatchAstPass[] {
	const functionPaths: NodePath<t.Function>[] = [];
	let schemaCount = 0;
	let patched = false;
	return [
		{
			pass: "discover",
			visitor: {
				Function(path) {
					functionPaths.push(path);
				},
				ObjectExpression(path) {
					if (isCapabilitySchema(path.node)) schemaCount++;
				},
			},
		},
		{
			pass: "mutate",
			visitor: {
				Program: {
					exit() {
						const analysis = analyzePatchSites(functionPaths, schemaCount);
						if (typeof analysis === "string") return;
						if (
							analysis.gateState === "other" ||
							analysis.context.state === "other" ||
							analysis.eligibility.state === "other"
						) {
							return;
						}
						if (analysis.gateState === "stock") {
							const statement = analysis.gate.body.body[0];
							if (t.isReturnStatement(statement)) {
								statement.argument = t.memberExpression(
									t.identifier(analysis.context.environmentName),
									t.identifier("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"),
								);
							}
						}
						if (
							analysis.context.state === "stock" &&
							t.isBlockStatement(analysis.context.path.node.body)
						) {
							analysis.context.path.node.body.body.splice(
								analysis.context.fallbackIndex,
								0,
								...buildMetadataContextStatements(
									analysis.context,
									analysis.lookup.functionName,
								),
							);
						}
						patched = patchMetadataEligibility(
							analysis.eligibility,
							analysis.lookup.functionName,
						);
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
								"Model context metadata: Could not resolve unique capability and context sites",
							);
						}
					},
				},
			},
		},
	];
}

export const modelContextMetadata: Patch = {
	tag: "model-context-metadata",
	astPasses: () => createModelContextMetadataPasses(),
	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) {
			return "Unable to parse AST during model-context-metadata verification";
		}
		const functionPaths: NodePath<t.Function>[] = [];
		let schemaCount = 0;
		traverse(verifyAst, {
			Function(path) {
				functionPaths.push(path);
			},
			ObjectExpression(path) {
				if (isCapabilitySchema(path.node)) schemaCount++;
			},
		});
		const analysis = analyzePatchSites(functionPaths, schemaCount);
		if (typeof analysis === "string") return analysis;
		if (analysis.gateState !== "patched") {
			return "Model capability cache is not gated by gateway model discovery";
		}
		if (analysis.context.state !== "patched") {
			return "Context resolver does not use validated max_input_tokens metadata before the global fallback";
		}
		if (analysis.eligibility.state !== "patched") {
			return "Auto-compact eligibility does not recognize validated max_input_tokens metadata";
		}
		return true;
	},
};
