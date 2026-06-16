import * as t from "@babel/types";
import { template, traverse } from "../babel.js";
import type { Patch, PatchAstPass } from "../types.js";
import {
	getObjectPropertyByName,
	getVerifyAst,
	isMemberPropertyName,
} from "./ast-helpers.js";

/**
 * Adds a `global-paths:` skill frontmatter field that path-activates a skill
 * when a touched file matches a glob anywhere on the filesystem, not just
 * inside the project cwd (which is all stock `paths:` can reach).
 *
 * Stock matching: each `paths:` glob is tested against `relative(cwd, file)`,
 * and files outside cwd (relative starts with "..") are skipped. `global-paths:`
 * globs are instead tested against the absolute path, so a skill can activate
 * on e.g. a global skills dir or a CLAUDE.md anywhere on disk, regardless of
 * cwd. The same gitignore syntax (including `!` negation for exclusions) applies.
 *
 * Implementation is purely additive: `global-paths` entries are normalized
 * (leading `~` expanded, leading `/` stripped, `!` negation preserved) and
 * merged into the skill object's existing `paths` array behind a private-use
 * sentinel prefix. Because they live in `paths`, the stock conditional-skill
 * bucketing and storage pick the skill up unchanged (a skill needs at least one
 * path entry to be path-activated). The activation matcher then splits the
 * array back apart: non-sentinel entries match cwd-relative (stock behavior),
 * sentinel entries match the absolute path. Unpatched Claude Code never reads
 * `global-paths`, so a skill carrying it degrades gracefully (global triggers
 * simply do not fire on stock).
 *
 * Three anchors:
 *   1. inject two self-contained helpers at module top (no minified deps),
 *   2. wrap the skill-dir loader's `paths` value with the merge helper,
 *   3. teach the conditional-skill activation matcher to split and also match
 *      the absolute path against sentinel (global) entries.
 */

const MERGE_HELPER = "_claudePatchMergeGlobalPaths";
const SPLIT_HELPER = "_claudePatchSplitPaths";
const SPLIT_BINDING = "_claudeGpSplit";
const GLOBAL_IGNORE_BINDING = "_claudeGpIgnore";

function buildMergeHelper(): t.Statement {
	return template.statement(
		`
function ${MERGE_HELPER}(localPaths, frontmatter) {
  var marker = String.fromCharCode(57344);
  var base = Array.isArray(localPaths) ? localPaths.slice() : [];
  var raw = frontmatter == null ? null : frontmatter["global-paths"];
  if (raw == null) return base.length > 0 ? base : void 0;
  var list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  var home = "";
  try {
    home = (process.env.HOME || process.env.USERPROFILE) || "";
  } catch (e) {
    home = "";
  }
  for (var i = 0; i < list.length; i++) {
    var entry = list[i];
    if (typeof entry !== "string") continue;
    entry = entry.trim();
    if (entry.length === 0) continue;
    var neg = entry.charCodeAt(0) === 33;
    var body = neg ? entry.slice(1) : entry;
    if (body.charCodeAt(0) === 126 && (body.length === 1 || body.charCodeAt(1) === 47))
      body = home + body.slice(1);
    body = body.replace(/^\\/+/, "");
    if (body.length === 0) continue;
    base.push(marker + (neg ? "!" : "") + body);
  }
  return base.length > 0 ? base : void 0;
}
`,
		{ placeholderPattern: false },
	)();
}

function buildSplitHelper(): t.Statement {
	return template.statement(
		`
function ${SPLIT_HELPER}(paths) {
  var marker = 57344;
  var local = [];
  var global = [];
  if (Array.isArray(paths)) {
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i];
      if (typeof p === "string" && p.length > 0 && p.charCodeAt(0) === marker) global.push(p.slice(1));
      else local.push(p);
    }
  }
  return { local: local, global: global };
}
`,
		{ placeholderPattern: false },
	)();
}

