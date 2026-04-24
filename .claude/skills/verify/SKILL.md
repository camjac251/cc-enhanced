---
name: verify
description: "Full health check of the cc-enhanced patcher: pnpm typecheck, lint, test in parallel, then mise run verify:patches (dry-run against native target with anchor verification). NOT for general pre-commit verification of arbitrary code (use /verification-before-completion)."
when_to_use: >-
  When the user wants to verify patcher correctness before a commit, release, or
  after edits to patch logic or AST helpers. Triggers on 'verify the patcher',
  'is the patcher clean', 'run all checks', 'full verify', 'is everything passing',
  'pre-commit check for patcher', 'check before native:update', 'verify patches'.
---

# Verify Patches

Run the full verification suite for the patcher.

## Steps

1. Run these in parallel:
   - `pnpm typecheck`
   - `pnpm lint`
   - `pnpm test`

2. If all pass, run `mise run verify:patches` (dry-run against native target with anchor checks).

3. Report results. For any failures:
   - Typecheck errors: show the exact errors with file:line references
   - Lint errors: show violations, suggest `pnpm lint:fix` if auto-fixable
   - Test failures: show failing test names and assertion errors
   - Patch verification failures: show which patches failed and their failure reasons

4. If everything passes, report the summary (patches applied, verification status).
