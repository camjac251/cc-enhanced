// @babel/{traverse,generator,template} ship as CommonJS. Under tsconfig
// module=NodeNext + esModuleInterop, the default import binding is typed as
// the entire module namespace (not the function), so the original code worked
// around that with `traverse.default(...)` at every call site. That workaround
// only runs under Node ESM though: Bun unwraps the CJS export down to the
// function itself and `traverse.default` is undefined at runtime.
//
// This adapter normalizes both runtimes (default ?? self) and re-types the
// exports as the callable so call sites can stay short.
import _generator from "@babel/generator";
import _template from "@babel/template";
import _traverse from "@babel/traverse";

type TraverseFn = (typeof _traverse)["default"];
type GeneratorFn = (typeof _generator)["default"];
type TemplateFn = (typeof _template)["default"];

function unwrap(mod: unknown): unknown {
	if (mod && typeof mod === "object" && "default" in mod) {
		return (mod as { default: unknown }).default ?? mod;
	}
	return mod;
}

export const traverse = unwrap(_traverse) as TraverseFn;
export const generator = unwrap(_generator) as GeneratorFn;
export const template = unwrap(_template) as TemplateFn;

export type { GeneratorOptions } from "@babel/generator";
export type { NodePath, Visitor } from "@babel/traverse";
