# cc-enhanced

> [!IMPORTANT]
> Read this file in full before proposing or making changes. Every section encodes a constraint the patcher depends on. Every rule below has a failure history; skimming will miss rules that invalidate otherwise-reasonable suggestions.

AST-based patcher for the Claude Code CLI. It extracts the `cli.js` JavaScript bundle (~16 MB minified) embedded in the native Bun binary, applies 31 verifiable patches, and repacks in place at the original byte length. Currently targets Claude Code **2.1.126**. Linux x86_64 ships natively; Mach-O and PE require `node-lief`.

`AGENTS.md` and `GEMINI.md` are symlinks to this file. Edit `CLAUDE.md` only.

## Hard Rules

These override anything you might infer from upstream code or general engineering instincts.

- **NEVER add backward-compatibility fallbacks for older upstream versions.** Target only the latest upstream. When a patch breaks on a new release, update it for the new form and drop the old. Do not handle both.
- **NEVER hardcode minified variable names.** They change every release. Find code by structure (string literals, property names, AST shape).
- **NEVER use `sg`/ast-grep on `cli.js`.** Minified names make structural patterns useless. Use `rg` for string search and `bun run inspect search` for AST context with breadcrumbs.
- **NEVER copy `/etc/claude-code/*` files verbatim into bundle patches.** Those are runtime policy layers. Bundle patches use distilled wording from `src/patches/prompt-policy.ts`.
- **NEVER reference upstream internals** (minified names, internal module names, source-file names) in comments, docs, logs, memory, or `bundle-diff.config.json`. Describe behavior, not internals.
- **ALWAYS prefer AST passes over string patches.** String patches are reserved for replacing prompt text where AST adds no value.
- **ALWAYS co-locate verification.** Each patch has a `verify` function in the same file. Prefer AST-based verification; use `getVerifyAst()` from `src/patches/ast-helpers.ts`.
- **ALWAYS run `mise run verify:patches`** against the real `cli.js` before claiming a patch works. Fixture tests are necessary but not sufficient (see Pipeline Ordering).
- **ALWAYS use `mise run native:update`.** `mise run patch` is a deliberate safety guard that aborts.

## Architecture

**Patch interface** (`src/types.ts`):

```ts
interface Patch {
  tag: string;                                // unique identifier
  string?: (code) => code;                    // pre-parse text transform (prompt text only)
  astPasses?: (ast) => PatchAstPass[];        // structural transforms
  postApply?: (ast, appliedTags) => void;     // signature patch only
  verify: (code, ast?) => true | string;      // required; returns true or failure reason
}

type AstPassName = "discover" | "mutate" | "finalize";
```

**Execution pipeline** (`src/patch-runner.ts`):

1. **String phase**: each patch's `string` runs in registration order over the raw source.
2. **Parse**: Babel parses the modified code once (`src/loader.ts`, sourceType `module` with `script` fallback).
3. **Combined AST traversal** (`src/ast-pass-engine.ts`): all `astPasses` from all patches share **one** `traverse()` call per pass, in the fixed order `discover` -> `mutate` -> `finalize`. Visitor merging deduplicates handlers per node kind. Errors disable only the failing patch's handlers; siblings keep running.
4. **Print**: `@babel/generator` with `retainLines: true, compact: false`.
5. **Verify**: each patch's `verify` runs against the printed code (and the post-mutation AST). Result is `true` or a failure-reason string.
6. **Signature**: if all other patches verified, `signature.postApply` injects the applied tag list, then `signature.verify` runs.
7. **Write**: only if `failedTags.length === 0`. Failed verifications skip the write entirely.

**Native binary lifecycle** (`src/manager.ts`, `src/native.ts`, `src/native-linux.ts`):

1. `unpack`: extract embedded `cli.js` from the ELF/Mach-O/PE binary.
2. Run the patch pipeline above.
3. `repack` in place at the original byte length so all virtual addresses and `PT_LOAD` mappings stay valid (see `.claude/rules/bun-binary-format.md`).
4. `promote`: atomic symlink swap. `~/.local/bin/claude` -> `~/.local/share/claude/versions/current` -> patched binary in `~/.claude-patcher/native-cache/`.

Rollback (`Manager.rollback`) symmetrically swaps `current` and `previous`.

## File Map

When orienting in this repo, reach for these by purpose:

