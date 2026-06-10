import * as t from "@babel/types";
import { template, traverse } from "../babel.js";
import type { Patch, PatchAstPass } from "../types.js";
import {
	getObjectPropertyByName,
	getVerifyAst,
	isMemberPropertyName,
} from "./ast-helpers.js";

/**
 * Surfaces a visible notice when a `paths:` / `global-paths:` skill activates
 * because a touched file matched, instead of the stock behavior where the
 * activation only writes a debug log and nothing is surfaced to the user.
 *
 * Reuses the existing `dynamic_skill` attachment ("Loaded N skills from <path>",
 * which `skill-listing-ui` enriches with the skill names) rather than inventing
 * a new attachment type, so it needs no new producer/render/type-map wiring.
 * That attachment type maps to empty model-message content upstream, so the
 * notice is display/transcript-only and costs no prompt tokens.
 *
 * Records are deduplicated per session by (file, sorted skill names): the
 * skill-cache reset re-buckets path skills as conditional, and the per-cycle
 * changed-file scanner re-reads watched files through the Read pipeline, so
 * the same activation can re-fire indefinitely. Without the seen-set the
 * notice prints on every attachment cycle.
 *
 * Three anchors:
 *   1. a module-level pending list plus a seen-set,
 *   2. the conditional-skill activation matcher records {names, file} whenever it
 *      activates skills (its `q.length > 0` branch, which both the cwd and global
 *      match paths feed, so this is independent of the skill-global-paths patch),
 *   3. the `dynamic_skill` attachment producer drains the list into attachments
 *      before it returns.
 */

const STATE = "__ccPathActivations";
const SEEN = "__ccPathActivationsSeen";
const KEY_VAR = "__ccPathActivationKey";
const DRAIN_VAR = "__ccPathActivation";

/** Recursive child scan that does NOT reparent nodes (unlike babel traverse). */
function nodeContains(
	node: t.Node | null | undefined,
	pred: (n: t.Node) => boolean,
): boolean {
	if (!node) return false;
	if (pred(node)) return true;
	const keys = t.VISITOR_KEYS[node.type] ?? [];
	for (const key of keys) {
		const value = (node as unknown as Record<string, unknown>)[key];
		if (Array.isArray(value)) {
			for (const item of value) {
				if (item && typeof item === "object" && "type" in item) {
					if (nodeContains(item as t.Node, pred)) return true;
				}
			}
		} else if (value && typeof value === "object" && "type" in value) {
			if (nodeContains(value as t.Node, pred)) return true;
		}
	}
	return false;
}

function isDynamicSkillObject(node: t.Node): boolean {
	if (!t.isObjectExpression(node)) return false;
	const typeProp = getObjectPropertyByName(node, "type");
	return (
		!!typeProp && t.isStringLiteral(typeProp.value, { value: "dynamic_skill" })
	);
}

function buildStateDecl(): t.Statement {
	return template.statement(`var ${STATE} = [];`, {
		placeholderPattern: false,
	})();
}

function buildSeenDecl(): t.Statement {
	return template.statement(`var ${SEEN} = new Set();`, {
		placeholderPattern: false,
	})();
}

// NUL both as the file/name separator and as the name joiner: it cannot
// appear in a path or a skill name, so the key is injective over
// (file, name set) and a comma inside a single name cannot forge a
// multi-name key.
function buildGuardedRecordStatement(
	qName: string,
	firstParamName: string,
): t.Statement {
	return template.statement(
		`{
  let ${KEY_VAR} = ${firstParamName}[0] + "\\u0000" + ${qName}.slice().sort().join("\\u0000");
  if (!${SEEN}.has(${KEY_VAR})) {
    ${SEEN}.add(${KEY_VAR});
    ${STATE}.push({ names: ${qName}.slice(), file: ${firstParamName}[0] });
  }
}`,
		{ placeholderPattern: false },
	)();
}

/**
 * Anchor 2: the activation matcher is a function with a `for...of` over
 * `*.conditionalSkills` and a trailing `if (<q>.length > 0)` branch that emits a
 * change event. Wrap that branch's body to also record the activated names and
 * the first touched file (the matcher's first parameter).
 */
function tryPatchMatcher(fn: t.Function): boolean {
	if (!t.isBlockStatement(fn.body)) return false;
	const body = fn.body.body;

	const hasConditionalLoop = body.some(
		(st) =>
			t.isForOfStatement(st) &&
			t.isMemberExpression(st.right) &&
			isMemberPropertyName(st.right, "conditionalSkills"),
	);
	if (!hasConditionalLoop) return false;

	const firstParam = fn.params[0];
	if (!t.isIdentifier(firstParam)) return false;

	for (const st of body) {
		if (!t.isIfStatement(st)) continue;
		const test = st.test;
		if (
			!t.isBinaryExpression(test, { operator: ">" }) ||
			!t.isMemberExpression(test.left) ||
			!isMemberPropertyName(test.left, "length") ||
			!t.isIdentifier(test.left.object) ||
			!t.isNumericLiteral(test.right, { value: 0 })
		) {
			continue;
		}
		// Confirm this is the activation-emit branch.
		if (
			!nodeContains(
				st.consequent,
				(n) => t.isMemberExpression(n) && isMemberPropertyName(n, "emit"),
			)
		) {
			continue;
		}

		// Idempotency: already wrapped with our record call.
		if (
			nodeContains(
				st.consequent,
				(n) =>
					t.isMemberExpression(n) && t.isIdentifier(n.object, { name: STATE }),
			)
		) {
			return true;
		}

		const qName = test.left.object.name;
		const record = buildGuardedRecordStatement(qName, firstParam.name);
		st.consequent = t.blockStatement([st.consequent, record]);
		return true;
	}
	return false;
}

