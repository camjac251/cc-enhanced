import * as t from "@babel/types";
import { type NodePath, traverse } from "../babel.js";
import { parse } from "../loader.js";
import type { Patch, PatchAstPass } from "../types.js";
import {
	collectSubagentModelEnvArrays,
	getMemberPropertyName,
	getObjectKeyName,
	getVerifyAst,
	isSubagentModelEnvArray,
} from "./ast-helpers.js";

const CATALOG_ENV = "CLAUDE_CODE_CONFIGURED_MODEL_CATALOG";
const PICKER_ENV_KEYS = [
	"ANTHROPIC_CUSTOM_MODEL_OPTION",
	"ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
	"ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
] as const;

interface CapabilityLookupCandidate {
	path: NodePath<t.FunctionDeclaration>;
	modelName: string;
}

interface PickerCandidate {
	path: NodePath<t.FunctionDeclaration>;
	declarationIndex: number;
	optionsName: string;
}

interface PatchAnalysis {
	helper: t.FunctionDeclaration;
	lookup: CapabilityLookupCandidate;
	picker: PickerCandidate;
	environmentArrays: t.ArrayExpression[];
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

function nodeHasMemberProperty(node: t.Node, propertyName: string): boolean {
	return nodeContains(
		node,
		(child) =>
			(t.isMemberExpression(child) || t.isOptionalMemberExpression(child)) &&
			getMemberPropertyName(child) === propertyName,
	);
}

function nodeHasObjectKey(node: t.Node, keyName: string): boolean {
	return nodeContains(
		node,
		(child) =>
			t.isObjectProperty(child) && getObjectKeyName(child.key) === keyName,
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

function isCatalogHelper(node: t.FunctionDeclaration): boolean {
	if (!node.id || node.params.length !== 0) return false;
	const requiredKeys = [
		"id",
		"displayName",
		"description",
		"maxInputTokens",
		"maxOutputTokens",
		"display_name",
		"max_input_tokens",
		"max_tokens",
	];
	return (
		nodeContains(node.body, (child) =>
			isProcessEnvMember(child, CATALOG_ENV),
		) &&
		nodeContains(
			node.body,
			(child) =>
				t.isCallExpression(child) &&
				t.isMemberExpression(child.callee) &&
				t.isIdentifier(child.callee.object, { name: "JSON" }) &&
				getMemberPropertyName(child.callee) === "parse",
		) &&
		requiredKeys.every((key) =>
			key.includes("_")
				? nodeHasObjectKey(node.body, key)
				: nodeHasMemberProperty(node.body, key),
		) &&
		nodeContains(
			node.body,
			(child) =>
				getStaticString(child)?.includes(`${CATALOG_ENV} must be`) === true,
		)
	);
}

function getLeadingGateName(node: t.FunctionDeclaration): string | null {
	const [first, second] = node.body.body;
	const gate = t.isBlockStatement(first) ? second : first;
	if (!t.isIfStatement(gate)) return null;
	if (
		!t.isUnaryExpression(gate.test, { operator: "!" }) ||
		!t.isCallExpression(gate.test.argument) ||
		gate.test.argument.arguments.length !== 0 ||
		!t.isIdentifier(gate.test.argument.callee)
	) {
		return null;
	}
	const consequent = t.isBlockStatement(gate.consequent)
		? gate.consequent.body[0]
		: gate.consequent;
	if (!t.isReturnStatement(consequent) || consequent.argument !== null) {
		return null;
	}
	return gate.test.argument.callee.name;
}

function classifyCapabilityLookup(
	path: NodePath<t.FunctionDeclaration>,
): CapabilityLookupCandidate | null {
	if (!path.node.id || path.node.params.length !== 1) return null;
	const parameter = path.node.params[0];
	const gateName = getLeadingGateName(path.node);
	if (!t.isIdentifier(parameter) || !gateName) return null;
	for (const property of ["id", "toLowerCase", "find", "includes"]) {
		if (!nodeHasMemberProperty(path.node.body, property)) return null;
	}
	return { path, modelName: parameter.name };
}

function getPickerShape(
	path: NodePath<t.FunctionDeclaration>,
): PickerCandidate | null {
	if (!path.node.id || path.node.params.length !== 1) return null;
	if (
		!PICKER_ENV_KEYS.every((key) => nodeHasMemberProperty(path.node.body, key))
	) {
		return null;
	}
	for (const [index, statement] of path.node.body.body.entries()) {
		if (!t.isVariableDeclaration(statement) || statement.kind === "const") {
			continue;
		}
		const customOption = statement.declarations.find(
			(declaration) =>
				declaration.init != null &&
				nodeHasMemberProperty(
					declaration.init,
					"ANTHROPIC_CUSTOM_MODEL_OPTION",
				),
		);
		if (!customOption) continue;
		const options = statement.declarations.find(
			(declaration) =>
				t.isIdentifier(declaration.id) && t.isCallExpression(declaration.init),
		);
		if (!options || !t.isIdentifier(options.id)) return null;
		return {
			path,
			declarationIndex: index,
			optionsName: options.id.name,
		};
	}
	return null;
}

function isCallTo(node: t.Node, functionName: string): boolean {
	return (
		t.isCallExpression(node) &&
		t.isIdentifier(node.callee, { name: functionName }) &&
		node.arguments.length === 0
	);
}

function hasCatalogLookupBlock(
	candidate: CapabilityLookupCandidate,
	helperName: string,
): boolean {
	const statement = candidate.path.node.body.body[0];
	if (!t.isBlockStatement(statement)) return false;
	return (
		nodeContains(statement, (child) => isCallTo(child, helperName)) &&
		nodeHasMemberProperty(statement, "id") &&
		nodeHasMemberProperty(statement, "find") &&
		nodeContains(
			statement,
			(child) => t.isReturnStatement(child) && child.argument !== null,
		)
	);
}

function hasCatalogPickerBlock(
	candidate: PickerCandidate,
	helperName: string,
): boolean {
	const statement =
		candidate.path.node.body.body[candidate.declarationIndex + 1];
	if (!t.isBlockStatement(statement)) return false;
	return (
		nodeContains(statement, (child) => isCallTo(child, helperName)) &&
		nodeHasMemberProperty(statement, "some") &&
		nodeHasMemberProperty(statement, "push") &&
		["value", "label", "description"].every((key) =>
			nodeHasObjectKey(statement, key),
		)
	);
}

function getEnvironmentArrayState(
	array: t.ArrayExpression,
	envName: string,
): "stock" | "patched" | "other" {
	const matches = array.elements.filter((element) =>
		t.isStringLiteral(element, { value: envName }),
	).length;
	if (matches === 0) return "stock";
	return matches === 1 ? "patched" : "other";
}

function patchEnvironmentArray(
	array: t.ArrayExpression,
	envName: string,
): boolean {
	const state = getEnvironmentArrayState(array, envName);
	if (state === "patched") return true;
	if (state !== "stock") return false;
	array.elements.push(t.stringLiteral(envName));
	return true;
}

function buildCatalogHelper(helperName: string): t.FunctionDeclaration {
	const source = parse(`
function ${helperName}() {
  const raw = process.env.${CATALOG_ENV};
  if (raw === void 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("${CATALOG_ENV} must be valid JSON containing an array.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("${CATALOG_ENV} must be a JSON array.");
  }
  if (parsed.length > 64) {
    throw new Error("${CATALOG_ENV} supports at most 64 models.");
  }
  const seen = new Set();
  const reserved = ["inherit", "fable", "opusplan", "sonnet", "haiku", "opus", "best"];
  return parsed.map((value, index) => {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      throw new Error("${CATALOG_ENV} entry " + index + " must be an object.");
    }
    if (typeof value.id !== "string" || !value.id.trim()) {
      throw new Error("${CATALOG_ENV} entry " + index + " must have a nonempty id.");
    }
    const id = value.id.trim();
    const normalizedId = id.toLowerCase();
    if (normalizedId.includes("[1m]") || reserved.includes(normalizedId)) {
      throw new Error("${CATALOG_ENV} entry " + index + " uses a reserved model id.");
    }
    if (seen.has(normalizedId)) {
      throw new Error("${CATALOG_ENV} contains duplicate model ids after case-insensitive normalization.");
    }
    seen.add(normalizedId);
    const displayName = value.displayName;
    if (displayName !== void 0 && (typeof displayName !== "string" || !displayName.trim())) {
      throw new Error("${CATALOG_ENV} entry " + index + " has an invalid displayName.");
    }
    const description = value.description;
    if (description !== void 0 && (typeof description !== "string" || !description.trim())) {
      throw new Error("${CATALOG_ENV} entry " + index + " has an invalid description.");
    }
    const maxInputTokens = value.maxInputTokens;
    if (maxInputTokens !== void 0 && (!Number.isSafeInteger(maxInputTokens) || maxInputTokens <= 0 || maxInputTokens > 1000000)) {
      throw new Error("${CATALOG_ENV} entry " + index + " has an invalid maxInputTokens.");
    }
    const maxOutputTokens = value.maxOutputTokens;
    if (maxOutputTokens !== void 0 && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 4096 || maxOutputTokens > 1000000)) {
      throw new Error("${CATALOG_ENV} entry " + index + " has an invalid maxOutputTokens.");
    }
    return {
      id,
      display_name: displayName === void 0 ? id : displayName.trim(),
      description: description === void 0 ? "Configured model" : description.trim(),
      ...(maxInputTokens === void 0 ? {} : { max_input_tokens: maxInputTokens }),
      ...(maxOutputTokens === void 0 ? {} : { max_tokens: maxOutputTokens }),
    };
  });
}
`);
	const helper = source.program.body[0];
	if (!t.isFunctionDeclaration(helper)) {
		throw new Error("configured-model-catalog: failed to build catalog parser");
	}
	return helper;
}

function buildLookupBlock(
	candidate: CapabilityLookupCandidate,
	helperName: string,
): t.BlockStatement {
	const models = candidate.path.scope.generateUidIdentifier("configuredModels");
	const normalized = candidate.path.scope.generateUidIdentifier(
		"configuredModelName",
	);
	const match = candidate.path.scope.generateUidIdentifier("configuredModel");
	const source = parse(`
function configuredModelLookup() {
{
  const ${models.name} = ${helperName}();
  const ${normalized.name} = String(${candidate.modelName}).trim().toLowerCase();
  const ${match.name} = ${models.name}.find((entry) => entry.id.toLowerCase() === ${normalized.name});
  if (${match.name}) return ${match.name};
}
}
`);
	const wrapper = source.program.body[0];
	const block = t.isFunctionDeclaration(wrapper) ? wrapper.body.body[0] : null;
	if (!t.isBlockStatement(block)) {
		throw new Error(
			"configured-model-catalog: failed to build capability lookup",
		);
	}
	return block;
}

function buildPickerBlock(
	candidate: PickerCandidate,
	helperName: string,
): t.BlockStatement {
	const model = candidate.path.scope.generateUidIdentifier("configuredModel");
	const option = candidate.path.scope.generateUidIdentifier("configuredOption");
	const source = parse(`
{
  for (const ${model.name} of ${helperName}()) {
    if (${candidate.optionsName}.some((${option.name}) => typeof ${option.name}.value === "string" && ${option.name}.value.trim().toLowerCase() === ${model.name}.id.toLowerCase())) continue;
    ${candidate.optionsName}.push({
      value: ${model.name}.id,
      label: ${model.name}.display_name,
      description: ${model.name}.description,
    });
  }
}
`);
	const block = source.program.body[0];
	if (!t.isBlockStatement(block)) {
		throw new Error("configured-model-catalog: failed to build picker options");
	}
	return block;
}

function resolveAnalysis(
	helpers: t.FunctionDeclaration[],
	lookups: CapabilityLookupCandidate[],
	pickers: PickerCandidate[],
	environmentArrays: t.ArrayExpression[],
): PatchAnalysis | string {
	if (helpers.length !== 1) {
		return `Configured model parser is ambiguous or missing (${helpers.length} sites found)`;
	}
	if (lookups.length !== 1) {
		return `Model capability lookup is ambiguous or missing (${lookups.length} sites found)`;
	}
	if (pickers.length !== 1) {
		return `Model picker builder is ambiguous or missing (${pickers.length} sites found)`;
	}
	return {
		helper: helpers[0],
		lookup: lookups[0],
		picker: pickers[0],
		environmentArrays,
	};
}

function createConfiguredModelCatalogPasses(): PatchAstPass[] {
	let programPath: NodePath<t.Program> | null = null;
	const helpers: t.FunctionDeclaration[] = [];
	const lookups: CapabilityLookupCandidate[] = [];
	const pickers: PickerCandidate[] = [];
	const environmentArrays: t.ArrayExpression[] = [];
	let patched = false;

	return [
		{
			pass: "discover",
			visitor: {
				Program(path) {
					programPath = path;
				},
				FunctionDeclaration(path) {
					if (isCatalogHelper(path.node)) helpers.push(path.node);
					const lookup = classifyCapabilityLookup(path);
					if (lookup) lookups.push(lookup);
					const picker = getPickerShape(path);
					if (picker) pickers.push(picker);
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
						try {
							if (
								!programPath ||
								lookups.length !== 1 ||
								pickers.length !== 1
							) {
								return;
							}
							let helper = helpers[0];
							if (helpers.length === 0) {
								const helperName = programPath.scope.generateUidIdentifier(
									"configuredModelCatalog",
								).name;
								helper = buildCatalogHelper(helperName);
								lookups[0].path.insertBefore(helper);
							} else if (helpers.length !== 1) {
								return;
							}
							if (!helper?.id) return;
							const helperName = helper.id.name;
							const lookup = lookups[0];
							const picker = pickers[0];
							if (!hasCatalogLookupBlock(lookup, helperName)) {
								lookup.path.node.body.body.splice(
									0,
									0,
									buildLookupBlock(lookup, helperName),
								);
							}
							if (!hasCatalogPickerBlock(picker, helperName)) {
								picker.path.node.body.body.splice(
									picker.declarationIndex + 1,
									0,
									buildPickerBlock(picker, helperName),
								);
							}
							const environmentPatched =
								environmentArrays.length > 0 &&
								environmentArrays.every((array) =>
									patchEnvironmentArray(array, CATALOG_ENV),
								);
							patched =
								environmentPatched &&
								hasCatalogLookupBlock(lookup, helperName) &&
								hasCatalogPickerBlock(picker, helperName);
						} finally {
							if (!patched) {
								console.warn(
									`Configured model catalog: Could not patch unique catalog surfaces (helpers: ${helpers.length}, lookups: ${lookups.length}, pickers: ${pickers.length}, environment arrays: ${environmentArrays.length})`,
								);
							}
						}
					},
				},
			},
		},
	];
}

export const configuredModelCatalog: Patch = {
	tag: "configured-model-catalog",
	astPasses: () => createConfiguredModelCatalogPasses(),
	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) {
			return "Unable to parse AST during configured-model-catalog verification";
		}
		const helpers: t.FunctionDeclaration[] = [];
		const lookups: CapabilityLookupCandidate[] = [];
		const pickers: PickerCandidate[] = [];
		const environmentArrays = collectSubagentModelEnvArrays(verifyAst);
		traverse(verifyAst, {
			FunctionDeclaration(path) {
				if (isCatalogHelper(path.node)) helpers.push(path.node);
				const lookup = classifyCapabilityLookup(path);
				if (lookup) lookups.push(lookup);
				const picker = getPickerShape(path);
				if (picker) pickers.push(picker);
			},
		});
		const analysis = resolveAnalysis(
			helpers,
			lookups,
			pickers,
			environmentArrays,
		);
		if (typeof analysis === "string") return analysis;
		if (!analysis.helper.id) return "Configured model parser has no binding";
		if (!hasCatalogLookupBlock(analysis.lookup, analysis.helper.id.name)) {
			return "Model capability lookup does not consult the configured catalog";
		}
		if (!hasCatalogPickerBlock(analysis.picker, analysis.helper.id.name)) {
			return "Model picker does not expose configured catalog entries";
		}
		if (environmentArrays.length === 0) {
			return "Configured catalog environment forwarding not found";
		}
		if (
			environmentArrays.some(
				(array) => getEnvironmentArrayState(array, CATALOG_ENV) !== "patched",
			)
		) {
			return "Child process environment forwarding omits the configured catalog";
		}
		return true;
	},
};