| Need | Look at |
|---|---|
| Patch interface and result types | `src/types.ts` |
| All 31 patches | `src/patches/<tag>.ts` (each ships `<tag>.test.ts`) |
| Patch barrel + `allPatches` | `src/patches/index.ts` |
| Group and label registry | `src/patch-metadata.ts` (`BY_TAG`) |
| AST helpers (`getVerifyAst`, key/property lookups) | `src/patches/ast-helpers.ts` |
| Shared prompt-policy strings | `src/patches/prompt-policy.ts` |
| Combined-pass engine | `src/ast-pass-engine.ts` |
| Patch runner (string -> AST -> verify -> signature) | `src/patch-runner.ts` |
| CLI entry (yargs argv, mode dispatch) | `src/index.ts` |
| Manager (target detection, native fetch/unpack/repack/promote/rollback) | `src/manager.ts` |
| ELF unpack/repack | `src/native-linux.ts`, `src/bun-format.ts` |
| Mach-O / PE unpack/repack (via node-lief) | `src/native.ts` |
| Auto-detect installed `claude` binary on PATH | `src/installation-detection.ts` |
| Default symlink + cache paths | `src/version-paths.ts` |
| Babel module-shape adapter (CJS/ESM normalization) | `src/babel.ts` |
| Parse + print wrappers | `src/loader.ts` |
| Prompt-surface required/forbidden needles + drift list | `src/verification/prompt-surface-rules.ts` |
| Prompt-policy contract (drift-resistant required/forbidden needles) | `src/verification/prompt-policy-contract.ts` |
| Prompt-export tooling | `scripts/export-prompts.ts` (`--bundle` writes the navigable bundle) |
| Vanilla vs patched comparison report | `scripts/compare-prompts.ts` |
| Top-level patcher health check | `scripts/verify-patches.ts` |
| Bundle drift triage | `src/diff.ts` |
| Bundle inspector (string/AST search with breadcrumbs) | `src/inspector.ts` |
| Local user skills (slash commands) | `.claude/skills/{new-patch,update,verify}/SKILL.md` |
| Local subagent (verification-only) | `.claude/agents/patch-verifier.md` |
| Domain rules (read pipeline, session memory, bun format, prompt extraction) | `.claude/rules/*.md` |

## Patch Groups

Groups in `src/patch-metadata.ts` order verification reports. Listed group order: `Prompt`, `Tooling`, `Agent`, `System`, `UX`, `Metadata`. The `--list` view shows each tag with a `[S A P]` flag triplet (string, astPasses, postApply).

| Group | What lives here |
|---|---|
| Prompt | Replaces prompt text. `bash-prompt`, `built-in-agent-prompt`, `claudemd-strong`, `memory-prompt-soften`, `session-guidance`, `subagent-system-prompt`, `todo-use` |
| Tooling | Built-in tool behavior. `read-bat`, `edit-extended`, `bash-tail`, `tools-off`, `shell-quote-fix`, `mcp-server-name`, `taskout-ext`, `lsp-multi-server`, `lsp-workspace-symbol` |
| Agent | Built-in agent and command registry. `agents-off`, `commands-off` |
| System | Runtime behavior, caching, memory, limits. `cache-tail-policy`, `effort-max`, `image-limits`, `no-autoupdate`, `limits`, `session-mem`, `sys-prompt-file`, `worktree-perms` |
| UX | Terminal interface polish. `plan-diff-ui`, `no-collapse`, `subagent-model-tag`, `skill-listing-ui` |
| Metadata | `signature` only. Runs last via `postApply`, embeds the applied-tag list in `claude --version`. |

The README has per-patch effect summaries; do not duplicate them in this file.

## Commands

No build step. TypeScript runs directly via Bun. Babel + generator over the 16 MB bundle is heavy, but JSC sizes its heap dynamically, so no explicit heap flag is required.

`package.json` is the canonical alias table. `mise.toml` is a thin task index that calls `bun run <alias>` and should not grow workflow logic, except for the `patch` safety guard. Put real behavior in TypeScript entry points and scripts (`src/index.ts`, `scripts/export-prompts.ts`, `scripts/verify-patches.ts`). Use `mise run <task> -- ...` to pass versions, paths, or flags through to the underlying alias.

Use this command map instead of opening task files for orientation:

