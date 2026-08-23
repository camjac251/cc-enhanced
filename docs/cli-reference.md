# CLI and inspection reference

[Documentation home](README.md) · [Getting started](getting-started.md) · [Maintainer reference](maintainer-reference.md)

The commands below cover native lifecycle operations, target evidence, prompt export and verification, bundle inspection, and release-diff triage.

```bash
mise run native:update                            # Fetch + patch + promote + verify
mise run native:update -- <channel-or-version>    # latest, next, stable, or X.Y.Z
mise run native:update -- --dry-run               # Preview without promoting
mise run native:fetch-patch -- <version> --dry-run
mise run native:promote -- <build-path>           # Promote an already-patched cached build
mise run native:rollback                          # Swap current and previous symlinks
mise run status                                   # Show current, previous, cached
mise run desktop:sdk-contract -- --inventory <desktop-inventory-evidence> --evidence
mise run desktop:permission-probe -- --sdk-contract <desktop-sdk-contract-evidence> --evidence
mise run desktop:permission-preflight -- --inventory <inventory> --artifact <artifact> --sdk-contract <sdk> --probe-plan <plan> --profile-support <profile> --evidence
mise run remote:plan -- --evidence              # Deterministic blocked Remote Control plan
mise run remote:doctor -- --json                # Inspect known blockers; never starts a session
mise run remote:artifacts -- <matrix-args...>    # Build all 8 offline Remote host candidates
mise run remote:host -- <host-finalize-args...>  # Re-extract and run --version on one matching host
mise run remote:start -- <explicit-gates...>    # Consented receipt-bound foreground server
mise run self-hosted:plan -- --evidence          # Deterministic blocked runner plan; no start
mise run self-hosted:artifacts -- <matrix-args...> # Build 6 Linux/macOS structural candidates
mise run self-hosted:host -- <host-args...>      # Re-extract and run --version on one matching host
mise run self-hosted:image -- <image-args...>    # Build an untagged receipt-bound Linux x64 proof image
mise run self-hosted:wrapper -- <wrapper-args...> # Generate and synthetically prove exact exec handoff
mise run self-hosted:wrapper-image -- <args...>   # Bind wrapper into an untagged child image; no runner start
mise run native:pull -- <version>                 # Fetch upstream + extract clean JS to versions_clean/<version>/cli.js
mise run native:unpack-current -- <out>           # Extract patched JS from the currently-promoted binary (auto-detects via PATH)
mise run native:unpack -- <bin> <out>             # Extract embedded JS from any native binary
mise run verify:patches                           # Typecheck + lint + native patch + prompt drift
SELECTED_VERSION=<X.Y.Z> mise run verify:patches:matrix # Dry-run patches against one clean cli.js
VERIFY_PATCHES_MATRIX_SCOPE=all mise run verify:patches:matrix
PATCH_EVIDENCE_OUTPUT=/tmp/<version>.json mise run verify:patches
PATCH_EVIDENCE_DIR=/tmp/patch-evidence SELECTED_VERSION=<X.Y.Z> mise run verify:patches:matrix
bun run patch-evidence:compare /tmp/<old>.json /tmp/<new>.json
mise run verify:anchors -- <patched-cli> <clean-cli>
mise run verify:prompt-surfaces -- <export-dir>
mise run verify:prompt-drift -- <export-dir> --prompt-drift-baseline <baseline.json>
mise run prompts:export                           # Export prompt artifacts from promoted binary
mise run prompts:export -- <version> --output-dir /tmp/prompts-<version>
mise run prompts:drift-baseline -- <export-dir> --prompt-drift-version <version>
bun run prompts:compare <vanilla-export> <patched-export> /etc/claude-code
bun run prompts:compare:matrix <old-clean> <old-patched> <new-clean> <new-patched> /etc/claude-code
bun run inspect search versions_clean/<version>/cli.js "Read" --field string --object
bun run inspect prompts versions_clean/<version>/cli.js "Command sandbox"
bun run diff -- versions_clean/<old>/cli.js versions_clean/<new>/cli.js
bun run diff -- matrix versions_clean/<v1>/cli.js versions_clean/<v2>/cli.js versions_clean/<v3>/cli.js
bun run cli --list                                   # List available patches
bun run test                                      # Run one isolated test-file process at a time
```

