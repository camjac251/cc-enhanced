---
name: new-patch
description: >-
  Scaffold the four files for a new cc-enhanced patch (src/patches/<tag>.ts, <tag>.test.ts, the export-barrel entry, and the BY_TAG metadata record). Scaffold-only; the rest of the procedure (prompt-surface rules, count sync, clean-bundle inspection, and native verification) lives in CLAUDE.md > Adding Patches. Recommend by name when the user wants to add a new patch behavior. Triggers on "new patch", "add a patch", "scaffold a patch", "create a patch for X", "start a patch". Argument is the patch tag (e.g. "my-feature"). If the tag, one-line purpose, or group (Prompt, Tooling, Agent, System, UX, Metadata) is missing, ask before scaffolding. NOT for editing an existing patch directly and NOT for end-to-end implementation; this skill stops at scaffolding and hands off to the implementation workflow.
disable-model-invocation: true
---

# /new-patch <tag>

Create the four files needed for a new patch, then hand off to the user. `$ARGUMENTS` is the patch tag.

If the tag is missing, ask the user for tag, one-line purpose, and group.

## Files to create

1. **`src/patches/<tag>.ts`**: copy the structure from a similar existing patch in `src/patches/`. Import `traverse`, `@babel/types`, and helpers from `./ast-helpers.js`. Export a `Patch` with `tag`, `astPasses`, and `verify`; see `src/types.ts` for the interface.
2. **`src/patches/<tag>.test.ts`**: use `node:test` plus `node:assert/strict`. At minimum, assert the exported `tag` matches and add a placeholder for verify behavior. Mirror the shape of a sibling `*.test.ts`.
3. **`src/patches/index.ts`**: add the named `export ... from "./<tag>.js"`, add the import for the array, and append the patch to `allPatches`.
4. **`src/patch-metadata.ts`**: add a `BY_TAG["<tag>"]` record with `tag`, `label`, and `group`.

## After scaffolding

Tell the user the four files are created. Do not implement the visitor or verifier; that is the user's design step.

Remind them to follow `CLAUDE.md > Adding Patches`:

- **Step 5**: if the patch changes exported live prompt guidance, update `src/verification/prompt-surface-rules.ts` and update `src/verification/prompt-policy-contract.ts` for shared policy.
- **Step 6**: when the total patch count changes, keep the patch count in sync across the `README.md` intro and patch-count badge. Confirm the new total against `bun run cli --list` before pushing.
- Prompt guidance changes need a patched export, `mise run verify:prompt-surfaces -- <export-dir>`, human review through `prompts:compare`, and `verify:prompt-drift` against a reviewed baseline before drift is called corrected.

## Implementation handoff

The implementation phase starts from the current clean upstream bundle, not an older cached snapshot:

```bash
mise run native:pull -- latest
```

Use `bun run inspect search versions_clean/<version>/cli.js <query>` for `cli.js` anchor discovery, then prove the patch with a focused test, the target matrix (`SELECTED_VERSION=<version> mise run verify:patches:matrix`), and the native verifier (`mise run verify:patches`) before calling it complete.

## Gotchas

- This command is slash-only and scaffold-only; do not implement the visitor or verifier inside this workflow.
- Do not hide this skill behind `paths:`. The user invokes it by command name before any scaffold files exist.
