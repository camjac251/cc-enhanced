import * as t from "@babel/types";
import { type NodePath, traverse } from "../babel.js";
import { parse } from "../loader.js";
import type { Patch, PatchAstPass } from "../types.js";
import { getObjectPropertyByName, getVerifyAst } from "./ast-helpers.js";

const CATALOG_ENV = "CLAUDE_CODE_CONFIGURED_MODEL_CATALOG";
const CATALOG_MARKER = "__ccConfiguredModelIds";
const AUTO_COMPACT_MARKER = "__ccConfiguredAutoCompactWindow";
const CONFIGURED_CONTEXT_MARKER = "__ccConfiguredContextWindow";

type SiteState = "stock" | "patched";

interface CatalogAccessorCandidate {
	path: NodePath<t.FunctionDeclaration>;
	catalogName: string;
	state: SiteState;
}

interface EffectiveContextCandidate {
	path: NodePath<t.FunctionDeclaration>;
	modelName: string;
	state: SiteState;
}

interface AutoCompactCandidate {
	path: NodePath<t.FunctionDeclaration>;
	modelName: string;
	ceilingName: string;
	settingsIndex: number;
	state: SiteState;
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

function getMemberName(node: t.Node | null | undefined): string | null {
	if (!node) return null;
	if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
		if (t.isIdentifier(node.property)) return node.property.name;
		if (t.isStringLiteral(node.property)) return node.property.value;
	}
	return null;
}

function nodeContains(
	node: t.Node | null | undefined,
	predicate: (candidate: t.Node) => boolean,
): boolean {
	if (!node) return false;
	let found = false;
	t.traverseFast(node, (candidate) => {
		if (!found && predicate(candidate)) found = true;
	});
	return found;
}

function isPatchedCatalogBody(body: t.BlockStatement): boolean {
	const hasMarkerBinding = nodeContains(
		body,
		(candidate) =>
			t.isVariableDeclarator(candidate) &&
			t.isIdentifier(candidate.id, { name: CATALOG_MARKER }) &&
			t.isNewExpression(candidate.init) &&
			t.isIdentifier(candidate.init.callee, { name: "Set" }) &&
			candidate.init.arguments.length === 1,
	);
	if (!hasMarkerBinding) return false;

	const requiredRuntimeKeys = [
		"max_input_tokens",
		"max_output_tokens",
		"effort_levels",
		"default_effort",
		"capabilities",
		"auto_compact_window",
	];
	if (
		!requiredRuntimeKeys.every((key) =>
			nodeContains(
				body,
				(candidate) =>
					t.isObjectProperty(candidate) &&
					((t.isIdentifier(candidate.key) && candidate.key.name === key) ||
						(t.isStringLiteral(candidate.key) && candidate.key.value === key)),
			),
		)
	) {
		return false;
	}

	const result = body.body.at(-1);
	if (
		!t.isReturnStatement(result) ||
		!t.isArrayExpression(result.argument) ||
		result.argument.elements.length !== 2
	) {
		return false;
	}
	const [nativeModels, configuredModels] = result.argument.elements;
	if (
		!t.isSpreadElement(nativeModels) ||
		!t.isCallExpression(nativeModels.argument) ||
		!t.isMemberExpression(nativeModels.argument.callee) ||
		getMemberName(nativeModels.argument.callee) !== "filter" ||
		!t.isIdentifier(nativeModels.argument.callee.object, {
			name: "__ccNativeModels",
		}) ||
		!t.isSpreadElement(configuredModels) ||
		!t.isIdentifier(configuredModels.argument, { name: "__ccConfiguredModels" })
	) {
		return false;
	}

	return nodeContains(
		nativeModels.argument,
		(candidate) =>
			t.isCallExpression(candidate) &&
			t.isMemberExpression(candidate.callee) &&
			t.isIdentifier(candidate.callee.object, { name: CATALOG_MARKER }) &&
			getMemberName(candidate.callee) === "has",
	);
}

