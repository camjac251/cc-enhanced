# cc-enhanced Workflows

Two project workflows. Both are explicit opt-in, read-only workflows for broad
release and patch-health review. Patch inspection and prompt-surface
reachability phases lean on the `patch-verifier` subagent for deep cli.js
inspection rather than relying on `mise run verify:patches` output alone.
`patch-verifier` has separate patch-anchor and prompt-surface modes, so
extractor/rules checks do not have to masquerade as patch-source checks.
Synthesis phases use the default workflow subagent. `verify:patches` catches
only what each patch's `verify()` function knows to check; direct `rg` / `bat`
/ `bun run inspect` on the clean bundle catches anchor drift, ambiguity,
fragility, and verifier weakness.

## Workflows

- `patch-update`: lifecycle workflow for going to a new upstream version (or
  validating current patches against the latest clean bundle). Inspects every
  patch and every watched prompt surface against the target bundle in
  parallel, then returns a unified fix plan prioritized by severity. Read-only.

- `patch-audit`: deep health audit of all patches in the current state. Adds
  four layers beyond `patch-update`: a verifier-robustness audit (does each
  `verify()` catch real drift, and could it produce false positives?), a
  pipeline-interaction analysis (do patches step on each other in the AST
  pass engine?), a docs-and-counts cross-check, and per-patch test-hardening
  (each inspector emits paste-ready `node:test` assertions for whatever the
  current test and `verify()` leave unlocked, so future drift is caught
  automatically). Read-only.

## Suggested usage

- New upstream release appears: run `patch-update`. Apply the fix plan it
  returns, then re-run `patch-update` to confirm clean.
- Periodic health check or pre-push gate: run `patch-audit`. Address findings
  by severity and apply the `testHardening` assertions it returns to lock in
  future drift detection. `verify:patches` is still the smoke test, but
  `patch-audit` is the deeper signal.
- Either workflow accepts a focus string via `args` (e.g. focus on a
  specific group or a specific version).

## Authoring reference

These are plain dynamic-workflow scripts. To write or change one:

- Best-practice playbook: the global `workflow-authoring` skill
  (`~/.claude/skills/workflow-authoring/`).
- Usage, run management, and runtime limits: the official docs at
  <https://code.claude.com/docs/en/workflows>.
- The full scripting contract (the `meta` literal; the `agent` / `parallel` /
  `pipeline` / `phase` / `log` / `workflow` / `budget` / `args` helpers; schema
  rules; resume semantics) lives in the Workflow tool description inside
  `cli.js`. Extract it from a clean bundle with
  `mise run prompts:export -- <version>`, or search it directly with
  `bun run inspect`.
