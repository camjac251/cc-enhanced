import * as t from "@babel/types";
import type { NodePath } from "../babel.js";
import { getObjectKeyName } from "./ast-helpers.js";
import {
	getOptionalMemberBase,
	isMetadataPropertyExpression,
	isVoidZero,
} from "./subagent-model-tag-helpers.js";

type PatchSiteState = "patched" | "unpatched" | "other";

export interface ForkResolutionCandidate {
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

export function classifyForkLaunchResolution(
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

export function classifyForkResumeResolution(
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

export function applyForkInheritance(candidate: ForkResolutionCandidate): void {
	if (candidate.state !== "unpatched") return;
	candidate.path.node.init = t.conditionalExpression(
		t.identifier(candidate.forkName),
		t.identifier(candidate.parentModelName),
		candidate.resolverCall,
	);
	candidate.state = "patched";
}