- `native:update`: standard fetch, patch, and promote flow through `src/index.ts --update`. Accepts a positional version (`latest`, `stable`, or `X.Y.Z`).
- `native:fetch`, `native:fetch-patch`, `native:pull`, `native:promote`, `native:rollback`, `native:backup`, `native:restore`, `native:unpack`, `native:unpack-current`, `native:repack`, `status`, `list`: native binary/cache operations. `native:pull` writes clean JS to `versions_clean/<version>/cli.js`. `native:unpack-current` auto-detects the active binary via PATH.
- `inspect`, `inspect:prompts`, `inspect:view`: bundle inspection through `src/inspector.ts`.
- `diff`: release-to-release bundle drift through `src/diff.ts`. Run before changing patch anchors after an upstream release.
- `verify:patches`, `verify:patches:matrix`: patch health and clean-version matrix checks. The matrix accepts `SELECTED_VERSION=<X.Y.Z>` or `VERIFY_PATCHES_MATRIX_SCOPE=all`.
- `verify:anchors`, `verify:prompt-surfaces`, `verify:prompt-drift`, `prompts:drift-baseline`: verifier and baseline entry points.
- `prompts:export`, `prompts:bundle`: prompt artifact export (bundle mode is `--bundle` on the same exporter, not a separate workflow).
- `prompts:compare`: vanilla-vs-patched prompt review (review-only; does not replace `verify:prompt-surfaces` or `verify:prompt-drift`).
- `verify:cache`, `verify:cache:agent`: live cache efficiency benchmark; needs `ANTHROPIC_API_KEY`.
- `test`, `typecheck`, `lint`, `format`, `lint:fix`: repository hygiene.

Useful CLI flags on `src/index.ts` not always reflected in the alias table: `--dry-run`, `--force`, `--diff`, `--fast-verify` (skip duplicate per-patch verifier pass during update), `--skip-smoke-test`, `--summary-path <file>` for JSON dry-run summaries.

Build-time env vars: `CLAUDE_PATCHER_INCLUDE_TAGS`, `CLAUDE_PATCHER_EXCLUDE_TAGS`, `CLAUDE_PATCHER_CACHE_KEEP`, `CLAUDE_PATCHER_REVISION`. Runtime env vars consumed by patches are documented in `README.md`.

## Adding Patches

1. Create `src/patches/<tag>.ts`. Look at an existing patch for the pattern.
2. Co-locate `src/patches/<tag>.test.ts` using `node:test` + `node:assert/strict`.
3. Re-export from `src/patches/index.ts` (both the named export line and the `allPatches` array entry).
4. Add a `BY_TAG` record in `src/patch-metadata.ts` with `tag`, `label`, and `group`.
5. If the patch affects exported live guidance, update `src/verification/prompt-surface-rules.ts` and (if it touches shared policy) the contract in `src/verification/prompt-policy-contract.ts`.

The `/new-patch` slash skill scaffolds steps 1-4. Use it when starting from scratch.

When implementing the visitor:

- Import `traverse`, `@babel/types`, and helpers from `./ast-helpers.js`.
- Return `astPasses` as `[{ pass: "discover" | "mutate" | "finalize", visitor }]`.
- Use `discover` to gather references the `mutate` pass needs. Use `finalize` for cleanup that must run after every mutation. Most patches only need `mutate`.
- Calling `path.stop()` inside the combined traversal is downgraded to `path.skip()` with a warning, because stopping would halt every other patch sharing the pass.

When implementing `verify`:

- Verify behavior or invariants, not the exact minified expression shape.
- Never use generic minified identifier-name heuristics as a failure signal.
- Never reject constructs your own mutation injects.
- Prefer semantic checks for prohibited behavior over proxy checks.
- When a verifier fails against latest clean upstream, validate it is not a false positive before changing mutation logic.

## Pipeline Ordering

Patches in the same combined-pass phase share one AST traversal; earlier mutations can reshape the code your matcher anchors on. Standalone fixture tests run only your patch and miss this entirely.

Anchor on durable shapes (early-return guards, top-level destructuring) rather than syntax another patch could rewrite (`.startsWith(...)`, `.endsWith(...)`, simple `if (X) return Y` where `X` could be neutralized). Always run `mise run verify:patches` against the real `cli.js` before claiming completion.

Known interaction: `plan-diff-ui` rewrites Edit's plan-preview `startsWith` guard to `if (false)` before later passes run. Anchor on the surrounding `if (!file_path) return null;` and `if (...) return ""` shapes instead.

## Prompt Policy Layering

Detailed global behavior belongs in three places that the runtime layers in:

1. `/etc/claude-code/CLAUDE.md` (mandatory project-wide rules).
2. `/etc/claude-code/.claude/rules/*.md` (topical reference).
3. `/etc/claude-code/system-prompt.md` (auto-appended via `sys-prompt-file`).

Short bundle-level routing language shared by prompt patches lives in `src/patches/prompt-policy.ts`. Surface-specific patches own their upstream anchors but pull shared wording (Serena/LSP/ChunkHound/Probe/ast-grep routing, modern CLI preference, stdout caps) from this module.