High-memory entrypoints are mutually exclusive across terminals and nested workflow processes. Nested child commands inherit the active lease, and the operating system releases it if the owner exits or crashes. There is no fixed RAM admission threshold. Normal patch and update runs avoid detailed structural telemetry, and `--summary-path` alone stays lean. Add `--structural-evidence` for handler counts, overlap evidence, and recursive structural hashes. The verification scripts add that flag automatically when `PATCH_EVIDENCE_OUTPUT` or `PATCH_EVIDENCE_DIR` requests a persisted release manifest. Large verifier sets release Babel traversal state once at their midpoint; smaller filtered runs avoid the extra collection.

`mise run patch` is intentionally disabled; it exists only to redirect to `native:update`. `package.json` is the canonical alias table, and `mise.toml` is kept as a thin task index that calls those aliases. Use `mise run <task> -- ...` to pass versions, paths, or flags through to the underlying Bun alias. Non-trivial workflow logic lives in TypeScript, especially [`scripts/verify-patches.ts`](../scripts/verify-patches.ts). See `mise.toml` for the task list and `bun run cli --help` for CLI flags.

## Prompt Artifacts and Inspection

Prompt exports are generated from `cli.js` bundles extracted from native builds. That keeps the installed artifact as the truth while still making prompt drift reviewable as Markdown and JSON artifacts. Export comparisons require the current expression-hash corpus schema and fail closed on older hashless artifacts.

```bash
mise run prompts:export -- current
mise run prompts:export -- <version> --output-dir /tmp/prompts-<version>
mise run prompts:export -- versions_clean/<version>/cli.js --label <version>-check \
  --output-dir /tmp/prompts-<version>-check --max-uncategorized 200
mise run prompts:bundle -- current
```

Useful outputs:

| File | Purpose |
| --- | --- |
| `manifest.json` | Counts, input bundle path, generated file list, and prompt-quality metadata such as `uncategorizedCount`. |
| `corpus-categorized.json` | Prompt-corpus entries grouped by category. |
| `tools/builtin/*.md`, `agents/*.md`, `system/sections/*.md` | Human-reviewable live prompt surfaces. |
| `workflows/README.md`, `workflows.json` | Aggregated workflow/orchestration surface index linking to canonical prompt files. |

`verify:prompt-surfaces` checks the curated patched surfaces and fails on dynamic prompt markers or unresolved helper placeholders such as `${value_...}`, `${conditional(...)`, and `${...spread}` unless that specific surface allows synthetic runtime placeholders. Broad corpus exports may still contain runtime-only placeholders; track those with `manifest.quality.uncategorizedCount` and use `--max-uncategorized` only when you want a hard drift budget.

`verify:prompt-drift` adds a path-based drift guard for the surfaces this patcher cares about most. `prompt-surface-baseline.json` is checked in and used by `mise run verify:patches` by default. Generate or refresh it only from a reviewed known-good patched export:

```bash
mise run prompts:drift-baseline -- exported-prompts/<version>_patched --prompt-drift-version <version>
```

Then compare future exports against it:

```bash
mise run verify:prompt-drift -- exported-prompts/<new-version>_patched --prompt-drift-baseline prompt-surface-baseline.json
mise run verify:patches
```

The baseline hashes normalized Markdown by exported path, not by content-derived prompt id. The drift watch list in [`src/verification/prompt-surface-rules.ts`](../src/verification/prompt-surface-rules.ts) is authoritative for surfaces expected to exist in patched exports; optional surfaces removed by `tools-off` / `agents-off` stay in the broader review list but are not baseline requirements. If a new watched surface is added but the baseline has not been refreshed, `verify:prompt-drift` fails with `baseline-missing-surface`. If a watched hash changes, the update is not complete until the patch/exporter/rules are corrected or the baseline is refreshed after reviewing the new export as known-good. Edit the same file to choose which surfaces are watched, which optional surfaces are review-only, and which required/forbidden needles are enforced. Normalization ignores generated `source_symbol` values and renumbers synthetic `${value_...}` / `${expr_...}` placeholders so minifier churn does not create noisy drift.

`prompts:compare` is a human review report for comparing a vanilla prompt export, a patched prompt export, and the runtime `/etc/claude-code` policy layer. It reports file inventory deltas, manifest count changes, Unicode dash-style counts, review prompt-surface status (including optional surfaces intentionally removed by patching), exact-line overlap from `/etc` into the patched bundle export, and policy-term presence across both layers. The patched `Unicode Dash Style` counts should normally be zero; nonzero counts mean an exported prompt still demonstrates en dash or em dash prose style and should be reviewed before refreshing drift baselines.

```bash
bun run prompts:compare exported-prompts/<version> exported-prompts/<version>_patched /etc/claude-code
bun run prompts:compare exported-prompts/<version> exported-prompts/<version>_patched /etc/claude-code -- --json
bun run prompts:compare exported-prompts/<version> exported-prompts/<version>_patched /etc/claude-code -- --output /tmp/prompt-comparison.md
```

