# cc-enhanced

> [!IMPORTANT]
> Read this file in full before proposing or making changes. Every section encodes a constraint the patcher depends on (no backward-compat fallbacks, no hardcoded minified names, AST-first over string patches, co-located verifiers, behavior-based verification, future-forward policy, abstraction over upstream internals). Skimming will miss rules that invalidate otherwise-reasonable suggestions.

**NEVER add backward-compatibility fallbacks for older upstream versions.** Target only the latest upstream. When a patch breaks on a new version, update it for the new form and drop the old one. Do not handle both.

AST-based patcher for customizing the Claude Code CLI. Patches a ~16MB minified cli.js embedded in a native Bun binary.

## Architecture

**AST-Pass-First Patching**: all logic/structure changes use Babel AST traversal via a unified combined-pass engine (`discover` -> `mutate` -> `finalize`). String patches are only acceptable for replacing prompt text where AST adds no value. Each patch includes a co-located `verify` function. See `src/types.ts` for the `Patch` interface.

31 active patches grouped in `src/patch-metadata.ts`. Run `bun run cli --list` to see them.

## Commands

No build step. Project TypeScript runs directly via Bun. Babel AST + generator over the 16 MB cli.js is heavy but JSC sizes its heap dynamically, so no explicit heap flag is required.

Standard workflow: `mise run native:update` (fetch + patch + promote). `mise run patch` deliberately fails as a safety guard; always use `native:update`. `mise.toml` is a task index; non-trivial verification logic belongs in TypeScript scripts such as `scripts/verify-patches.ts`. See `mise.toml` for all task aliases and `bun run cli --help` for all CLI options.

Key env vars: `CLAUDE_PATCHER_INCLUDE_TAGS`, `CLAUDE_PATCHER_EXCLUDE_TAGS`, `CLAUDE_PATCHER_CACHE_KEEP`, `CLAUDE_PATCHER_REVISION`.

Prompt export workflow: `mise run prompts:export` exports the promoted binary, or pass a clean version/path. Use `--output-dir <dir>` for scratch exports and `--max-uncategorized <n>` to fail when uncategorized prompt-corpus entries exceed a budget. The current-binary exporter uses an OS temp directory and must never write into `versions_clean/<label>`.

Prompt comparison workflow: `bun run prompts:compare <vanilla-export> <patched-export> /etc/claude-code` generates a human triage report. Use `--output <file>` for a saved Markdown/JSON artifact and `--json` for machine-readable output. This is review-only: it compares file inventory, manifest count drift, review prompt-surface status, exact-line overlap from `/etc/claude-code`, and policy-term presence, but it does not replace `verify:prompt-surfaces` or `verify:prompt-drift`.

## Runtime

Promotion uses atomic symlinks: `~/.local/bin/claude` -> `versions/current` -> patched binary in `~/.claude-patcher/native-cache/`. Rollback swaps current/previous symmetrically.

## Adding Patches

1. Create `src/patches/<tag>.ts`
2. Export from and add to `allPatches` in `src/patches/index.ts`
3. Add metadata to `src/patch-metadata.ts` BY_TAG record

Look at an existing patch for the pattern. Use the `/new-patch` skill to scaffold all files.

## Key Principles

- **Never hardcode minified variable names**. They change between versions. Find by structure (string literals, property names).
- **AST passes for all logic**. Use `astPasses` for any structural/behavioral change. String patches for prompt text only.
- **Co-locate verification**. Each patch verifies its own success. Prefer AST-based verification. Use `getVerifyAst()` from `ast-helpers.ts`.
- **Prompt policy is layered**. Detailed global behavior belongs in `/etc/claude-code/CLAUDE.md`, `/etc/claude-code/.claude/rules/*.md`, and `/etc/claude-code/system-prompt.md`. Short bundle-level routing language shared by prompt patches belongs in `src/patches/prompt-policy.ts`. Do not copy the `/etc` files verbatim into bundle patches.
- **Future-forward only**. Target latest upstream, no backward-compatibility fallbacks.
- **Abstract over upstream internals**. Comments, docs, and logs should describe behavior and purpose, not reproduce upstream code or reference its internal identifiers. Keep the surface area of exposed internals minimal.

## Verifier Robustness

- Verify behavior/invariants, not exact minified expression shape.
- Never use generic minified identifier-name heuristics as a failure signal.
- Target only the current upstream form. Do not add fallbacks for old versions.
- Keep mutation and verification consistent: a verifier must not reject constructs injected by the same patch.
- Prefer semantic checks for prohibited behavior over proxy checks.
- When a verifier fails against latest clean upstream, first validate whether it is a false positive before changing mutation logic.

## Pipeline Ordering

Patches in the same combined-pass phase share one AST traversal; earlier mutations can reshape the code your matcher anchors on. Standalone fixture tests run only your patch and miss this entirely.

When writing a structural matcher, anchor on durable shapes (early-return guards, top-level destructuring) rather than syntax another patch could rewrite (`.startsWith(...)`, `.endsWith(...)`, simple `if (X) return Y` where `X` could be neutralized). Always run `mise run verify:patches` against the real cli.js before claiming completion. Fixture tests are necessary but not sufficient.

Known interaction: `plan-diff-ui` rewrites Edit's plan-preview `startsWith` guard to `if (false)` before later passes run. Anchor on the surrounding `if (!file_path) return null;` and `if (...) return ""` shapes instead.

## Searching cli.js

**Never use ast-grep (sg) on cli.js.** Minified names make structural patterns useless. Use `rg` for string search or `bun run inspect search` for AST context with breadcrumbs.

Two extraction paths, depending on what you want to inspect:

