import * as t from "@babel/types";
import { type NodePath, traverse } from "../babel.js";
import { parse } from "../loader.js";
import type { Patch, PatchAstPass } from "../types.js";
import { getMemberPropertyName, getVerifyAst } from "./ast-helpers.js";

const ORIGINAL_NETWORK_ENV = "CLODEX_ORIGINAL_NETWORK_ENV";
const CHILD_NETWORK_MODE = "CLODEX_CHILD_NETWORK_MODE";
const CHILD_UPSTREAM_PROXY = "CLODEX_CHILD_UPSTREAM_PROXY";
const PROXY_ENV_VARS = [
	"HTTPS_PROXY",
	"HTTP_PROXY",
	"https_proxy",
	"http_proxy",
] as const;
const NETWORK_ENV_VARS = [
	...PROXY_ENV_VARS,
	"NO_PROXY",
	"no_proxy",
	"NODE_EXTRA_CA_CERTS",
] as const;
const BUILDER_ANCHORS = [
	"getAgentProxyEnv",
	"CLAUDE_CODE_SUBSCRIPTION_TYPE",
	"CLAUDE_CODE_RATE_LIMIT_TIER",
] as const;

type CandidateState = "stock" | "patched" | "other";

interface ChildEnvironmentCandidate {
	path: NodePath<t.FunctionDeclaration>;
	state: CandidateState;
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

function isProcessEnv(
	node: t.Node | null | undefined,
): node is t.MemberExpression {
	return (
		t.isMemberExpression(node) &&
		!node.computed &&
		t.isIdentifier(node.object, { name: "process" }) &&
		t.isIdentifier(node.property, { name: "env" })
	);
}

function hasCall(
	node: t.Node,
	objectName: string,
	methodName: string,
): boolean {
	return nodeContains(
		node,
		(child) =>
			t.isCallExpression(child) &&
			t.isMemberExpression(child.callee) &&
			t.isIdentifier(child.callee.object, { name: objectName }) &&
			getMemberPropertyName(child.callee) === methodName,
	);
}

function hasRestorePrelude(node: t.FunctionDeclaration): boolean {
	return (
		[ORIGINAL_NETWORK_ENV, CHILD_NETWORK_MODE, CHILD_UPSTREAM_PROXY].every(
			(name) =>
				nodeContains(node.body, (child) => getStaticString(child) === name),
		) &&
		NETWORK_ENV_VARS.every((name) =>
			nodeContains(node.body, (child) => getStaticString(child) === name),
		) &&
		["original", "direct", "upstream"].every((mode) =>
			nodeContains(node.body, (child) => getStaticString(child) === mode),
		) &&
		hasCall(node.body, "JSON", "parse") &&
		hasCall(node.body, "Array", "isArray")
	);
}

function classifyChildEnvironment(
	path: NodePath<t.FunctionDeclaration>,
): ChildEnvironmentCandidate | null {
	if (!path.node.id || path.node.params.length !== 0) return null;
	if (
		!BUILDER_ANCHORS.every((name) =>
			nodeHasMemberProperty(path.node.body, name),
		)
	) {
		return null;
	}
	const hasMarker = nodeContains(
		path.node.body,
		(child) => getStaticString(child) === ORIGINAL_NETWORK_ENV,
	);
	return {
		path,
		state: hasMarker
			? hasRestorePrelude(path.node)
				? "patched"
				: "other"
			: "stock",
	};
}

function buildRestorePrelude(
	path: NodePath<t.FunctionDeclaration>,
	childEnvName: string,
): t.Statement[] {
	const original = path.scope.generateUidIdentifier(
		"originalNetworkEnvironment",
	);
	const mode = path.scope.generateUidIdentifier("childNetworkMode");
	const upstreamProxy = path.scope.generateUidIdentifier("childUpstreamProxy");
	const snapshot = path.scope.generateUidIdentifier("networkSnapshot");
	const key = path.scope.generateUidIdentifier("networkKey");
	const parseError = path.scope.generateUidIdentifier("networkSnapshotError");
	const source = parse(`
function restoreChildNetworkEnvironment() {
  let ${childEnvName} = process.env,
    ${original.name} = ${childEnvName}[${JSON.stringify(ORIGINAL_NETWORK_ENV)}],
    ${mode.name} = ${childEnvName}[${JSON.stringify(CHILD_NETWORK_MODE)}] || "original",
    ${upstreamProxy.name} = ${childEnvName}[${JSON.stringify(CHILD_UPSTREAM_PROXY)}];
  if (
    ${original.name} !== void 0 ||
    ${childEnvName}[${JSON.stringify(CHILD_NETWORK_MODE)}] !== void 0 ||
    ${childEnvName}[${JSON.stringify(CHILD_UPSTREAM_PROXY)}] !== void 0
  ) {
    ${childEnvName} = { ...${childEnvName} };
    delete ${childEnvName}[${JSON.stringify(ORIGINAL_NETWORK_ENV)}];
    delete ${childEnvName}[${JSON.stringify(CHILD_NETWORK_MODE)}];
    delete ${childEnvName}[${JSON.stringify(CHILD_UPSTREAM_PROXY)}];
    if (${mode.name} === "direct" || ${mode.name} === "upstream") {
      for (let ${key.name} of ${JSON.stringify(NETWORK_ENV_VARS)}) {
        delete ${childEnvName}[${key.name}];
      }
    }
    if (
      ${mode.name} === "upstream" &&
      typeof ${upstreamProxy.name} === "string" &&
      ${upstreamProxy.name}
    ) {
      for (let ${key.name} of ${JSON.stringify(PROXY_ENV_VARS)}) {
        ${childEnvName}[${key.name}] = ${upstreamProxy.name};
      }
    }
    if (${mode.name} === "original" && ${original.name} !== void 0) {
      try {
        let ${snapshot.name} = JSON.parse(${original.name});
        if (${snapshot.name} && typeof ${snapshot.name} === "object" && !Array.isArray(${snapshot.name})) {
          for (let ${key.name} of ${JSON.stringify(NETWORK_ENV_VARS)}) {
            if (typeof ${snapshot.name}[${key.name}] === "string") {
              ${childEnvName}[${key.name}] = ${snapshot.name}[${key.name}];
            } else {
              delete ${childEnvName}[${key.name}];
            }
          }
        }
      } catch (${parseError.name}) {
        if (!(${parseError.name} instanceof SyntaxError)) throw ${parseError.name};
      }
    }
  }
}
`);
	const wrapper = source.program.body[0];
	if (!t.isFunctionDeclaration(wrapper)) {
		throw new Error("child-network-env: failed to build restore prelude");
	}
	return wrapper.body.body;
}

function patchCandidate(candidate: ChildEnvironmentCandidate): boolean {
	if (candidate.state === "patched") return true;
	if (candidate.state !== "stock") return false;
	const childEnv =
		candidate.path.scope.generateUidIdentifier("childEnvironment");
	const processEnvPaths: NodePath<t.MemberExpression>[] = [];
	candidate.path.traverse({
		MemberExpression(path) {
			if (isProcessEnv(path.node)) processEnvPaths.push(path);
		},
	});
	if (processEnvPaths.length === 0) return false;
	for (const path of processEnvPaths) {
		path.replaceWith(t.identifier(childEnv.name));
	}
	candidate.path.node.body.body.unshift(
		...buildRestorePrelude(candidate.path, childEnv.name),
	);
	candidate.path.scope.crawl();
	return hasRestorePrelude(candidate.path.node);
}

function countProcessEnv(node: t.FunctionDeclaration): number {
	let count = 0;
	t.traverseFast(node.body, (child) => {
		if (isProcessEnv(child)) count += 1;
	});
	return count;
}

function createChildNetworkEnvPasses(): PatchAstPass[] {
	const candidates: ChildEnvironmentCandidate[] = [];
	let patched = false;
	return [
		{
			pass: "discover",
			visitor: {
				FunctionDeclaration(path) {
					const candidate = classifyChildEnvironment(path);
					if (candidate) candidates.push(candidate);
				},
			},
		},
		{
			pass: "finalize",
			visitor: {
				Program: {
					exit() {
						if (candidates.length === 1) {
							patched = patchCandidate(candidates[0]);
						}
						if (!patched) {
							console.warn(
								`Child network environment: Could not patch a unique child environment builder (${candidates.length} sites found)`,
							);
						}
					},
				},
			},
		},
	];
}

export const childNetworkEnv: Patch = {
	tag: "child-network-env",
	astPasses: () => createChildNetworkEnvPasses(),
	verify: (code, ast) => {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) {
			return "Unable to parse AST during child-network-env verification";
		}
		const candidates: ChildEnvironmentCandidate[] = [];
		traverse(verifyAst, {
			FunctionDeclaration(path) {
				const candidate = classifyChildEnvironment(path);
				if (candidate) candidates.push(candidate);
			},
		});
		if (candidates.length !== 1) {
			return `Child environment builder is ambiguous or missing (${candidates.length} sites found)`;
		}
		if (candidates[0].state !== "patched") {
			return "Child environment builder does not apply the selected network policy";
		}
		if (countProcessEnv(candidates[0].path.node) !== 1) {
			return "Child environment builder still reads the routed process environment directly";
		}
		return true;
	},
};