function isConfiguredCatalogHelper(
	path: NodePath<t.FunctionDeclaration>,
): boolean {
	return (
		path.node.id !== null &&
		nodeContains(
			path.node,
			(candidate) =>
				(t.isMemberExpression(candidate) ||
					t.isOptionalMemberExpression(candidate)) &&
				getMemberName(candidate) === CATALOG_ENV,
		) &&
		nodeContains(
			path.node,
			(candidate) =>
				t.isCallExpression(candidate) &&
				t.isMemberExpression(candidate.callee) &&
				t.isIdentifier(candidate.callee.object, { name: "JSON" }) &&
				getMemberName(candidate.callee) === "parse",
		)
	);
}

function getCatalogModelsExpression(
	argument: t.Expression,
	parameterName: string,
): t.LogicalExpression | null {
	if (!t.isLogicalExpression(argument, { operator: "??" })) return null;
	if (
		!t.isArrayExpression(argument.right) ||
		argument.right.elements.length !== 0
	) {
		return null;
	}
	const models = argument.left;
	if (!t.isMemberExpression(models) || getMemberName(models) !== "models") {
		return null;
	}
	const config = models.object;
	if (
		!t.isMemberExpression(config) ||
		getMemberName(config) !== "config" ||
		!t.isIdentifier(config.object, { name: parameterName })
	) {
		return null;
	}
	return argument;
}

function classifyCatalogAccessor(
	path: NodePath<t.FunctionDeclaration>,
): CatalogAccessorCandidate | null {
	if (!path.node.id || path.node.params.length !== 1) return null;
	const [parameter] = path.node.params;
	if (!t.isIdentifier(parameter)) return null;
	const hasPatchMarker = nodeContains(path.node.body, (candidate) =>
		t.isIdentifier(candidate, { name: CATALOG_MARKER }),
	);
	if (hasPatchMarker) {
		return isPatchedCatalogBody(path.node.body)
			? { path, catalogName: parameter.name, state: "patched" }
			: null;
	}
	if (path.node.body.body.length !== 1) return null;
	const statement = path.node.body.body[0];
	if (!t.isReturnStatement(statement) || !statement.argument) return null;
	if (!getCatalogModelsExpression(statement.argument, parameter.name))
		return null;
	return { path, catalogName: parameter.name, state: "stock" };
}

function isPatchedEffectiveContextBody(body: t.BlockStatement): boolean {
	if (
		!t.isVariableDeclaration(body.body[2]) ||
		!body.body[2].declarations.some((declaration) =>
			t.isIdentifier(declaration.id, { name: CONFIGURED_CONTEXT_MARKER }),
		)
	)
		return false;
	const hasMarkerBinding = nodeContains(
		body,
		(candidate) =>
			t.isVariableDeclarator(candidate) &&
			t.isIdentifier(candidate.id, { name: CONFIGURED_CONTEXT_MARKER }) &&
			t.isOptionalMemberExpression(candidate.init) &&
			getMemberName(candidate.init) === "max_input_tokens",
	);
	const hasSafeIntegerGuard = nodeContains(
		body,
		(candidate) =>
			t.isCallExpression(candidate) &&
			t.isMemberExpression(candidate.callee) &&
			t.isIdentifier(candidate.callee.object, { name: "Number" }) &&
			getMemberName(candidate.callee) === "isSafeInteger" &&
			candidate.arguments.length === 1 &&
			t.isIdentifier(candidate.arguments[0], {
				name: CONFIGURED_CONTEXT_MARKER,
			}),
	);
	const hasPositiveGuard = nodeContains(
		body,
		(candidate) =>
			t.isBinaryExpression(candidate, { operator: ">" }) &&
			t.isIdentifier(candidate.left, { name: CONFIGURED_CONTEXT_MARKER }) &&
			t.isNumericLiteral(candidate.right, { value: 0 }),
	);
	const hasReturn = nodeContains(
		body,
		(candidate) =>
			t.isReturnStatement(candidate) &&
			t.isIdentifier(candidate.argument, { name: CONFIGURED_CONTEXT_MARKER }),
	);
	return (
		hasMarkerBinding && hasSafeIntegerGuard && hasPositiveGuard && hasReturn
	);
}

