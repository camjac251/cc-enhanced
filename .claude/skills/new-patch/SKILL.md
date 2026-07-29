---
name: new-patch
description: >-
  Scaffold the four files for a new cc-enhanced patch (src/patches/<tag>.ts, <tag>.test.ts, the export-barrel entry, and the BY_TAG metadata record). Scaffold-only; the complete implementation procedure lives in docs/maintainer-reference.md > Adding Patches. Recommend by name when the user wants to add a new patch behavior. Triggers on "new patch", "add a patch", "scaffold a patch", "create a patch for X", "start a patch". Argument is the patch tag (e.g. "my-feature"). If the tag, one-line purpose, or group (Prompt, Tooling, Agent, System, UX, Metadata) is missing, ask before scaffolding. NOT for editing an existing patch directly and NOT for end-to-end implementation; this skill stops at scaffolding and hands off to the implementation workflow.
disable-model-invocation: true
---

# /new-patch <tag>

Create the four files needed for a new patch, then hand off to the user. `$ARGUMENTS` is the patch tag.

If the tag is missing, ask the user for tag, one-line purpose, and group.

## Files to create

1. **`src/patches/<tag>.ts`**: copy the structure from a similar existing patch in `src/patches/`. Import only the AST types and helpers that scaffold uses; do not add unused placeholder imports. Export a `Patch` with `tag`, `astPasses`, and `verify`; see `src/types.ts` for the interface.
2. **`src/patches/<tag>.test.ts`**: use `node:test` plus `node:assert/strict`. Assert the exported `tag` and add a named `test.todo(...)` for the intended mutation/verifier behavior; do not add a passing placeholder assertion. Mirror the shape of a sibling `*.test.ts`.
3. **`src/patches/index.ts`**: add the named `export ... from "./<tag>.js"`, add the import for the roster, and append the patch to the canonical `registeredPatches` array.
4. **`src/patch-metadata.ts`**: add a `BY_TAG["<tag>"]` record with `tag`, `label`, and `group`.

## After scaffolding

Tell the user the four files are created. Do not implement the visitor or verifier; that is the user's design step.

Remind them to follow `docs/maintainer-reference.md > Adding Patches`:

- If the patch changes exported live prompt guidance, update `src/verification/prompt-surface-rules.ts` and update `src/verification/prompt-policy-contract.ts` for shared policy.
- When the total patch count changes, keep the patch count in sync across the `README.md` intro and patch-count badge. Confirm the new total against `bun run cli --list` before pushing.
- Prompt guidance changes need a patched export, `mise run verify:prompt-surfaces -- <export-dir>`, human review through `prompts:compare`, and `verify:prompt-drift` against a reviewed baseline before drift is called corrected.

## Implementation handoff

Resolve the newest live release first, then pull that exact version:

```bash
npm view @anthropic-ai/claude-code version dist-tags --json
mise run native:pull -- <target>
```

Use the immediately previous clean bundle only to understand release drift.
Implement against `versions_clean/<target>/cli.js` with no older-shape
fallbacks. Use `bun run inspect search versions_clean/<target>/cli.js <query>`
for anchor discovery, then prove the patch with a focused test, the target
matrix (`SELECTED_VERSION=<target> mise run verify:patches:matrix`), and the
native verifier (`mise run verify:patches`) before calling it complete.

## Gotchas

- This command is slash-only and scaffold-only; do not implement the visitor or verifier inside this workflow.
- Do not hide this skill behind `paths:`. The user invokes it by command name before any scaffold files exist.