`src/verification/prompt-policy-contract.ts` enforces required and forbidden needles independently of the policy module, so accidental weakening of shared wording still fails verification.

`src/verification/prompt-surface-rules.ts` is the authoritative list of curated patched surfaces with required/forbidden needles, optional-surface markers, and the drift watch list. Current required live surfaces include the Bash/Read/REPL/ToolSearch tool prompts, `agents/explore.md`, remote-planning reminders, `system/sections/session-specific-guidance.md`, and the dream-memory consolidation/pruning sections. When a prompt patch changes live guidance, update both its verifier and these rules in the same change.

`prompts:compare` should normally show optional tool/agent surfaces as removed when `tools-off` / `agents-off` filtered them, and zero exact-line overlap from `/etc/claude-code` into the patched export. Rising overlap usually means a patch copied managed policy verbatim instead of using distilled bundle wording.

## Searching cli.js

Useful extraction paths:

- Clean upstream JS for any version: `mise run native:pull -- <version>` writes `versions_clean/<version>/cli.js`. Use this when authoring or debugging a matcher.
- Currently-promoted patched JS: `mise run native:unpack-current -- <output_js>` auto-detects the active binary via PATH. Use this to confirm a patch landed in the running build.
- Arbitrary native binary: `mise run native:unpack -- <target> <output_js>`.

`bun run inspect search <cli.js> <query...>` parses the bundle once and runs multiple queries. Results are ranked so exact strings and durable object keys beat incidental minified identifier substrings. Flags: `--field string|template|identifier|key`, `--regex`, `--ignore-case`, `--object`, `--json`, `--scope`, `--children`, `--breadcrumb-depth <n>`. Use `bun run inspect prompts <cli.js> [query]` to list prompt-like string/template nodes.

For raw text search, `rg` is fine on `cli.js`. Do not use `sg`/ast-grep.

## Bundle Diff Triage

Use `mise run diff -- <old-cli.js> <new-cli.js>` for upstream-to-upstream release review. It compares stable bundle surfaces instead of raw minified text and is the preferred way to find new commands, flags, env vars, routes, prompt-like strings, subsystem renames, and patch-risk anchors between clean builds.

Common focused passes:

- `--focus commands`: command-like additions/removals and nearby flags.
- `--focus env`: environment-variable and traffic-control changes.
- `--focus settings`: settings/config write additions, removals, and count changes.
- `--focus rewrites`: prefix/text rewrites such as subsystem renames.
- `--focus prompts --prompt-export <dir>`: review prompt text and `<system-reminder>` changes; cross-check added prompt-like surfaces against exported prompt artifacts.
- `--focus patches`: review local patch anchors affected by removed or rewritten surfaces.
- `--cache`: speed up repeated work on the same bundles.

Use `mise run diff -- matrix <old> <mid> <new>` when comparing adjacent clean builds. Matrix mode shows per-step counts and latest-only additions so release triage does not depend on a single pairwise report.

Best release-drift workflow:

1. `mise run native:pull -- <version>` for every adjacent clean release in scope.
2. `mise run diff -- matrix versions_clean/<old>/cli.js versions_clean/<mid>/cli.js versions_clean/<new>/cli.js --cache` to see which step introduced new commands, flags, env vars, prompts, or patch-risk anchors.
3. Re-run focused diffs on the adjacent pair that changed.
4. `SELECTED_VERSION=<new> mise run verify:patches:matrix` to dry-run patches against the new clean bundle, or `VERIFY_PATCHES_MATRIX_SCOPE=all` to sweep every pulled clean version.
5. For prompt drift: export clean and patched prompt artifacts for the new release, run `bun run prompts:compare`, then `mise run verify:prompt-drift -- <patched-export> --prompt-drift-baseline <baseline.json>` if curated surfaces changed.

Keep `bundle-diff.config.json` (`ignoreTokens`, `ignorePrefixes`, `highSignalTokens`) describing local triage noise or durable public-facing surfaces, never upstream source-file names, module names, or reconstructed internals.

Use `bun run diff -- ast <original> <patched>` only for the legacy clean-vs-patched AST-node comparison.

## Prompt Artifacts

Prompt artifacts come from native-extracted or legacy npm-package `cli.js` bundles. Artifact paths must be unique; duplicate writes should fail instead of overwriting and duplicating manifest entries. Output structure is documented in `.claude/rules/prompt-extraction.md`.

