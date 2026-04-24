---
name: update
description: "Fetch, patch, and promote a new Claude Code version via mise run native:update, with pre-flight status, post-update verification, and optional patch-verifier agents. User-only slash command. NOT for rolling back (run mise run native:rollback) or verifying existing patches without updating (use /verify)."
when_to_use: >-
  Recommend by name after an upstream Claude Code release, or when the user says
  'update claude', 'update claude code', 'pull the new version', 'fetch latest',
  'bump to 2.1.X', 'patch the new release', 'run native:update', or asks about
  applying patches to a new upstream version. Argument is an optional version
  specifier ('2.1.90', 'latest', 'stable') or flags ('--dry-run', '--force').
disable-model-invocation: true
---

# Update Workflow

Run the standard update lifecycle. `$ARGUMENTS` is an optional version specifier (e.g., `2.1.90`, `latest`, `stable`). Defaults to `latest`.

## Steps

1. **Pre-flight**: Run `mise run status` and show current/previous versions.
2. **Update**: Run `mise run native:update $ARGUMENTS`. If the user passed `--dry-run` or `--force` in `$ARGUMENTS`, forward those flags.
3. **Verify**: Run `claude --version` to confirm the new version is active.
4. **Post-update status**: Run `mise run status` again.
5. **Anchor check** (optional): Ask the user if they want to run patch-verifier agents. If yes:
   - Run `mise run native:pull <version>` to extract clean JS
   - Split the active patches into 3-4 groups (check `pnpm cli --list` for current count)
   - Launch parallel `patch-verifier` agents against `versions_clean/<version>/cli.js`
6. **Prompt export** (optional): Ask if they want to run `mise run prompts:export`.

If the update fails, show the error and suggest `mise run native:rollback`.
