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
  patch and every watched prompt surface against the target bundle, then
  returns a unified fix plan prioritized by severity. Read-only.

- `patch-audit`: deep health audit of all patches in the current state. Beyond
  `patch-update` it folds verifier robustness into each patch inspection (does
  `verify()` catch real drift, and could it produce false positives?), and adds
  a pipeline-interaction analysis (do patches step on each other in the AST
  pass engine?), a docs-and-counts cross-check, and per-patch test-hardening
  (each inspector emits paste-ready `node:test` assertions for whatever the
  current test and `verify()` leave unlocked, so future drift is caught
  automatically). The consolidated `testHardening` set is returned alongside
  the audit. Read-only.

## Fan-out and cost

Both workflows group patches into work units before fanning out, so a run is
not one agent per patch:

- Complex or high-interaction patches (large source, or patches named in the
  CLAUDE.md Pipeline Ordering shared-visitor table / rewrite-cascade set) each
  get their own agent for deep, isolated inspection.
- Small, independent patches are batched together (a handful per agent); the
  `patch-verifier` subagent inspects each and reports one result per patch.
- Watched prompt surfaces are likewise checked in batches.

Work units are then run through a throttled fan-out: the first unit warms the
shared prompt cache, the rest run in small concurrent batches that stay under
the runtime's concurrent-agent cap, and a unit that returns null is retried
once. Any unit that still fails is surfaced as `not-inspected` in the result
(patches) or `not-checked` (surfaces), never silently dropped.

In `patch-audit`, verify-robustness is produced in the same source read as the
anchor inspection, so a patch source is not read twice per run.

## Arguments

Both workflows accept an `args` object (or a JSON string, or a plain focus
string):

- `mode`:
  - `patch-update`: `quick` (high-risk group subset of patches, first 5 prompt
    surfaces) or `full` (default; everything).
  - `patch-audit`: `quick` (inspection only, high-risk group subset),
    `standard` (inspection + docs-and-counts), or `full` (default; adds the
    pipeline-interaction analysis).
- `group`: restrict to one patch group (e.g. `Tooling`, `Prompt`, `System`,
  `UX`, `Agent`). A group/tag filter that matches no patch fast-fails with a
  blocked status naming the filter.
- `tag`: restrict to specific patch tags (comma-separated string or array).
- `version` (`patch-update` only): target clean version to validate against;
  defaults to the highest-numbered `versions_clean/<version>/`.
- `patchedExportPath` (`patch-update` only): path to a patched prompt export.
  When set, prompt-surface checks also validate required/forbidden needles
  against that export. Without it, only clean-bundle anchor reachability is
  checked (needles describe post-patch state and cannot be validated against a
  clean cli.js).
- `focus`: free-text emphasis threaded into the agent prompts.

Examples:

```js
Workflow({ name: 'patch-audit', args: { mode: 'quick' } })
Workflow({ name: 'patch-update', args: { tag: 'edit-extended,read-bat' } })
Workflow({ name: 'patch-update', args: { version: '2.1.185', patchedExportPath: 'exported-prompts/2.1.185' } })
```

## Suggested usage

- New upstream release appears: run `patch-update`. Apply the fix plan it
  returns, then re-run `patch-update` to confirm clean. For prompt needle
  validation, run `mise run prompts:export -- <version>` after promoting and
  re-run with `patchedExportPath`.
- Periodic health check or pre-push gate: run `patch-audit`. Address findings
  by severity and apply the `testHardening` assertions it returns to lock in
  future drift detection. `verify:patches` is still the smoke test, but
  `patch-audit` is the deeper signal.

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