/**
 * Anchor 2: the skill-dir loader builds the skill object via a factory call
 * whose argument carries `loadedFrom: "skills"` and `paths: <identifier>`,
 * where the identifier binds to `extractPaths(frontmatter)`. Wrap the paths
 * value with the merge helper, passing the frontmatter resolved from the
 * paths-binding's initializer.
 */
function tryWrapSkillPaths(path: {
	node: t.ObjectExpression;
	scope: any;
}): boolean {
	const obj = path.node;
	const loadedFrom = getObjectPropertyByName(obj, "loadedFrom");
	if (
		!loadedFrom ||
		!t.isStringLiteral(loadedFrom.value, { value: "skills" })
	) {
		return false;
	}
	const pathsProp = getObjectPropertyByName(obj, "paths");
	if (!pathsProp || !t.isIdentifier(pathsProp.value)) return false;

	const binding = path.scope.getBinding(pathsProp.value.name);
	if (!binding || !t.isVariableDeclarator(binding.path.node)) return false;
	const init = binding.path.node.init;
	if (
		!t.isCallExpression(init) ||
		init.arguments.length < 1 ||
		!t.isIdentifier(init.arguments[0])
	) {
		return false;
	}
	const frontmatterId = init.arguments[0];

	pathsProp.value = t.callExpression(t.identifier(MERGE_HELPER), [
		t.cloneNode(pathsProp.value, true),
		t.cloneNode(frontmatterId, true),
	]);
	return true;
}

/**
 * Anchor 3: the activation matcher iterates `*.conditionalSkills`, builds a
 * gitignore matcher from `<skill>.paths`, and tests it against the cwd-relative
 * path. Split the array, keep the cwd matcher over local entries, build a
 * second matcher over global (sentinel) entries, and test it against the
 * absolute path before the cwd-skip guard.
 */