- Clean upstream JS for any version: `mise run native:pull <version>` writes `versions_clean/<version>/cli.js`. Use this when authoring or debugging a patch matcher against pristine upstream.
- Currently-promoted patched JS: `mise run native:unpack-current <output_js>` auto-detects the active binary via PATH. Use this to confirm a patch landed in the running build, diff against clean upstream, or hand the file to `bun run inspect`.
- Arbitrary native binary: `mise run native:unpack <target> <output_js>` for any cached or out-of-tree binary.

`bun run inspect search <cli.js> <query...>` parses the bundle once and can run multiple queries. Results are ranked so exact strings and durable object keys beat incidental minified identifier substrings. Add `--field string|template|identifier|key`, `--regex`, `--ignore-case`, `--object`, `--json`, `--scope`, `--children`, or `--breadcrumb-depth <n>` as needed. Use `bun run inspect prompts <cli.js> [query]` to list prompt-like string/template nodes.

## Bundle Diff Triage

Use `bun run diff -- <old-cli.js> <new-cli.js>` for upstream-to-upstream release review. It compares stable bundle surfaces instead of raw minified text and is the preferred way to find new commands, flags, env vars, routes, prompt-like strings, subsystem renames, and patch-risk anchors between clean builds.

Common focused passes:
- `--focus commands` for command-like additions/removals and nearby flags.
- `--focus env` for environment-variable and traffic-control changes.
- `--focus settings` for settings/config write additions, removals, and count changes.
- `--focus rewrites` for prefix/text rewrites such as subsystem renames.
- `--focus prompts --prompt-export <dir>` to review prompt text and `<system-reminder>` changes, then cross-check added prompt-like surfaces against exported prompt artifacts.
- `--focus patches` to review local patch anchors affected by removed or rewritten surfaces.
- `--cache` for repeated work on the same bundles.

Use `bun run diff -- matrix <old> <mid> <new>` when comparing adjacent builds. Matrix mode shows per-step counts and latest-only additions so release triage does not depend on a single pairwise report.

Keep bundle-diff config generic: `ignoreTokens`, `ignorePrefixes`, and `highSignalTokens` should describe local triage noise or durable public-facing surfaces, not upstream source-file names, module names, or reconstructed internals. Older source trees can guide heuristics, but do not encode or reveal source-specific assumptions in this repository. The output should describe product behavior and bundle-visible surfaces only.

Use `bun run diff -- ast <original> <patched>` only for the legacy clean-vs-patched AST-node comparison.

## Prompt Artifacts

Prompt artifacts are generated from native-extracted or legacy npm package `cli.js` bundles. Artifact paths must be unique, and duplicate writes should fail instead of overwriting and duplicating manifest entries.

Prompt-surface verification is intentionally strict for curated live surfaces. Dynamic markers and unresolved helper placeholders (`${value_...}`, `${conditional(...)`, `${...spread}`) are verifier failures unless the surface explicitly allows synthetic runtime placeholders. If a clean upstream export still has unresolved runtime placeholders in broad corpus outputs, track that through `quality.uncategorizedCount` and use `--max-uncategorized` only where a budget is meaningful.

`verify:prompt-drift` is the pass/fail guard for watched prompt surfaces expected to exist in patched exports. Its drift list, broader review list, optional-surface markers, and required/forbidden needles live in `src/verification/prompt-surface-rules.ts`; refresh the baseline only after reviewing a known-good patched export. The baseline hashes normalized Markdown paths so minifier placeholder churn should not create noisy failures.

`prompts:compare` is the broader review report. It should normally show optional tool/agent surfaces as removed when `tools-off` / `agents-off` filtered them, and zero exact-line overlap from `/etc/claude-code` into the patched export because `/etc/claude-code/system-prompt.md`, `CLAUDE.md`, and `.claude/rules/*.md` are runtime policy/context layers, not bundle prompt text. If overlap rises unexpectedly, check whether a patch copied managed policy verbatim instead of using distilled bundle wording.

Prompt patches must update both their own verifier and `src/verification/prompt-surface-rules.ts` when they affect exported live guidance. The current curated surfaces include Bash/Read/REPL/tool-search, Explore/Plan, remote-planning reminders, `system/sections/session-specific-guidance.md`, and the dream-memory consolidation/pruning sections. Run an actual patched export plus `bun run verify:prompt-surfaces <export-dir>` for prompt-only changes; `bun run verify:patches` covers this through the native path.

## Feature Flags

Do not set `DISABLE_TELEMETRY` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. These kill ALL server flags (effort, agent teams, context management). Use individual `DISABLE_*` vars (`ERROR_REPORTING`, `AUTOUPDATER`, `BUG_COMMAND`) instead.

## Testing

Tests use Bun's `bun test` runner against the `node:test` API shim. Run with `bun run test` (or `bun test src/ --parallel=1`). The `--parallel=1` flag is mandatory: bun's `node:test` shim mishandles concurrent file loads (`checkNotInsideTest` false-positives across files). Pre-push hook and `bun run test` already pin it; raw `bun test src/` will fail.

Two bun runtime gotchas bite test fixtures:
- **PATH mutation is ignored for spawn lookups.** Bun snapshots `process.env.PATH` at process startup; in-test mutations don't reach `child_process.execFileSync`. To stub a spawned binary, intercept `execFileSync` directly via `createRequire(import.meta.url)("child_process")` rather than installing a fake on disk and prepending PATH.
- **ESM dynamic-import namespaces freeze at first import.** Both bun and node bake `cp.execFileSync` into the namespace returned by the first `await import("child_process")`. Per-test set/restore on the require'd object leaks the first stub forever. Install one persistent interceptor at module load and dispatch through a closure-captured "active stub" reference that tests swap.

Focus on patcher correctness and drift detection, not brittle minified internals. Anchor on structure and stable literals.
