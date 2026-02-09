import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";

/**
 * Inject signature into version strings.
 * The signature is built from all patches that passed verification.
 */
export const signature: Patch = {
	tag: "signature",

	// Signature doesn't have its own verify - it just runs last
	ast: (ast, appliedTags?: string[]) => {
		// appliedTags will be passed by the runner
		const tags = appliedTags || [];
		if (tags.length === 0) return;

		// Short signature for UI display (avoids width overflow)
		const sigShort = "patched";
		// Full signature for --version output
		const sigFull = `patched: ${tags.join(", ")}`;

		traverse.default(ast, {
			StringLiteral(path: any) {
				const val = path.node.value;
				// --version output: use full signature
				if (val.includes("(Claude Code)") && !val.includes("patched:")) {
					path.node.value = val.replace(
						"(Claude Code)",
						`(Claude Code; ${sigFull})`,
					);
				}
				// UI title bar: use short signature
				if (val === "v" && t.isCallExpression(path.parentPath.node)) {
					const args = path.parentPath.node.arguments;
					const idx = args.indexOf(path.node);
					if (idx !== -1 && idx + 1 < args.length) {
						args.splice(idx + 2, 0, t.stringLiteral(` • ${sigShort}`));
					}
				}
			},
			TemplateLiteral(path: any) {
				// --version output: use full signature
				for (const quasi of path.node.quasis) {
					if (
						quasi.value.raw.includes("(Claude Code)") &&
						!quasi.value.raw.includes("patched:")
					) {
						const newSig = `(Claude Code; ${sigFull})`;
						quasi.value.raw = quasi.value.raw.replace("(Claude Code)", newSig);
						if (quasi.value.cooked) {
							quasi.value.cooked = quasi.value.cooked.replace(
								"(Claude Code)",
								newSig,
							);
						}
					}
				}

				// UI elements: use short signature
				if (
					path.node.quasis.length > 0 &&
					path.node.quasis[0].value.raw === "Claude Code v"
				) {
					const lastQuasi = path.node.quasis[path.node.quasis.length - 1];
					if (!lastQuasi.value.raw.includes("patched:")) {
						const suffix = ` • ${sigShort}`;
						lastQuasi.value.raw += suffix;
						if (lastQuasi.value.cooked) {
							lastQuasi.value.cooked += suffix;
						}
					}
				}

				const exprs = path.node.expressions;
				if (exprs.length >= 2) {
					let claudeCodeIndex = -1;
					let versionIndex = -1;

					for (let i = 0; i < exprs.length; i++) {
						const expr = exprs[i];
						if (
							t.isCallExpression(expr) &&
							expr.arguments.length > 0 &&
							t.isStringLiteral(expr.arguments[0]) &&
							expr.arguments[0].value === "Claude Code"
						) {
							claudeCodeIndex = i;
							continue;
						}

						if (
							t.isCallExpression(expr) &&
							expr.arguments.length > 0 &&
							t.isTemplateLiteral(expr.arguments[0])
						) {
							const tpl = expr.arguments[0];
							if (tpl.quasis.length > 0 && tpl.quasis[0].value.raw === "v") {
								versionIndex = i;
							}
						}
					}

					// UI title: use short signature
					if (
						claudeCodeIndex !== -1 &&
						versionIndex !== -1 &&
						versionIndex > claudeCodeIndex
					) {
						const versionTpl = exprs[versionIndex].arguments[0];
						const lastQuasi = versionTpl.quasis[versionTpl.quasis.length - 1];
						if (!lastQuasi.value.raw.includes("patched:")) {
							const suffix = ` • ${sigShort}`;
							lastQuasi.value.raw += suffix;
							if (lastQuasi.value.cooked) lastQuasi.value.cooked += suffix;
						}
					}
				}
			},
		});
	},

	verify: (code) => {
		if (!code.includes("patched:")) {
			return "Missing 'patched:' signature in version string";
		}
		return true;
	},
};