/**
 * Anchor 3: the `dynamic_skill` attachment producer builds an array and returns
 * it. Drain the pending list into `dynamic_skill` attachments before that return.
 */
function tryPatchProducer(fn: t.Function): boolean {
	if (!t.isBlockStatement(fn.body)) return false;
	if (!nodeContains(fn.body, isDynamicSkillObject)) return false;

	const body = fn.body.body;
	const returnIdx = body.findIndex(
		(st) => t.isReturnStatement(st) && t.isIdentifier(st.argument),
	);
	if (returnIdx === -1) return false;
	const arrName = (
		(body[returnIdx] as t.ReturnStatement).argument as t.Identifier
	).name;

	// Idempotency: already drained.
	if (
		body.some(
			(st) =>
				t.isForOfStatement(st) &&
				t.isCallExpression(st.right) &&
				t.isMemberExpression(st.right.callee) &&
				t.isIdentifier(st.right.callee.object, { name: STATE }),
		)
	) {
		return true;
	}

	const drain = t.forOfStatement(
		t.variableDeclaration("let", [
			t.variableDeclarator(t.identifier(DRAIN_VAR)),
		]),
		t.callExpression(
			t.memberExpression(t.identifier(STATE), t.identifier("splice")),
			[t.numericLiteral(0)],
		),
		t.expressionStatement(
			t.callExpression(
				t.memberExpression(t.identifier(arrName), t.identifier("push")),
				[
					t.objectExpression([
						t.objectProperty(
							t.identifier("type"),
							t.stringLiteral("dynamic_skill"),
						),
						t.objectProperty(
							t.identifier("skillDir"),
							t.memberExpression(t.identifier(DRAIN_VAR), t.identifier("file")),
						),
						t.objectProperty(
							t.identifier("skillNames"),
							t.memberExpression(
								t.identifier(DRAIN_VAR),
								t.identifier("names"),
							),
						),
						t.objectProperty(
							t.identifier("displayPath"),
							t.memberExpression(t.identifier(DRAIN_VAR), t.identifier("file")),
						),
					]),
				],
			),
		),
	);
	body.splice(returnIdx, 0, drain);
	return true;
}

function createSkillActivationNoticePasses(): PatchAstPass[] {
	let patchedMatcher = false;
	let patchedProducer = false;

	return [
		{
			pass: "mutate",
			visitor: {
				Function(path) {
					if (!patchedMatcher && tryPatchMatcher(path.node)) {
						patchedMatcher = true;
					}
					if (!patchedProducer && tryPatchProducer(path.node)) {
						patchedProducer = true;
					}
				},
				Program: {
					exit(path) {
						const alreadyDeclared = path.node.body.some(
							(st) =>
								t.isVariableDeclaration(st) &&
								st.declarations.some((decl) =>
									t.isIdentifier(decl.id, { name: STATE }),
								),
						);
						if ((patchedMatcher || patchedProducer) && !alreadyDeclared) {
							path.node.body.unshift(buildStateDecl(), buildSeenDecl());
						}
						if (!patchedMatcher) {
							console.warn(
								"skill-activation-notice: could not find conditional-skill activation matcher",
							);
						}
						if (!patchedProducer) {
							console.warn(
								"skill-activation-notice: could not find dynamic_skill attachment producer",
							);
						}
					},
				},
			},
		},
	];
}

function verifySkillActivationNotice(ast: t.File): true | string {
	let stateDecl = false;
	let seenDecl = false;
	let recordCall = false;
	let drainCall = false;
	let seenGuardHas = false;
	let seenGuardAdd = false;

	traverse(ast, {
		VariableDeclarator(path) {
			if (t.isIdentifier(path.node.id, { name: STATE })) stateDecl = true;
			if (t.isIdentifier(path.node.id, { name: SEEN })) seenDecl = true;
		},
		CallExpression(path) {
			const callee = path.node.callee;
			if (!t.isMemberExpression(callee)) return;
			if (t.isIdentifier(callee.object, { name: STATE })) {
				if (isMemberPropertyName(callee, "push")) recordCall = true;
				if (isMemberPropertyName(callee, "splice")) drainCall = true;
			}
			if (t.isIdentifier(callee.object, { name: SEEN })) {
				if (isMemberPropertyName(callee, "has")) seenGuardHas = true;
				if (isMemberPropertyName(callee, "add")) seenGuardAdd = true;
			}
		},
	});

	if (!stateDecl) return "activation-notice pending list was not injected";
	if (!seenDecl) return "activation-notice seen-set was not injected";
	if (!recordCall) return "activation matcher does not record activated skills";
	if (!seenGuardHas || !seenGuardAdd)
		return "activation notices are not deduplicated per file and skill set";
	if (!drainCall)
		return "dynamic_skill producer does not drain activation notices";
	return true;
}

export const skillActivationNotice: Patch = {
	tag: "skill-activation-notice",
	astPasses: () => createSkillActivationNoticePasses(),
	verify(code, ast) {
		const verifyAst = getVerifyAst(code, ast);
		if (!verifyAst) {
			return "Could not parse code for skill activation notice verification";
		}
		return verifySkillActivationNotice(verifyAst);
	},
};