function classifyEffectiveContextResolver(
	path: NodePath<t.FunctionDeclaration>,
): EffectiveContextCandidate | null {
	if (!path.node.id || path.node.params.length !== 2) return null;
	const [model, provider] = path.node.params;
	if (!t.isIdentifier(model) || !t.isIdentifier(provider)) return null;
	if (isPatchedEffectiveContextBody(path.node.body)) {
		return { path, modelName: model.name, state: "patched" };
	}
	const statements = path.node.body.body;
	if (statements.length !== 4) return null;
	const [decl, explicit, million, fallback] = statements;
	if (
		!t.isVariableDeclaration(decl) ||
		decl.declarations.length !== 1 ||
		!t.isIdentifier(decl.declarations[0].id) ||
		!t.isCallExpression(decl.declarations[0].init) ||
		decl.declarations[0].init.arguments.length !== 0
	) {
		return null;
	}
	const declaredName = decl.declarations[0].id.name;
	if (
		!t.isIfStatement(explicit) ||
		!t.isBinaryExpression(explicit.test, { operator: "!==" }) ||
		!t.isIdentifier(explicit.test.left, { name: declaredName }) ||
		!isVoidZero(explicit.test.right) ||
		!t.isReturnStatement(explicit.consequent) ||
		!t.isIdentifier(explicit.consequent.argument, { name: declaredName })
	) {
		return null;
	}
	if (
		!t.isIfStatement(million) ||
		!t.isCallExpression(million.test) ||
		million.test.arguments.length !== 2 ||
		!t.isReturnStatement(million.consequent) ||
		!t.isReturnStatement(fallback) ||
		!t.isCallExpression(fallback.argument) ||
		fallback.argument.arguments.length !== 2 ||
		!t.isIdentifier(fallback.argument.arguments[0], { name: model.name }) ||
		!t.isIdentifier(fallback.argument.arguments[1], { name: provider.name })
	) {
		return null;
	}
	return { path, modelName: model.name, state: "stock" };
}

function isVoidZero(node: t.Node | null | undefined): boolean {
	return (
		(t.isUnaryExpression(node, { operator: "void" }) &&
			t.isNumericLiteral(node.argument, { value: 0 })) ||
		t.isIdentifier(node, { name: "undefined" })
	);
}

function getReturnObject(statement: t.Statement): t.ObjectExpression | null {
	if (
		t.isReturnStatement(statement) &&
		t.isObjectExpression(statement.argument)
	) {
		return statement.argument;
	}
	if (!t.isBlockStatement(statement)) return null;
	for (const child of statement.body) {
		if (t.isReturnStatement(child) && t.isObjectExpression(child.argument)) {
			return child.argument;
		}
	}
	return null;
}

function getSourceValue(object: t.ObjectExpression): string | null {
	const property = getObjectPropertyByName(object, "source");
	return property ? getStaticString(property.value) : null;
}

function getSettingsCeiling(
	statement: t.IfStatement,
	settingsName: string,
): string | null {
	if (
		!nodeContains(
			statement.test,
			(candidate) =>
				t.isBinaryExpression(candidate, { operator: "!==" }) &&
				t.isIdentifier(candidate.left, { name: settingsName }) &&
				isVoidZero(candidate.right),
		)
	) {
		return null;
	}
	const result = getReturnObject(statement.consequent);
	if (!result || getSourceValue(result) !== "settings") return null;
	const window = getObjectPropertyByName(result, "window");
	if (!window || !t.isCallExpression(window.value)) return null;
	const call = window.value;
	if (
		!t.isMemberExpression(call.callee) ||
		!t.isIdentifier(call.callee.object, { name: "Math" }) ||
		getMemberName(call.callee) !== "min" ||
		call.arguments.length < 2 ||
		!t.isIdentifier(call.arguments[0]) ||
		!t.isIdentifier(call.arguments[1], { name: settingsName })
	) {
		return null;
	}
	return call.arguments[0].name;
}