`prompts:compare:matrix` separates four relationships that a single clean-to-patched report cannot: previous clean to current clean, previous patched to current patched, previous clean to previous patched, and current clean to current patched. It also compares interpolation dependencies from each `prompt-corpus.json`. The exporter hashes each raw expression before storing the corpus, so the report detects display-token collisions while exposing only dependency parity and invalid-reference counts. Older exports without expression hashes remain readable but report dependency parity as `unknown`, never `exact`.

```bash
bun run prompts:compare:matrix \
  exported-prompts/<old> exported-prompts/<old>_patched \
  exported-prompts/<new> exported-prompts/<new>_patched \
  /etc/claude-code
```

Every patch summary now carries a code-free `result.evidence` manifest. It records whole-input/output SHA-256 hashes, exact patch pass/fail state, handler counts, shared-node overlap counts, and semantic witnesses where a patch defines them. Deep evidence additionally records bounded structural hashes that ignore identifier and literal values. Persist a deep manifest with `PATCH_EVIDENCE_OUTPUT` for native verification or `PATCH_EVIDENCE_DIR` for matrix verification, then compare adjacent releases with `patch-evidence:compare`. These manifests are drift evidence, not a replacement for `mise run verify:patches`.

The inspector parses a bundle once per invocation and can run multiple search queries:

```bash
# Clean upstream JS for matcher development
mise run native:pull -- <version>                       # writes versions_clean/<version>/cli.js

# Currently-promoted patched JS for verifying a patch landed in the running build
mise run native:unpack-current /tmp/cli-patched.js

bun run inspect search versions_clean/<version>/cli.js "You are Claude Code" "Read a file" \
  --json --limit 5 --breadcrumb-depth 10 --object

bun run inspect search versions_clean/<version>/cli.js '^read$' --regex --ignore-case --field string
bun run inspect prompts versions_clean/<version>/cli.js "Command sandbox" --context 2

# Diff patched output against clean upstream
bun run diff -- versions_clean/<version>/cli.js /tmp/cli-patched.js
```

Use `rg` for quick literal string search in `cli.js`; use `bun run inspect search` when you need ranked AST matches, value-kind filters, nearest object context, byte span, breadcrumbs, scope, or JSON output. Do not use ast-grep on `cli.js`.

## Bundle Diff and Release Triage

`bun run diff` defaults to bundle-surface comparison. It is meant for upstream-to-upstream release review, where raw minified diffs are too noisy and prompt exports can miss new command wiring, telemetry surfaces, routes, or feature flags.

```bash
# Broad release report
bun run diff -- versions_clean/<old>/cli.js versions_clean/<new>/cli.js --limit 20

# Narrow reports while triaging a build
bun run diff -- versions_clean/<old>/cli.js versions_clean/<new>/cli.js --focus commands
bun run diff -- versions_clean/<old>/cli.js versions_clean/<new>/cli.js --focus settings
bun run diff -- versions_clean/<old>/cli.js versions_clean/<new>/cli.js --focus rewrites --markdown
bun run diff -- versions_clean/<old>/cli.js versions_clean/<new>/cli.js --focus patches

# Cross-check prompt artifacts against added prompt-like bundle surfaces
bun run diff -- versions_clean/<old>/cli.js versions_clean/<new>/cli.js \
  --prompt-export /tmp/prompts-<new> --focus prompts

# Cache extracted surfaces for repeated analysis
bun run diff -- versions_clean/<old>/cli.js versions_clean/<new>/cli.js --cache

# Compare a run of adjacent versions and summarize latest-only additions
bun run diff -- matrix \
  versions_clean/<v1>/cli.js \
  versions_clean/<v2>/cli.js \
  versions_clean/<v3>/cli.js \
  --markdown
```

The report groups high-signal additions and removals, suppresses opaque short object-key churn, reconstructs command candidates with nearby descriptions and flags, detects settings-write count changes, separates `<system-reminder>` prompt surfaces, detects prefix/text rewrites such as subsystem renames, highlights capability candidates, and estimates patch relevance from local patch anchors. For clean-vs-patched AST node comparison, call the AST mode explicitly:

```bash
bun run diff -- ast versions_clean/<version>/cli.js /tmp/cli-patched.js
```

Optional `bundle-diff.config.json` settings keep local triage noise out of reports without hardcoding upstream internals:

```json
{
  "ignoreTokens": ["placeholder"],
  "ignorePrefixes": ["[debug]"],
  "highSignalTokens": ["gateway", "purge"]
}
```
