---
name: update
description: "Run the standard cc-enhanced update lifecycle: mise run native:update, claude --version confirm, post-update status, optional parallel patch-verifier subagents against the clean cli.js, optional prompt export. Wraps the rare orchestration value (parallel anchor sweep) on top of the plain mise task."
when_to_use: >-
  Recommend by name after an upstream Claude Code release, or when the user
  asks to "update Claude", "update Claude Code", "pull the new version",
  "fetch latest", "patch the new release", "run native:update", or names a
  target version. Argument is an optional version spec ("latest", "stable",
  or "X.Y.Z") or pass-through flags ("--dry-run", "--force"). NOT for rollback
  (use `mise run native:rollback`) and NOT for verifying patches without an
  update (the verification rule covers pre-commit cadence).
disable-model-invocation: true
---

# /update [version]

Run the standard update lifecycle. `$ARGUMENTS` is an optional version spec; defaults to `latest`.

## Steps

1. **Pre-flight**: `mise run status`. Show current and previous versions.
2. **Update**: `mise run native:update $ARGUMENTS`. Forward `--dry-run` or `--force` if the user passed them.
3. **Confirm**: `claude --version` to verify the new version is active.
4. **Post-update status**: `mise run status` again.
5. **Anchor check** (optional): ask the user if they want patch-verifier subagents. If yes:
   - `mise run native:pull -- <version>` to extract clean JS to `versions_clean/<version>/cli.js`.
   - Get the active patch list via `bun run cli --list`.
   - Split into 3-4 groups and launch parallel `patch-verifier` subagents against the clean cli.js. The subagent is read-only and reports OK / DRIFT / BROKEN per patch.
6. **Prompt export** (optional): ask if they want `mise run prompts:export`.

If the update fails, surface the error and suggest `mise run native:rollback`.
