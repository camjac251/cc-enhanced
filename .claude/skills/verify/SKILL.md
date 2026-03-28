---
name: verify
description: Full health check of the patcher. Typecheck, lint, dry-run against native target, and anchor verification.
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