function tryPatchActivationLoop(node: t.ForOfStatement): boolean {
	const right = node.right;
	if (
		!t.isMemberExpression(right) ||
		!isMemberPropertyName(right, "conditionalSkills")
	) {
		return false;
	}
	if (!t.isVariableDeclaration(node.left)) return false;
	const loopId = node.left.declarations[0]?.id;
	if (!t.isArrayPattern(loopId) || loopId.elements.length < 2) return false;
	const skillEl = loopId.elements[1];
	if (!t.isIdentifier(skillEl)) return false;
	const skillVar = skillEl.name;

	if (!t.isBlockStatement(node.body)) return false;
	const outerBody = node.body.body;

	// Find: let A = <factory>.add(<skill>.paths);
	let matcherIdx = -1;
	let matcherName: string | null = null;
	let factory: t.Expression | null = null;
	let matcherInit: t.CallExpression | null = null;
	for (let i = 0; i < outerBody.length; i++) {
		const st = outerBody[i];
		if (!t.isVariableDeclaration(st) || st.declarations.length !== 1) continue;
		const d = st.declarations[0];
		if (!t.isIdentifier(d.id) || !t.isCallExpression(d.init)) continue;
		const callee = d.init.callee;
		if (!t.isMemberExpression(callee) || !isMemberPropertyName(callee, "add"))
			continue;
		const arg0 = d.init.arguments[0];
		if (
			!t.isMemberExpression(arg0) ||
			!t.isIdentifier(arg0.object, { name: skillVar }) ||
			!isMemberPropertyName(arg0, "paths")
		) {
			continue;
		}
		matcherIdx = i;
		matcherName = d.id.name;
		factory = callee.object;
		matcherInit = d.init;
		break;
	}
	if (matcherIdx === -1 || !matcherName || !factory || !matcherInit)
		return false;

	// Find the inner per-file loop and its `if (A.ignores(f))` activation block.
	const innerFor = outerBody.find((st): st is t.ForOfStatement =>
		t.isForOfStatement(st),
	);
	if (!innerFor || !t.isBlockStatement(innerFor.body)) return false;
	const innerBody = innerFor.body.body;

	const innerLoopId =
		t.isVariableDeclaration(innerFor.left) &&
		t.isIdentifier(innerFor.left.declarations[0]?.id)
			? innerFor.left.declarations[0].id.name
			: null;
	if (!innerLoopId) return false;

	const fIdx = innerBody.findIndex((st) => t.isVariableDeclaration(st));
	if (fIdx === -1) return false;

	const activationIf = innerBody.find(
		(st): st is t.IfStatement =>
			t.isIfStatement(st) &&
			t.isCallExpression(st.test) &&
			t.isMemberExpression(st.test.callee) &&
			t.isIdentifier(st.test.callee.object, { name: matcherName }) &&
			isMemberPropertyName(st.test.callee, "ignores"),
	);
	if (!activationIf) return false;

	// --- mutate ---
	// Rewrite the cwd matcher to operate over local entries only.
	matcherInit.arguments[0] = t.memberExpression(
		t.identifier(SPLIT_BINDING),
		t.identifier("local"),
	);

	const splitDecl = t.variableDeclaration("let", [
		t.variableDeclarator(
			t.identifier(SPLIT_BINDING),
			t.callExpression(t.identifier(SPLIT_HELPER), [
				t.memberExpression(t.identifier(skillVar), t.identifier("paths")),
			]),
		),
	]);

	const globalMatcher = t.variableDeclaration("let", [
		t.variableDeclarator(
			t.identifier(GLOBAL_IGNORE_BINDING),
			t.conditionalExpression(
				t.binaryExpression(
					">",
					t.memberExpression(
						t.memberExpression(
							t.identifier(SPLIT_BINDING),
							t.identifier("global"),
						),
						t.identifier("length"),
					),
					t.numericLiteral(0),
				),
				t.callExpression(
					t.memberExpression(t.cloneNode(factory, true), t.identifier("add")),
					[
						t.memberExpression(
							t.identifier(SPLIT_BINDING),
							t.identifier("global"),
						),
					],
				),
				t.nullLiteral(),
			),
		),
	]);

	outerBody.splice(matcherIdx, 0, splitDecl);
	outerBody.splice(matcherIdx + 2, 0, globalMatcher);

	// Inject the absolute-path check after `let f = ...`, before the cwd-skip.
	const stripCall = t.callExpression(
		t.memberExpression(t.identifier(innerLoopId), t.identifier("replace")),
		[t.regExpLiteral("^\\/+", ""), t.stringLiteral("")],
	);
	const globalTest = t.logicalExpression(
		"&&",
		t.identifier(GLOBAL_IGNORE_BINDING),
		t.callExpression(
			t.memberExpression(
				t.identifier(GLOBAL_IGNORE_BINDING),
				t.identifier("ignores"),
			),
			[stripCall],
		),
	);
	const globalIf = t.ifStatement(
		globalTest,
		t.cloneNode(activationIf.consequent, true),
	);
	innerBody.splice(fIdx + 1, 0, globalIf);

	return true;
}

function createSkillGlobalPathsPasses(): PatchAstPass[] {
	let wrappedLoader = false;
	let patchedMatcher = false;

	return [
		{
			pass: "mutate",
			visitor: {
				ObjectExpression(path) {
					if (wrappedLoader) return;
					if (tryWrapSkillPaths(path)) wrappedLoader = true;
				},
				ForOfStatement(path) {
					if (patchedMatcher) return;
					if (tryPatchActivationLoop(path.node)) patchedMatcher = true;
				},
				Program: {
					exit(path) {
						if (wrappedLoader || patchedMatcher) {
							path.node.body.unshift(buildSplitHelper());
							path.node.body.unshift(buildMergeHelper());
						}
						if (!wrappedLoader) {
							console.warn(
								"skill-global-paths: could not find skill-dir paths loader to wrap",
							);
						}
						if (!patchedMatcher) {
							console.warn(
								"skill-global-paths: could not find conditional-skill activation matcher",
							);
						}
					},
				},
			},
		},
	];
}

