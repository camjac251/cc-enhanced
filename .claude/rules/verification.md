---
paths:
  - src/patches/
  - src/verification/
  - scripts/verify-patches.ts
  - src/ast-pass-engine.ts
  - src/patch-runner.ts
---

# Verification cadence

Run before claiming a patch change is done, before opening a PR, and before promoting a new build.

## Repository hygiene (parallel)

```bash
bun run typecheck
bun run lint
bun run test
```

These are quick and have no side effects. Lefthook (`lefthook.yml`) gates pre-commit on Biome format, Biome lint, and `bun run typecheck`. Tests are not in the pre-commit gate; run them yourself.

## Patcher health

```bash
mise run verify:patches
```

This runs the dry-run patch path against the native target plus anchor checks against the clean cli.js. It is the authoritative pre-promote signal. Output names every failed tag with the `verify()` reason string.

For a wider sweep across cached clean versions:

```bash
SELECTED_VERSION=<X.Y.Z> mise run verify:patches:matrix
VERIFY_PATCHES_MATRIX_SCOPE=all mise run verify:patches:matrix
```

## Triaging failures

- **typecheck**: read the `file:line` references and fix the type. Do not paper over with `any` or `@ts-expect-error`.
- **lint**: try `bun run lint:fix` for auto-fixable rules; address the rest manually.
- **test**: read the failing test name and assertion. Fixture failures usually mean the patch's matcher missed the new upstream shape (drift).
- **verify:patches**: the failed-tag list points at per-patch `verify()` functions. Each reason string names the missing invariant. See "Verifier Robustness" in `CLAUDE.md` before changing mutation logic.

## Pass before claiming done

`mise run verify:patches` against the real native target is the floor for "this works". Fixture tests alone are necessary but not sufficient (see "Pipeline Ordering" in `CLAUDE.md`).