function isPatchedAutoCompactBody(
	body: t.BlockStatement,
	ceilingName: string,
): boolean {
	const hasMarkerBinding = nodeContains(
		body,
		(candidate) =>
			t.isVariableDeclarator(candidate) &&
			t.isIdentifier(candidate.id, { name: AUTO_COMPACT_MARKER }) &&
			(t.isMemberExpression(candidate.init) ||
				t.isOptionalMemberExpression(candidate.init)) &&
			getMemberName(candidate.init) === "auto_compact_window",
	);
	const hasSafeIntegerGuard = nodeContains(
		body,
		(candidate) =>
			t.isCallExpression(candidate) &&
			t.isMemberExpression(candidate.callee) &&
			t.isIdentifier(candidate.callee.object, { name: "Number" }) &&
			getMemberName(candidate.callee) === "isSafeInteger" &&
			candidate.arguments.length === 1 &&
			t.isIdentifier(candidate.arguments[0], { name: AUTO_COMPACT_MARKER }),
	);
	const hasPositiveGuard = nodeContains(
		body,
		(candidate) =>
			t.isBinaryExpression(candidate, { operator: ">" }) &&
			t.isIdentifier(candidate.left, { name: AUTO_COMPACT_MARKER }) &&
			t.isNumericLiteral(candidate.right, { value: 0 }),
	);
	if (!hasMarkerBinding || !hasSafeIntegerGuard || !hasPositiveGuard)
		return false;

	let resultObject: t.ObjectExpression | null = null;
	t.traverseFast(body, (candidate) => {
		if (
			resultObject === null &&
			t.isReturnStatement(candidate) &&
			t.isObjectExpression(candidate.argument) &&
			getSourceValue(candidate.argument) === "model-default"
		) {
			resultObject = candidate.argument;
		}
	});
	const patchedResult = resultObject as t.ObjectExpression | null;
	if (patchedResult === null) return false;

	const configured = getObjectPropertyByName(patchedResult, "configured");
	const window = getObjectPropertyByName(patchedResult, "window");
	return (
		configured !== null &&
		t.isIdentifier(configured.value, { name: AUTO_COMPACT_MARKER }) &&
		window !== null &&
		t.isCallExpression(window.value) &&
		t.isMemberExpression(window.value.callee) &&
		t.isIdentifier(window.value.callee.object, { name: "Math" }) &&
		getMemberName(window.value.callee) === "min" &&
		window.value.arguments.length === 2 &&
		t.isIdentifier(window.value.arguments[0], { name: ceilingName }) &&
		t.isIdentifier(window.value.arguments[1], { name: AUTO_COMPACT_MARKER })
	);
}

function classifyAutoCompactResolver(
	path: NodePath<t.FunctionDeclaration>,
): AutoCompactCandidate | null {
	if (!path.node.id || path.node.params.length < 2) return null;
	const [model, settings] = path.node.params;
	if (!t.isIdentifier(model) || !t.isIdentifier(settings)) return null;
	if (
		!nodeContains(
			path.node.body,
			(candidate) =>
				(t.isMemberExpression(candidate) ||
					t.isOptionalMemberExpression(candidate)) &&
				getMemberName(candidate) === "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
		)
	) {
		return null;
	}
	for (let index = 0; index < path.node.body.body.length; index += 1) {
		const statement = path.node.body.body[index];
		if (!t.isIfStatement(statement)) continue;
		const ceilingName = getSettingsCeiling(statement, settings.name);
		if (!ceilingName) continue;
		return {
			path,
			modelName: model.name,
			ceilingName,
			settingsIndex: index,
			state: isPatchedAutoCompactBody(path.node.body, ceilingName)
				? "patched"
				: "stock",
		};
	}
	return null;
}