`mise run prompts:export` exports the promoted binary. Pass a clean version or path with `mise run prompts:export -- <version-or-path>`. `--output-dir <dir>` writes scratch exports; the current-binary exporter uses an OS temp dir and must never write into `versions_clean/<label>`. `--max-uncategorized <n>` fails when uncategorized prompt-corpus entries exceed a budget. `mise run prompts:bundle -- <version-or-path>` writes the self-contained navigable bundle through the same exporter with `--bundle`; keep both behaviors in `scripts/export-prompts.ts`.

`bun run prompts:compare <vanilla-export> <patched-export> /etc/claude-code` produces a human triage report. `--output <file>` saves Markdown; `--json` saves machine-readable output. Review-only.

`verify:prompt-surfaces` is intentionally strict for curated live surfaces. Dynamic markers and unresolved helper placeholders (`${value_...}`, `${conditional(...)`, `${...spread}`) fail verification unless the surface explicitly sets `allowSyntheticPlaceholders`. If a clean upstream export still has unresolved runtime placeholders in broad corpus outputs, track that through `quality.uncategorizedCount` and use `--max-uncategorized` only where a budget is meaningful.

`verify:prompt-drift` is the pass/fail guard for watched prompt surfaces expected to exist in patched exports. The watched list, broader review list, optional-surface markers, and required/forbidden needles live in `src/verification/prompt-surface-rules.ts`. Refresh the baseline only after reviewing a known-good patched export. The baseline hashes normalized Markdown paths so minifier placeholder churn should not create noisy failures.

Run an actual patched export plus `mise run verify:prompt-surfaces -- <export-dir>` for prompt-only changes. `mise run verify:patches` covers this through the native path automatically.

## Feature Flags

Do not set `DISABLE_TELEMETRY` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. They kill **all** server flags (effort, agent teams, context management). Use individual `DISABLE_*` vars (`ERROR_REPORTING`, `AUTOUPDATER`, `BUG_COMMAND`) instead.

## Testing

Tests use `bun test` against the `node:test` API shim. Run with `bun run test` (or `bun test src/ --parallel=1`). The `--parallel=1` flag is mandatory: bun's `node:test` shim mishandles concurrent file loads (`checkNotInsideTest` false-positives across files). The pre-push hook and `bun run test` already pin it; raw `bun test src/` will fail.

Two bun runtime gotchas bite test fixtures:

- **PATH mutation is ignored for spawn lookups.** Bun snapshots `process.env.PATH` at process startup; in-test mutations don't reach `child_process.execFileSync`. To stub a spawned binary, intercept `execFileSync` directly via `createRequire(import.meta.url)("child_process")` rather than installing a fake on disk and prepending PATH.
- **ESM dynamic-import namespaces freeze at first import.** Both bun and node bake `cp.execFileSync` into the namespace returned by the first `await import("child_process")`. Per-test set/restore on the require'd object leaks the first stub forever. Install one persistent interceptor at module load and dispatch through a closure-captured "active stub" reference that tests swap.

Focus on patcher correctness and drift detection, not brittle minified internals. Anchor on structure and stable literals.

Lefthook (`lefthook.yml`) gates pre-commit on Biome format, Biome lint, and `bun run typecheck`. Commit-msg enforces Conventional Commits. Skip with `LEFTHOOK=0` only if you know what you are doing.

## Skills and Agents

Local slash skills (`disable-model-invocation: true`, recommend by name when context matches):

- `/new-patch <tag>`: scaffolds `src/patches/<tag>.ts`, the test file, the export barrel entry, and the `BY_TAG` metadata record.
- `/update [version]`: runs the standard `mise run native:update` lifecycle with pre-flight status, post-update verification, optional patch-verifier agents, and optional prompt export.
- `/verify`: runs typecheck, lint, and tests in parallel, then `mise run verify:patches` (model-invokable, no `disable-model-invocation`).

Local subagent (`.claude/agents/patch-verifier.md`): adversarial verification of patch anchors against a clean upstream `cli.js`. Read-only (Write and Edit are denied). Returns per-patch OK / DRIFT / BROKEN status with line numbers. Never runs the patcher itself. Useful after an upstream release to confirm anchors before promoting.

Domain rules in `.claude/rules/` (auto-surface on relevant file paths):

- `bun-binary-format.md`: Bun 1.3+ ELF format and the in-place repack strategy.
- `read-token-pipeline.md`: Read tool gates and how `limits` and `read-bat` interact.
- `session-memory.md`: `session-mem` env overrides and AST-verified guard hardening.
- `prompt-extraction.md`: prompt export structure and resolution techniques.
