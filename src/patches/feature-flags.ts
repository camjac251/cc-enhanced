import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";

/**
 * Bypasses server-side feature flag gates by replacing x8("tengu_*", default)
 * calls with static boolean values.
 *
 * Flags:
 * - tengu_workout2: gates effort levels (env var alone not enough without flag)
 * - tengu_amber_flint: gates agent teams (double-gated with env var)
 * - tengu_marble_kite: gates write/edit-before-read enforcement
 *   Uses !0 (truthy) so !x8(...) → !!0 → false, disabling the check.
 */
const FLAG_OVERRIDES: { flag: string; replacement: () => t.Expression }[] = [
	{ flag: "tengu_workout2", replacement: () => t.booleanLiteral(true) },
	{ flag: "tengu_amber_flint", replacement: () => t.booleanLiteral(true) },
	{
		flag: "tengu_marble_kite",
		replacement: () => t.unaryExpression("!", t.numericLiteral(0)),
	},
];
const TARGET_FLAGS = new Set(FLAG_OVERRIDES.map((entry) => entry.flag));

function isBooleanLike(node: t.Node | null | undefined): boolean {
	if (!node) return false;
	if (t.isBooleanLiteral(node)) return true;
	return (
		t.isUnaryExpression(node, { operator: "!" }) &&
		t.isNumericLiteral(node.argument) &&
		(node.argument.value === 0 || node.argument.value === 1)
	);
}

function resolveFlagGateCallee(ast: t.File): string | null {
	const calleeNames = new Set<string>();

	traverse.default(ast, {
		CallExpression(path) {
			if (!t.isIdentifier(path.node.callee)) return;
			if (path.node.arguments.length < 2) return;

			const [flagArg, defaultArg] = path.node.arguments;
			if (!t.isStringLiteral(flagArg) || !TARGET_FLAGS.has(flagArg.value))
				return;
			if (!isBooleanLike(defaultArg)) return;

			calleeNames.add(path.node.callee.name);
		},
	});

	if (calleeNames.size !== 1) return null;
	return [...calleeNames][0];
}

export const featureFlags: Patch = {
	tag: "flag-bypass",

	ast: (ast) => {
		const counts = new Map<string, number>();
		const gateCallee = resolveFlagGateCallee(ast);
		if (!gateCallee) {
			console.warn(
				"flag-bypass: Could not resolve a unique feature flag gate callee",
			);
			return;
		}

		traverse.default(ast, {
			CallExpression(path) {
				if (!t.isIdentifier(path.node.callee, { name: gateCallee })) return;

				const args = path.node.arguments;
				if (args.length < 1) return;
				if (!t.isStringLiteral(args[0])) return;

				const match = FLAG_OVERRIDES.find(
					(o) => o.flag === (args[0] as t.StringLiteral).value,
				);
				if (!match) return;

				path.replaceWith(match.replacement());
				path.skip();
				counts.set(match.flag, (counts.get(match.flag) ?? 0) + 1);
			},
		});

		for (const { flag } of FLAG_OVERRIDES) {
			if (!counts.has(flag)) {
				console.warn(`flag-bypass: No ${flag} flag calls found`);
			}
		}
	},

	verify: (_code, ast) => {
		if (!ast) return "Missing AST for flag-bypass verification";

		// Scope to the gate function signature: identifier callee with a target
		// flag string as first arg and a boolean-like second arg. This matches
		// exactly what resolveFlagGateCallee identifies, avoiding false positives
		// from other call sites that happen to reference these flag strings.
		const remainingFlags = new Set<string>();
		traverse.default(ast, {
			CallExpression(path) {
				if (!t.isIdentifier(path.node.callee)) return;
				if (path.node.arguments.length < 2) return;
				const [flagArg, defaultArg] = path.node.arguments;
				if (!t.isStringLiteral(flagArg)) return;
				if (!TARGET_FLAGS.has(flagArg.value)) return;
				if (!isBooleanLike(defaultArg)) return;
				remainingFlags.add(flagArg.value);
			},
		});

		if (remainingFlags.size > 0) {
			return `Feature flag gate calls still present: ${[...remainingFlags].join(", ")}`;
		}

		return true;
	},
};
