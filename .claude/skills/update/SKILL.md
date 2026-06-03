---
name: update
description: >-
  Run the grounded cc-enhanced upstream-release update lifecycle: resolve the real npm/latest/next target, pull the clean cli.js, run bundle drift and matrix verification before promotion, fix patch or prompt drift, refresh docs and prompt baselines only after review, promote with native:update, and verify the promoted binary. Recommend by name after an upstream Claude Code release, or when the user asks to "update Claude", "update Claude Code", "pull the new version", "fetch latest", "patch the new release", "run native:update", or names a target version. Also use when they ask to check prompt drift as part of an update. Argument is an optional version spec ("latest", "next", "stable", or "X.Y.Z") plus optional pass-through flags ("--dry-run", "--force"). NOT for rollback (use `mise run native:rollback`) and NOT for a read-only drift audit without promotion.
disable-model-invocation: true
---

# /update [version]

Run the full upstream-release update lifecycle. `$ARGUMENTS` is an optional version spec; defaults to `latest`.

The process is evidence-first: inspect the live registry and clean bundle before changing source, dry-run patches against the target before promotion, and report patch verification, prompt-surface validity, and prompt drift as separate states.

## Steps

1. **Resolve the target from live state.** Do not rely on memory or an older cached bundle.

   ```bash
   npm view @anthropic-ai/claude-code version dist-tags --json
   ```

   Use the explicit newest version if `next` is ahead of `latest`, and say so in the update summary.

2. **Pre-flight the local install and worktree.** Record current and previous versions before changing anything.

   ```bash
   mise run status
   ```

   ```bash
   git status --short
   ```

3. **Pull the clean target bundle.** This writes `versions_clean/<target>/cli.js`.

   ```bash
   mise run native:pull -- <target>
   ```

   If the previous current version is missing from `versions_clean/`, pull it too before diffing.

4. **Review upstream drift before source edits.** Prefer matrix diff when the release range has multiple adjacent versions.

   ```bash
   mise run diff -- matrix versions_clean/<old>/cli.js versions_clean/<target>/cli.js --cache
   ```

   Re-run focused diffs for commands, env, prompts, or patches when the matrix output points at those areas.

5. **Dry-run patch verification against the clean target.** This is the first gate for source drift.

   ```bash
   SELECTED_VERSION=<target> mise run verify:patches:matrix
   ```

   If a tag fails, inspect the clean target with `bun run inspect search`, fix the patch/verifier/tests for the new upstream shape only, run focused tests, and rerun the matrix. Do not add old-version fallbacks.

6. **Optionally dispatch anchor-review subagents.** Use this when the drift is broad or the user asks for extra confidence.

   - Pass only paths: `versions_clean/<target>/cli.js` and the assigned patch files.
   - Require `file:line`, exact query strings, and OK / DRIFT / BROKEN status.
   - Keep subagents read-only; the parent edits and verifies.
   - Do not let subagent evidence replace `verify:patches:matrix`.

7. **Preflight prompt surfaces from a scratch patched bundle before promotion.** Write scratch artifacts under OS temp, not inside `versions_clean/`.

   ```bash
   mktemp -d -t cc-update-XXXXXX
   ```

   ```bash
   bun src/index.ts --target versions_clean/<target>/cli.js --output <scratch>/patched.js --summary-path <scratch>/summary.json
   ```

   ```bash
   bun scripts/export-prompts.ts <scratch>/patched.js --label <target>-patched --output-dir <scratch>/export
   ```

   ```bash
   mise run verify:prompt-surfaces -- <scratch>/export
   ```

   ```bash
   mise run verify:prompt-drift -- <scratch>/export --prompt-drift-baseline prompt-surface-baseline.json
   ```

8. **Correct prompt drift deliberately.** If prompt surfaces fail, read the exported Markdown that failed and update the patch, exporter, or `src/verification/prompt-surface-rules.ts`.

   If drift hashes fail, generate a comparison report:

   ```bash
   mise run prompts:export -- <target> --label <target>-clean --output-dir <scratch>/clean-export
   ```

   ```bash
   bun run prompts:compare <scratch>/clean-export <scratch>/export /etc/claude-code -- --output <scratch>/prompt-compare.md
   ```

   Refresh `prompt-surface-baseline.json` only after the new patched export is reviewed as known-good:

   ```bash
   mise run prompts:drift-baseline -- prompt-surface-baseline.json <scratch>/export --prompt-drift-version <target>
   ```

   Do not call drift corrected until a fresh `verify:prompt-drift` run passes.

9. **Update release docs and checked baselines.** Update the README target badge, README compatibility target, and `prompt-surface-baseline.json` version when the target changes. Check for stale version anchors:

   ```bash
   rg -n '<old>|<target>' README.md prompt-surface-baseline.json
   ```

10. **Promote the native binary.** Forward `--dry-run` or `--force` only if the user supplied it or a local source fix needs a fresh cached build.

    ```bash
    mise run native:update -- <target>
    ```

    If a fixed source change still appears absent from the promoted build, rerun with `--force` to avoid cached-build reuse.

11. **Confirm the promoted runtime.**

    ```bash
    claude --version
    ```

    ```bash
    mise run status
    ```

12. **Run final verification and read the output.**

    ```bash
    mise run verify:patches
    ```

    Run focused tests for any touched patch or verifier files, and run the full suite when source tests changed:

    ```bash
    bun run test
    ```

    If `native:update` promoted successfully but post-update verification fails on formatting or lint, fix the source issue and rerun `mise run verify:patches` before reporting completion.

13. **Final report.** Separate these states:

    - Patch verification: matrix, native update, runtime version, status, and `verify:patches`.
    - Prompt-surface validity: `verify:prompt-surfaces` on the patched export.
    - Prompt drift: `verify:prompt-drift` against the reviewed baseline.
    - Drift summary: command/env/prompt/patch-risk highlights from `mise run diff`.
    - Changed files and any uncommitted leftovers.

If promotion fails after changing the active binary, surface the exact error, show `mise run status`, and suggest `mise run native:rollback`.

## Gotchas

- Clean bundle first. Do not start from the patched promoted bundle when fixing upstream anchor drift.
- `native:update` passing does not mean prompt drift was corrected. Drift is corrected only by a source fix or reviewed baseline refresh followed by a passing drift verifier.
- `prompts:compare` is review evidence, not a pass/fail gate.
- `verify:patches:matrix` is pre-promotion confidence; `verify:patches` on the real native path is still the completion floor.
