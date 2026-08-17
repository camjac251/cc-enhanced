// @babel/{traverse,generator,template} expose their entry point as the default
// export. Re-exporting them here keeps call sites short and gives the whole
// codebase a single place to adapt if those entry points move again.
import generator from "@babel/generator";
import template from "@babel/template";
import traverse from "@babel/traverse";

export { generator, template, traverse };

/**
 * Drop @babel/traverse's global path/scope cache.
 *
 * The cache holds a NodePath/Scope graph weakly keyed by the File node, so it
 * stays resident for as long as the parsed AST is reachable. On the large
 * bundle this graph outweighs the AST itself, so a long-lived process must
 * clear it after a run or the wrappers persist into later memory-heavy work.
 *
 * A missing clear entry point is fatal rather than ignored: silently skipping
 * the release reintroduces update-time memory exhaustion, and nothing upstream
 * of here can tell a skipped release from a completed one.
 */
export function clearTraverseCache(): void {
	const clear = (traverse as unknown as { cache?: { clear?: () => void } })
		.cache?.clear;
	if (typeof clear !== "function") {
		throw new Error(
			"@babel/traverse no longer exposes cache.clear(); the traverse path/scope cache cannot be released.",
		);
	}
	clear();
}

export type { GeneratorOptions } from "@babel/generator";
export type { NodePath, Visitor } from "@babel/traverse";