function verifySkillGlobalPaths(ast: t.File): true | string {
	let mergeHelper = false;
	let splitHelper = false;
	let pathsWrapped = false;
	let matcherSplit = false;
	// Structural proof that the activation-loop mutation landed, keyed on the
	// patch's own injected sentinel bindings rather than on global helper
	// presence: the cwd matcher rewritten to local-only entries, and the global
	// activation branch testing the absolute path against the global matcher.
	let localRewrite = false;
	let globalActivationIf = false;

	const isSplitMember = (node: t.Node | null | undefined, prop: string) =>
		!!node &&
		t.isMemberExpression(node) &&
		t.isIdentifier(node.object, { name: SPLIT_BINDING }) &&
		isMemberPropertyName(node, prop);

	traverse(ast, {
		FunctionDeclaration(path) {
			if (t.isIdentifier(path.node.id, { name: MERGE_HELPER }))
				mergeHelper = true;
			if (t.isIdentifier(path.node.id, { name: SPLIT_HELPER }))
				splitHelper = true;
		},
		ObjectExpression(path) {
			const loadedFrom = getObjectPropertyByName(path.node, "loadedFrom");
			if (
				!loadedFrom ||
				!t.isStringLiteral(loadedFrom.value, { value: "skills" })
			) {
				return;
			}
			const pathsProp = getObjectPropertyByName(path.node, "paths");
			if (
				pathsProp &&
				t.isCallExpression(pathsProp.value) &&
				t.isIdentifier(pathsProp.value.callee, { name: MERGE_HELPER }) &&
				pathsProp.value.arguments.length === 2 &&
				t.isIdentifier(pathsProp.value.arguments[1])
			) {
				pathsWrapped = true;
			}
		},
		CallExpression(path) {
			const callee = path.node.callee;
			if (t.isIdentifier(callee, { name: SPLIT_HELPER })) {
				matcherSplit = true;
			}
			// The cwd matcher's `.add(...)` argument must now be `_claudeGpSplit.local`
			// (local-only), proving the local/global partition rewrite landed and not
			// just that the split helper is referenced somewhere.
			if (
				t.isMemberExpression(callee) &&
				isMemberPropertyName(callee, "add") &&
				isSplitMember(path.node.arguments[0], "local")
			) {
				localRewrite = true;
			}
		},
		IfStatement(path) {
			// The injected global activation branch is `if (_claudeGpIgnore &&
			// _claudeGpIgnore.ignores(...))`. Match the exact null-guarded shape so a
			// regression that drops the branch or the guard fails verification.
			const test = path.node.test;
			if (!t.isLogicalExpression(test, { operator: "&&" })) return;
			if (!t.isIdentifier(test.left, { name: GLOBAL_IGNORE_BINDING })) return;
			if (
				t.isCallExpression(test.right) &&
				t.isMemberExpression(test.right.callee) &&
				t.isIdentifier(test.right.callee.object, {
					name: GLOBAL_IGNORE_BINDING,
				}) &&
				isMemberPropertyName(test.right.callee, "ignores")
			) {
				globalActivationIf = true;
			}
		},
	});

	if (!mergeHelper) return "global-paths merge helper not injected";
	if (!splitHelper) return "global-paths split helper not injected";
	if (!pathsWrapped) {
		return "skill-dir loader paths value was not wrapped with the merge helper";
	}
	if (!matcherSplit) {
		return "conditional-skill activation matcher was not split for global paths";
	}
	if (!localRewrite) {
		return "conditional-skill cwd matcher was not rewritten to local-only paths";
	}
	if (!globalActivationIf) {
		return "global-paths activation branch for absolute-path matching not injected";
	}
	return true;
}

export const skillGlobalPaths: Patch = {
	tag: "skill-global-paths",
	astPasses: () => createSkillGlobalPathsPasses(),
	verify(code, ast) {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) {
			return "Could not parse code for skill global paths verification";
		}
		return verifySkillGlobalPaths(verifyAst);
	},
};
