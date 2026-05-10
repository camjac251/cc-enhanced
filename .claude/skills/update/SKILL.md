---
name: update
description: >-
  Run the standard cc-enhanced update lifecycle: mise run native:update,
  claude --version confirm, post-update status, verify:patches, optional
  parallel patch-verifier subagents against the clean cli.js, and mandatory
  prompt drift correction when drift is detected. Wraps the rare orchestration
  value (parallel anchor sweep and prompt drift handling) on top of the plain
  mise task.
when_to_use: >-
  Recommend by name after an upstream Claude Code release, or when the user
  asks to "update Claude", "update Claude Code", "pull the new version",
  "fetch latest", "patch the new release", "run native:update", or names a
  target version. Also use when they ask to check prompt drift as part of an
  update. Argument is an optional version spec ("latest", "stable", or
  "X.Y.Z") or pass-through flags ("--dry-run", "--force"). NOT for rollback
  (use `mise run native:rollback`) and NOT for verifying patches without an
  update (the verification rule covers pre-commit cadence).
disable-model-invocation: true
---

# /update [version]

Run the standard update lifecycle. `$ARGUMENTS` is an optional version spec;
defaults to `latest`.

## Steps

1. **Pre-flight**: `mise run status`. Show current and previous versions.
2. **Update**: `mise run native:update $ARGUMENTS`. Forward `--dry-run` or
   `--force` if the user passed them.
3. **Confirm**: `claude --version` to verify the new version is active.
4. **Post-update status**: `mise run status` again.
5. **Required verification**: `mise run verify:patches`. Read the output.
   This includes prompt-surface verification and prompt drift verification
   against `prompt-surface-baseline.json` by default.
6. **Anchor check** (optional): ask the user if they want patch-verifier
   subagents. If yes:
   - `mise run native:pull -- <version>` to extract clean JS to
     `versions_clean/<version>/cli.js`.
   - Get the active patch list via `bun run cli --list`.
   - Split into 3-4 groups and launch parallel `patch-verifier` subagents
     against the clean cli.js. The subagent is read-only and reports
     OK / DRIFT / BROKEN per patch.
7. **Prompt drift correction** (required if `verify:patches` fails drift):
   - Export clean prompts for the target version:

     ```bash
     mise run native:pull -- <version>
     mise run prompts:export -- <version> \
       --label <version>_clean \
       --output-dir <clean-export-dir>
     ```

   - Export patched prompts from the promoted binary:

     ```bash
     mise run prompts:export -- current \
       --label <version>_patched \
       --output-dir <patched-export-dir>
     ```

   - Run `mise run verify:prompt-surfaces -- <patched-export-dir>`.
   - Run:

     ```bash
     mise run prompts:compare -- \
       <clean-export-dir> \
       <patched-export-dir> \
       /etc/claude-code \
       --output <report.md>
     ```

     and summarize watched-surface status plus `/etc` exact-line overlap.
   - Run the drift verifier again:

     ```bash
     mise run verify:prompt-drift -- <patched-export-dir> \
       --prompt-drift-baseline prompt-surface-baseline.json
     ```

   - If drift fails, correct the patch/exporter/rules or refresh
     `prompt-surface-baseline.json` only after the new patched export is
     reviewed as known-good. Do not finish the update while prompt drift is
     still failing.

If the update fails, surface the error and suggest `mise run native:rollback`.
