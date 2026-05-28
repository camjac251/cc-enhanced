---
name: new-patch
description: "Scaffold the four files for a new cc-enhanced patch (src/patches/<tag>.ts, <tag>.test.ts, the export-barrel entry, and the BY_TAG metadata record). Scaffold-only; the rest of the procedure (prompt-surface rules, count sync) lives in CLAUDE.md > Adding Patches."
when_to_use: >-
  Recommend by name when the user wants to add a new patch behavior. Triggers
  on "new patch", "add a patch", "scaffold a patch", "create a patch for X",
  "start a patch". Argument is the patch tag (e.g. "my-feature"). If the tag,
  one-line purpose, or group (Prompt, Tooling, Agent, System, UX, Metadata) is
  missing, ask before scaffolding. NOT for editing an existing patch (just edit
  the file directly) or for end-to-end implementation (this skill stops at
  scaffolding; the user implements the visitor and verifier).
disable-model-invocation: true
paths:
  - src/patches/index.ts
  - src/patch-metadata.ts
---

# /new-patch <tag>

Create the four files needed for a new patch, then hand off to the user. `$ARGUMENTS` is the patch tag.

If the tag is missing, ask the user for: tag, one-line purpose, and group.

## Files to create

1. **`src/patches/<tag>.ts`**: copy the structure from a similar existing patch in `src/patches/`. Import `traverse`, `@babel/types`, and helpers from `./ast-helpers.js`. Export a `Patch` with `tag`, `astPasses`, and `verify` (see `src/types.ts` for the interface).
2. **`src/patches/<tag>.test.ts`**: `node:test` + `node:assert/strict`. At minimum, assert the exported `tag` matches and add a placeholder for the verify behavior. Mirror the shape of a sibling `*.test.ts`.
3. **`src/patches/index.ts`**: add the named `export ... from "./<tag>.js"`, the `import` for the array, and append the patch to `allPatches`.
4. **`src/patch-metadata.ts`**: add a `BY_TAG["<tag>"]` record with `tag`, `label`, and `group`.

## After scaffolding

Tell the user the four files are created. Do not implement the visitor or verifier; that is the user's design step. Then remind them to follow CLAUDE.md > Adding Patches:

- **Step 5**: if the patch changes exported live prompt guidance, update `src/verification/prompt-surface-rules.ts` (and `src/verification/prompt-policy-contract.ts` for shared policy).
- For prompt guidance changes, later validate a patched export with
  `mise run verify:prompt-surfaces -- <export-dir>`, review
  `prompts:compare`, and run `verify:prompt-drift` against a reviewed baseline
  before calling drift corrected.
- **Step 6**: keep the patch count in sync across `CLAUDE.md` intro and `README.md` intro and badge. Confirm the new total against `bun run cli --list` before pushing.
