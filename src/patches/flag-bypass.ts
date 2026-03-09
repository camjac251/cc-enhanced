import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";

/**
 * Bypasses server-side feature flag gates by replacing DL("tengu_*", default)
 * calls with static boolean values.
 *
 * Flags:
 * - tengu_amber_flint: gates agent teams (double-gated with env var, defaults true)
 *
 * Removed upstream:
 * - tengu_workout2 (effort) removed in 2.1.38
 * - tengu_marble_kite (write guard) removed in 2.1.38
 * - tengu_mulberry_fog removed before 2.1.69
 */
const FLAG_OVERRIDES: { flag: string; replacement: () => t.Expression }[] = [
	{ flag: "tengu_amber_flint", replacement: () => t.booleanLiteral(true) },
];
const TARGET_FLAGS = new Set(FLAG_OVERRIDES.map((entry) => entry.flag));
const FLAG_REPLACEMENTS = new Map(
	FLAG_OVERRIDES.map((entry) => [entry.flag, entry.replacement]),
);

type GateCandidate = {
	count: number;
	flags: Set<string>;
};

type GateInfo = {
	callees: Set<string>;
	targetCallCount: number;
};

// Per-run cache: set by astPasses(), consumed by verify(), then cleared.
// Stored on the patch object itself (via closure) to avoid module-level leaks.
let _gateInfoCache: GateInfo | null = null;

function isBooleanLike(
	node: t.Node | null | undefined,
	scope: any,
	seenBindings: Set<string> = new Set(),
): boolean {
	if (!node) return false;
	if (t.isBooleanLiteral(node)) return true;
	if (t.isParenthesizedExpression(node)) {
		return isBooleanLike(node.expression, scope, seenBindings);
	}
	if (t.isIdentifier(node)) {
		if (seenBindings.has(node.name)) return false;
		seenBindings.add(node.name);
		const binding = scope?.getBinding?.(node.name);
		if (!binding || !t.isVariableDeclarator(binding.path.node)) return false;
		return isBooleanLike(
			binding.path.node.init,
			binding.path.scope,
			seenBindings,
		);
	}
	return (
		t.isUnaryExpression(node, { operator: "!" }) &&
		t.isNumericLiteral(node.argument) &&
		(node.argument.value === 0 || node.argument.value === 1)
	);
}

function getCalleeName(callee: t.CallExpression["callee"]): string | undefined {
	if (t.isIdentifier(callee)) return callee.name;
	return;
}

function getTargetFlagArg(
	args: t.CallExpression["arguments"],
): string | undefined {
	if (args.length < 1) return;
	const [flagArg] = args;
	if (!t.isStringLiteral(flagArg)) return;
	if (!TARGET_FLAGS.has(flagArg.value)) return;
	return flagArg.value;
}

function discoverGateInfo(ast: t.File): GateInfo {
	const candidates = new Map<string, GateCandidate>();
	const presentFlags = new Set<string>();
	let targetCallCount = 0;

	traverse.default(ast, {
		CallExpression(path) {
			const calleeName = getCalleeName(path.node.callee);
			if (!calleeName) return;
			const flag = getTargetFlagArg(path.node.arguments);
			if (!flag) return;
			if (!isBooleanLike(path.node.arguments[1] ?? null, path.scope)) return;

			targetCallCount += 1;
			presentFlags.add(flag);
			let candidate = candidates.get(calleeName);
			if (!candidate) {
				candidate = { count: 0, flags: new Set<string>() };
				candidates.set(calleeName, candidate);
			}
			candidate.count += 1;
			candidate.flags.add(flag);
		},
	});

	if (candidates.size === 0) return { callees: new Set(), targetCallCount };

	const entries = [...candidates.entries()].map(([name, meta]) => ({
		name,
		count: meta.count,
		flags: meta.flags,
	}));
	const requiredFlagCount = Math.max(1, presentFlags.size);
	const fullCoverage = entries.filter(
		(entry) => entry.flags.size === requiredFlagCount,
	);
	const pool = fullCoverage.length > 0 ? fullCoverage : entries;
	const maxCount = Math.max(...pool.map((entry) => entry.count));
	const winners = pool.filter((entry) => entry.count === maxCount);

	if (winners.length !== 1) {
		console.warn(
			`Feature flag bypass: Ambiguous feature-flag gate callee candidates (${winners.map((entry) => entry.name).join(", ")})`,
		);
		return { callees: new Set(), targetCallCount };
	}

	return { callees: new Set([winners[0].name]), targetCallCount };
}

function getPatchableFlagArg(
	path: any,
	allowedCallees: Set<string>,
): string | undefined {
	const calleeName = getCalleeName(path.node.callee);
	if (!calleeName) return;
	if (!allowedCallees.has(calleeName)) return;

	const args = path.node.arguments as t.CallExpression["arguments"];
	if (args.length < 2) return;
	const [flagArg, defaultArg] = args;
	if (!t.isStringLiteral(flagArg)) return;
	if (!TARGET_FLAGS.has(flagArg.value)) return;
	if (!isBooleanLike(defaultArg, path.scope)) return;
	return flagArg.value;
}

export const featureFlags: Patch = {
	tag: "flag-bypass",

	astPasses: (ast) => {
		_gateInfoCache = discoverGateInfo(ast);
		return [
			{
				pass: "mutate",
				visitor: createFeatureFlagsMutator(_gateInfoCache.callees),
			},
		];
	},

	verify: (code, ast) => {
		if (!ast) return "Missing AST for flag-bypass verification";

		const gateInfo = _gateInfoCache ?? discoverGateInfo(ast);
		// Always clear immediately, even if verify throws below
		_gateInfoCache = null;
		if (gateInfo.targetCallCount === 0) {
			const hasAnyFlagReference = [...TARGET_FLAGS].some((f) =>
				code.includes(f),
			);
			if (hasAnyFlagReference) {
				return "Feature flag strings present but no patchable gate calls found; upstream gate shape may have drifted";
			}
			return true;
		}
		if (gateInfo.callees.size === 0) {
			return "Could not resolve unique feature-flag gate callee";
		}

		const remainingFlags = new Set<string>();
		traverse.default(ast, {
			CallExpression(path) {
				const flagArg = getPatchableFlagArg(path, gateInfo.callees);
				if (!flagArg) return;
				remainingFlags.add(flagArg);
			},
		});

		if (remainingFlags.size > 0) {
			return `Feature flag gate calls still present: ${[...remainingFlags].join(", ")}`;
		}

		return true;
	},
};

function createFeatureFlagsMutator(gateCallees: Set<string>): traverse.Visitor {
	const counts = new Map<string, number>();
	return {
		CallExpression(path) {
			if (gateCallees.size === 0) return;
			const flagArg = getPatchableFlagArg(path, gateCallees);
			if (!flagArg) return;
			const replacement = FLAG_REPLACEMENTS.get(flagArg);
			if (!replacement) return;

			path.replaceWith(replacement());
			path.skip();
			counts.set(flagArg, (counts.get(flagArg) ?? 0) + 1);
		},
		Program: {
			exit() {
				if (gateCallees.size === 0) {
					console.warn(
						"Feature flag bypass: Could not resolve unique feature-flag gate callee",
					);
					return;
				}
				for (const { flag } of FLAG_OVERRIDES) {
					if (!counts.has(flag)) {
						console.warn(`Feature flag bypass: No ${flag} flag calls found`);
					}
				}
			},
		},
	};
}