function buildCatalogBody(
	candidate: CatalogAccessorCandidate,
	helperName: string,
): t.BlockStatement {
	const source = parse(`
function mergeConfiguredModels(${candidate.catalogName}) {
  const __ccNativeModels = ${candidate.catalogName}.config.models ?? [];
  const __ccConfiguredModels = ${helperName}().map((entry) => {
    const __ccConfiguredEffortLevels = entry.capabilities === void 0
      ? void 0
      : [
          "low",
          "medium",
          "high",
          ...(entry.capabilities.includes("xhigh_effort") ? ["xhigh"] : []),
          ...(entry.capabilities.includes("max_effort") ? ["max"] : []),
        ];
    return {
      id: entry.id,
      name: entry.display_name,
      description: entry.description,
      runtime: {
        ...(entry.max_input_tokens === void 0 ? {} : { max_input_tokens: entry.max_input_tokens }),
        ...(entry.max_tokens === void 0 ? {} : { max_output_tokens: entry.max_tokens }),
        ...(__ccConfiguredEffortLevels === void 0 ? {} : { effort_levels: __ccConfiguredEffortLevels }),
        ...(entry.default_effort === void 0 ? {} : { default_effort: entry.default_effort }),
        ...(entry.capabilities === void 0 ? {} : { capabilities: entry.capabilities }),
        ...(entry.auto_compact_window === void 0 ? {} : { auto_compact_window: entry.auto_compact_window }),
      },
    };
  });
  const ${CATALOG_MARKER} = new Set(
    __ccConfiguredModels.map((entry) => entry.id.trim().toLowerCase()),
  );
  return [
    ...__ccNativeModels.filter(
      (entry) => !${CATALOG_MARKER}.has(entry.id.trim().toLowerCase()),
    ),
    ...__ccConfiguredModels,
  ];
}
`);
	const wrapper = source.program.body[0];
	if (!t.isFunctionDeclaration(wrapper)) {
		throw new Error("model-context-metadata: failed to build catalog merge");
	}
	return wrapper.body;
}
function buildEffectiveContextStatements(
	candidate: EffectiveContextCandidate,
	helperName: string,
): t.Statement[] {
	const source = parse(
		`function configuredContext(${candidate.modelName}) {
  const ${CONFIGURED_CONTEXT_MARKER} = ${helperName}().find(
    (entry) => entry.id.trim().toLowerCase() === String(${candidate.modelName}).trim().toLowerCase(),
  )?.max_input_tokens;
  if (Number.isSafeInteger(${CONFIGURED_CONTEXT_MARKER}) && ${CONFIGURED_CONTEXT_MARKER} > 0) {
    return ${CONFIGURED_CONTEXT_MARKER};
  }
}`,
	);
	const wrapper = source.program.body[0];
	if (!t.isFunctionDeclaration(wrapper)) {
		throw new Error("model-context-metadata: failed to build context merge");
	}
	return wrapper.body.body;
}
function buildAutoCompactStatements(
	candidate: AutoCompactCandidate,
	helperName: string,
): t.Statement[] {
	const source = parse(`
function configuredAutoCompact(${candidate.modelName}, ${candidate.ceilingName}) {
  const __ccConfiguredModel = ${helperName}().find(
    (entry) => entry.id.trim().toLowerCase() === String(${candidate.modelName}).trim().toLowerCase(),
  );
  const ${AUTO_COMPACT_MARKER} = __ccConfiguredModel?.auto_compact_window;
  if (
    Number.isSafeInteger(${AUTO_COMPACT_MARKER}) &&
    ${AUTO_COMPACT_MARKER} > 0
  ) {
    return {
      window: Math.min(${candidate.ceilingName}, ${AUTO_COMPACT_MARKER}),
      configured: ${AUTO_COMPACT_MARKER},
      source: "model-default",
    };
  }
}
`);
	const wrapper = source.program.body[0];
	if (!t.isFunctionDeclaration(wrapper)) {
		throw new Error(
			"model-context-metadata: failed to build auto-compact merge",
		);
	}
	return wrapper.body.body;
}

function topLevelFunctions(
	programPath: NodePath<t.Program>,
): NodePath<t.FunctionDeclaration>[] {
	return programPath
		.get("body")
		.filter((path): path is NodePath<t.FunctionDeclaration> =>
			path.isFunctionDeclaration(),
		);
}

