# cc-enhanced Workflows

Two project workflows. Both lean on the `patch-verifier` subagent for deep
cli.js inspection rather than relying on `mise run verify:patches` output
alone. `verify:patches` catches only what each patch's `verify()` function
knows to check; direct `rg` / `bat` / `bun run inspect` on the clean bundle
catches anchor drift, ambiguity, fragility, and verifier weakness.

## Workflows

- `patch-update`: lifecycle workflow for going to a new upstream version (or
  validating current patches against the latest clean bundle). Inspects every
  patch and every watched prompt surface against the target bundle in
  parallel, then returns a unified fix plan prioritized by severity. Read-only.

- `patch-audit`: deep health audit of all patches in the current state. Adds
  three layers beyond `patch-update`: a verifier-robustness audit (does each
  `verify()` catch real drift, and could it produce false positives?), a
  pipeline-interaction analysis (do patches step on each other in the AST
  pass engine?), and a docs-and-counts cross-check. Read-only.

## Suggested usage

- New upstream release appears: run `patch-update`. Apply the fix plan it
  returns, then re-run `patch-update` to confirm clean.
- Periodic health check or pre-push gate: run `patch-audit`. Address findings
  by severity. `verify:patches` is still the smoke test, but `patch-audit`
  is the deeper signal.
- Either workflow accepts a focus string via `args` (e.g. focus on a
  specific group or a specific version).
