import type { Patch } from "../types.js";

// Reserved slot for server-side feature-flag overrides. Currently a deliberate
// no-op: no string transform, no astPasses, no postApply, so verify() has no
// behavior to confirm and returning true is correct.
//
// INVARIANT: if a real mutation is ever added here (string/astPasses/postApply),
// verify() MUST be replaced with an AST-based check (getVerifyAst) that mirrors
// the mutator's own per-site predicates. It must not stay tautological by
// omission. feature-flags.test.ts pins the no-op shape so filling this slot
// without a real verifier fails loudly.
export const featureFlags: Patch = {
	tag: "feature-flags",
	verify: () => true,
};