function applyLatestMetadataIntegration(
	programPath: NodePath<t.Program>,
): boolean {
	const functions = topLevelFunctions(programPath);
	const helpers = functions.filter(isConfiguredCatalogHelper);
	const accessors = functions
		.map(classifyCatalogAccessor)
		.filter((candidate): candidate is CatalogAccessorCandidate =>
			Boolean(candidate),
		);
	const contexts = functions
		.map(classifyEffectiveContextResolver)
		.filter((candidate): candidate is EffectiveContextCandidate =>
			Boolean(candidate),
		);
	const autoCompact = functions
		.map(classifyAutoCompactResolver)
		.filter((candidate): candidate is AutoCompactCandidate =>
			Boolean(candidate),
		);
	if (
		helpers.length !== 1 ||
		accessors.length !== 1 ||
		contexts.length !== 1 ||
		autoCompact.length !== 1
	) {
		console.warn(
			`Model context metadata: expected one configured helper, catalog accessor, effective context resolver, and auto-compact resolver; found helpers=${helpers.length}, accessors=${accessors.length}, contexts=${contexts.length}, autoCompact=${autoCompact.length}`,
		);
		return false;
	}
	const helperName = helpers[0].node.id?.name;
	if (!helperName) return false;
	if (accessors[0].state === "stock") {
		accessors[0].path.node.body = buildCatalogBody(accessors[0], helperName);
	}
	if (contexts[0].state === "stock") {
		contexts[0].path.node.body.body.splice(
			2,
			0,
			...buildEffectiveContextStatements(contexts[0], helperName),
		);
	}
	if (autoCompact[0].state === "stock") {
		autoCompact[0].path.node.body.body.splice(
			autoCompact[0].settingsIndex + 1,
			0,
			...buildAutoCompactStatements(autoCompact[0], helperName),
		);
	}
	return (
		classifyCatalogAccessor(accessors[0].path)?.state === "patched" &&
		classifyEffectiveContextResolver(contexts[0].path)?.state === "patched" &&
		classifyAutoCompactResolver(autoCompact[0].path)?.state === "patched"
	);
}

function createModelContextMetadataPasses(): PatchAstPass[] {
	let patched = false;
	return [
		{
			pass: "finalize",
			visitor: {
				Program: {
					exit(path) {
						patched = applyLatestMetadataIntegration(path);
						if (!patched) {
							console.warn(
								"Model context metadata: Could not integrate configured models with native runtime metadata",
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
		let helperCount = 0;
		const accessors: CatalogAccessorCandidate[] = [];
		const contexts: EffectiveContextCandidate[] = [];
		const autoCompact: AutoCompactCandidate[] = [];
		traverse(verifyAst, {
			FunctionDeclaration(path) {
				if (isConfiguredCatalogHelper(path)) helperCount += 1;
				const accessor = classifyCatalogAccessor(path);
				if (accessor) accessors.push(accessor);
				const context = classifyEffectiveContextResolver(path);
				if (context) contexts.push(context);
				const auto = classifyAutoCompactResolver(path);
				if (auto) autoCompact.push(auto);
			},
		});
		if (helperCount !== 1) {
			return `Configured model catalog helper is ambiguous or missing (${helperCount} sites found)`;
		}
		if (accessors.length !== 1) {
			return `Native model catalog accessor is ambiguous or missing (${accessors.length} sites found)`;
		}
		if (accessors[0].state !== "patched") {
			return "Configured models are not merged into native runtime metadata";
		}
		if (contexts.length !== 1) {
			return `Effective context resolver is ambiguous or missing (${contexts.length} sites found)`;
		}
		if (contexts[0].state !== "patched") {
			return "Configured maxInputTokens are not applied before native context clamps";
		}
		if (autoCompact.length !== 1) {
			return `Auto-compact resolver is ambiguous or missing (${autoCompact.length} sites found)`;
		}
		if (autoCompact[0].state !== "patched") {
			return "Configured per-model auto-compact metadata is not active";
		}
		return true;
	},
};
