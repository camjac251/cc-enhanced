# cc-enhanced Workflows

Four project workflows, all explicit opt-in and read-only (`patch-smoke`
writes only a scratch unpack; diff passes write only their local cache).
`release-triage` front-runs a release, `patch-update` and `patch-audit` do the
broad release and patch-health review, and `patch-smoke` closes the loop after
a promote. Patch inspection and prompt-surface
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
  `verify()` catch real drift, and could it produce false positives?) from
  `standard` mode up, adds a docs-and-counts cross-check in `standard` and
  `full`, and in `full` mode adds a pipeline-interaction analysis (do patches
  step on each other in the AST pass engine?) plus per-patch test-hardening
  (each inspector emits paste-ready `node:test` assertions for whatever the
  current test and `verify()` leave unlocked, so future drift is caught
  automatically). The consolidated `testHardening` set is returned alongside
  the audit. Read-only.

- `release-triage`: run first on a new release. One agent runs the
  `mise run diff` matrix/pairwise and focused passes strictly sequentially
  (bundle diffs are memory-heavy and never overlap), then parallel analysts
  produce a feature inventory, patch-risk clusters (shared-shape clusters
  called out explicitly, since one undocumented runtime migration once broke
  five render patches at once), and watched prompt-surface impact, then a
  synthesis in the upstream-tracking style. Requires clean bundles already
  pulled; fast-fails with the exact `native:pull` commands otherwise. Args:
  `{old, new, mid, focus, models}`.

- `patch-smoke`: post-promote smoke check that the PROMOTED binary carries the
  current patch roster and post-patch invariants: signature tag list vs
  `bun run cli --list`, then per-patch needle probes in the unpacked live
  bundle. Post-patch needles are expected PRESENT there (the inverse of the
  clean-bundle checks), so absence is real signal: a stale promote or a patch
  that silently did not land. Verdict: pass / stale-promote / fail /
  inconclusive with exact next commands. Args: `{focus, models}`.

## Fan-out and cost

Both workflows group patches into work units before fanning out, so a run is
not one agent per patch:

- Large-source patches and rewrite-cascade participants (per the CLAUDE.md
  Pipeline Ordering section) each get their own agent for deep, isolated
  inspection. Patches that merely share visitor node kinds are batched;
  shared-visitor analysis belongs to `patch-audit`'s pipeline-interaction
  phase, not to per-patch anchor inspection.
- All other patches are batched together (a handful per agent); the
  `patch-verifier` subagent inspects each and reports one result per patch.
- Watched prompt surfaces are likewise checked in batches.

Work units are then run through a throttled fan-out: the first unit warms the
shared prompt cache, the rest run in small concurrent batches that stay under
the runtime's concurrent-agent cap, and a unit that returns null is retried
once. Any unit that still fails is surfaced as `not-inspected` in the result
(patches) or `not-checked` (surfaces), never silently dropped.

Agents are model-tiered so the orchestrating session model stays out of the
wide passes: inventory, batch anchor units, surface checks, and docs-and-counts
run on `sonnet`; solo (cascade / large-source) units and `patch-audit`
robustness units run on `opus`; pipeline-interaction, synthesis, and the fix
plan inherit the session model. Each tier gets its own throttled fan-out so
the per-model prompt cache warms before the wide waves. Any non-OK
classification produced by a `sonnet` unit is independently re-inspected once
on the session model (capped at 6 per run) before it reaches synthesis.
Override with `models` in args; set both tiers to `inherit` to disable
tiering.

In `patch-audit`, inspection depth scales with mode: `quick` checks anchors
only, `standard` adds verify() robustness in the same source read, and `full`
adds per-patch test-hardening. A patch source is never read twice per run.

Both workflows return compact per-patch projections alongside the synthesized
plan/audit; full anchor-hit detail for every patch and surface stays in the
run's journal (`journal.jsonl` in the run transcript directory). `patch-audit`
additionally returns the consolidated `testHardening` set in `full` mode.

The two big scripts deliberately duplicate their helper blocks
(`throttledFanout`, `buildWorkUnits`, args parsing, compaction): the workflow
runtime has no import mechanism, so shared code cannot live in a module. When
editing one copy, mirror the change in the other. `release-triage` and
`patch-smoke` are deliberately small (roughly 6-8 agents each) and use lighter
inline fan-out instead; their diff/unpack commands are memory-heavy and always
run alone inside a single sequential agent.

## Memory discipline

Bundle-parsing commands (`verify:patches`, `mise run diff`, `bun run inspect`,
`prompts:export`, `native:pull` / `native:unpack*` / `native:update`) each
hold a multi-GB working set; at most ONE may run on the machine at a time, and
even one slows everything else down. The workflows encode this at three
layers: heavy commands appear only inside dedicated single-agent sequential
phases (`patch-update`'s delta diff, `release-triage`'s diff pass,
`patch-smoke`'s unpack), every concurrently fanned-out agent is restricted to
`rg`/`bat` on the bundle and told to record unresolvable ambiguity as a
concern rather than reach for `bun run inspect`, and the `patch-verifier`
agent definition forbids `bun run inspect` in any parallel fan-out. No
workflow ever executes `verify:patches` itself; it is only ever emitted as a
next step for the user.

Corollaries for the invoking session: never launch these workflows while a
patcher command (`native:update`, `verify:patches`, a diff, an export) is
running elsewhere, and never run two of these workflows at once.

## Arguments

Both workflows accept an `args` object (or a JSON string, or a plain focus
string):

- `mode`:
  - `patch-update`: `quick` (high-risk group subset of patches, first 5 prompt
    surfaces), `delta` (versioning additionally runs
    `mise run diff -- <current> <target> --focus patches` between the current
    and target clean bundles, then inspects only flagged plus rewrite-cascade
    patches, reporting the rest as delta-skipped; falls back to `full` when
    the current clean bundle is missing), or `full` (default; everything).
  - `patch-audit`: `quick` (anchor inspection only, high-risk group subset),
    `standard` (adds per-patch verify() robustness and the docs-and-counts
    phase), or `full` (default; adds per-patch test-hardening and the
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
- `models`: `{ mechanical, deep }` model aliases for the tier map above
  (defaults `sonnet` / `opus`; `inherit` disables a tier).

Examples:

```js
Workflow({ name: 'patch-audit', args: { mode: 'quick' } })
Workflow({ name: 'patch-update', args: { tag: 'edit-extended,read-bat' } })
Workflow({ name: 'patch-update', args: { version: '2.1.185', patchedExportPath: 'exported-prompts/2.1.185' } })
```

## Suggested usage

- New upstream release appears: pull the clean bundle(s), run `release-triage`
  for the drift picture (it names patch-risk clusters and at-risk surfaces),
  then `patch-update`. Apply the fix plan it returns, then re-run
  `patch-update` to confirm clean. For routine releases where the current
  clean bundle is still in `versions_clean/`, `mode: 'delta'` keeps the run to
  a handful of agents; do a `full` pass before promoting when delta found
  fixes. For prompt needle validation, run
  `mise run prompts:export -- <version>` after promoting and re-run with
  `patchedExportPath`. After promoting with `mise run native:update`, run
  `patch-smoke` to confirm the live binary carries the current roster.
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
