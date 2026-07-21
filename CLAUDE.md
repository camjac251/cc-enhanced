# cc-enhanced

> [!IMPORTANT]
> Read this file in full before proposing or making changes. Every section encodes a constraint the patcher depends on. Every rule below has a failure history; skimming will miss rules that invalidate otherwise-reasonable suggestions.

AST-based patcher for the Claude Code CLI. It extracts the `cli.js` JavaScript bundle embedded in the native Bun binary, applies its full suite of verifiable patches, and repacks in place at the original byte length. Tracks the latest upstream release; the README badge is the canonical version anchor and `claude --version` on the promoted binary is the runtime check. Linux x86_64 ships natively; Mach-O and PE require `node-lief`.

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

**Memory hygiene** (load-bearing): one run holds a large fixed Babel working set over the formatted bundle. To keep that from compounding across the update flow, `run()` drops the parsed AST from `PatchResult` (`src/types.ts`) after printing, `src/patch-runner.ts` calls `clearTraverseCache()` (`src/babel.ts`) at the end of each run to release the Babel traverse cache, and the `--update` path (`src/index.ts`) forces a GC before spawning post-update verification so the verify pipeline starts from a clean heap. Removing any of these reintroduces the update-time OOM.

**Native binary lifecycle** (`src/manager.ts`, `src/native.ts`, `src/native-linux.ts`):

1. `unpack`: extract embedded `cli.js` from the ELF/Mach-O/PE binary.
2. Run the patch pipeline above.
3. `repack` in place at the original byte length so all virtual addresses and `PT_LOAD` mappings stay valid (see "Bun Standalone Binary Format").
4. `promote`: atomic symlink swap. `~/.local/bin/claude` -> `~/.local/share/claude/versions/current` -> patched binary in `~/.claude-patcher/native-cache/`.

Rollback (`Manager.rollback`) symmetrically swaps `current` and `previous`.

## Bun Standalone Binary Format

Related files: `src/native-linux.ts`, `src/bun-format.ts`, `src/native.ts`.

Bun 1.3+ changed how standalone binaries embed and discover modules. The repack strategy must match the current format version.

**Bun 1.3+ format**:

- A `.bun` ELF section holds `BUN_COMPILED.size`, a virtual address pointing to appended data.
- `PT_GNU_STACK` is repurposed as a `PT_LOAD` segment mapping the appended data into memory.
- Payload format: `[u64 payload_len][module data][offsets (32 bytes)][trailer]`.
- Runtime reads the virtual address from the `.bun` section and dereferences directly. It does not use file I/O for this lookup.
- Section headers are relocated after the payload, and `e_shoff` is updated accordingly.

**Repack strategy**:

- The `cli.js` module has a large precompiled bytecode payload in the data section.
- Patched JS is written directly over the bytecode area, which is comfortably larger than the formatted bundle.
- The module content pointer is updated and the bytecode pointer is zeroed.
- No overlay rebuild, no size changes, no ELF structure modifications.
- The binary stays exactly the same size, so all virtual addresses and mappings remain valid.

**Why not append and rebuild**: rebuilding the overlay changes `byteCount`, the payload length header, and the data section boundaries. The `BUN_COMPILED.size` virtual address and `PT_LOAD` mapping would need updating to match, along with the `.bun` section offset. In-place patching avoids this by keeping the original binary structure intact.

## File Map

When orienting in this repo, reach for these by purpose:

| Need | Look at |
|---|---|
| Patch interface and result types | `src/types.ts` |
| All patches | `src/patches/<tag>.ts` (each ships `<tag>.test.ts`); current roster via `bun run cli --list` |
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
| Local user skills (slash commands) | `.claude/skills/{new-patch,update}/SKILL.md` |
| Local subagent (verification-only) | `.claude/agents/patch-verifier.md` |
| Project workflows (multi-agent, read-only) | `.claude/workflows/*.js` (index: `.claude/workflows/README.md`) |

## Patch Groups

Groups in `src/patch-metadata.ts` order verification reports. `bun run cli --list` is the source of truth for which tags fall under which group, each shown with a `[S A P]` flag triplet (string, astPasses, postApply).

| Group | What lives here |
|---|---|
| Prompt | Replaces prompt text. |
| Tooling | Built-in tool behavior. |
| Agent | Built-in agent and command registry. |
| System | Runtime behavior, caching, memory, limits. |
| UX | Terminal interface polish. |
| Metadata | `signature` only: runs last via `postApply`, embeds the applied-tag list in `claude --version`. |

The README has per-patch effect summaries; do not duplicate them in this file.

## Commands

No build step. TypeScript runs directly via Bun. Babel + generator over the formatted bundle is heavy, but JSC sizes its heap dynamically, so no explicit heap flag is required.

`package.json` is the canonical alias table. `mise.toml` is a thin task index that calls `bun run <alias>` and should not grow workflow logic, except for the `patch` safety guard. Put real behavior in TypeScript entry points and scripts (`src/index.ts`, `scripts/export-prompts.ts`, `scripts/verify-patches.ts`). Use `mise run <task> -- ...` to pass versions, paths, or flags through to the underlying alias.

Use this command map instead of opening task files for orientation:

- `native:update`: standard fetch, patch, promote, and `verify:patches` flow through `src/index.ts --update`. Accepts a positional version (`latest`, `next`, `stable`, or `X.Y.Z`). Post-update verification runs lean: it checks prompt surfaces against the just-promoted binary instead of re-running the full patch pipeline again (the patch step already gated the promote on zero failed tags).
- `native:fetch`, `native:fetch-patch`, `native:pull`, `native:promote`, `native:rollback`, `native:backup`, `native:restore`, `native:unpack`, `native:unpack-current`, `native:repack`, `status`, `list`: native binary/cache operations. `native:pull` writes clean JS to `versions_clean/<version>/cli.js`. `native:unpack-current` auto-detects the active binary via PATH.
- `inspect`, `inspect:prompts`, `inspect:view`: bundle inspection through `src/inspector.ts`.
- `diff`: release-to-release bundle drift through `src/diff.ts`. Run before changing patch anchors after an upstream release.
- `verify:patches`, `verify:patches:matrix`: patch health and clean-version matrix checks. The matrix accepts `SELECTED_VERSION=<X.Y.Z>` or `VERIFY_PATCHES_MATRIX_SCOPE=all`.
- `verify:anchors`, `verify:prompt-surfaces`, `verify:prompt-drift`, `prompts:drift-baseline`: verifier and baseline entry points.
- `prompts:export`, `prompts:bundle`: prompt artifact export (bundle mode is `--bundle` on the same exporter, not a separate workflow).
- `prompts:compare`: vanilla-vs-patched prompt review (review-only; does not replace `verify:prompt-surfaces` or `verify:prompt-drift`).
- `verify:cache`, `verify:cache:agent`: live cache efficiency benchmark; needs `ANTHROPIC_API_KEY` unless `--dry-run` is set.
- `test`, `typecheck`, `lint`, `format`, `lint:fix`: repository hygiene. Formatting and linting use Biome (`lint` = `biome check src/`, `format` = `biome format --write src/`); the bundle normalizer (`src/normalizer.ts`) also shells to the bundled Biome to format the extracted `cli.js` before parsing.

Useful CLI flags on `src/index.ts` not always reflected in the alias table: `--dry-run`, `--force`, `--diff`, `--fast-verify` (skip duplicate per-patch verifier pass during update), `--skip-smoke-test`, `--summary-path <file>` for JSON dry-run summaries.

Build-time env vars: `CLAUDE_PATCHER_INCLUDE_TAGS`, `CLAUDE_PATCHER_EXCLUDE_TAGS`, `CLAUDE_PATCHER_CACHE_KEEP`, `CLAUDE_PATCHER_REVISION`, `CLAUDE_PATCHER_PROFILE` (set to `1` to emit per-phase and per-tag verify timings plus passive process-memory checkpoints to stderr during each patch run). Runtime env vars consumed by patches are documented in `README.md`.

## Adding Patches

1. Create `src/patches/<tag>.ts`. Look at an existing patch for the pattern.
2. Co-locate `src/patches/<tag>.test.ts` using `node:test` + `node:assert/strict`.
3. Re-export from `src/patches/index.ts` (both the named export line and the `allPatches` array entry).
4. Add a `BY_TAG` record in `src/patch-metadata.ts` with `tag`, `label`, and `group`.
5. If the patch affects exported live guidance, update `src/verification/prompt-surface-rules.ts` and (if it touches shared policy) the contract in `src/verification/prompt-policy-contract.ts`.
6. **When the total patch count changes** (adding or removing a patch), update `README.md` (intro paragraph and the patch-count badge near the top) and confirm the new total against `bun run cli --list` before pushing.

The `/new-patch` slash skill scaffolds steps 1-4. Use it when starting from scratch. Recommend it by name; do not improvise the scaffold by hand.

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

Shared visitor kinds. Multiple patches register visitors for the same node kinds in the same pass; merged into one visitor list with no source-order guarantee between sibling handlers. The rows below list only patches whose `mutate`-pass visitor object exposes that node kind as a top-level key, since those are the handlers the engine actually merges. A patch that instead does its work inside `Program: { exit() }` runs its own private `traverse()` and does not collide through merged per-node dispatch, so it is not listed even when it touches the same node kinds. The `{patch, pass, visitorKey}` snapshot test keeps these rows honest; regenerate them from its output rather than by hand.

| Node kind | Patches sharing `mutate`-pass visitors | Risk |
|---|---|---|
| `IfStatement` | `plan-diff-ui`, `plan-compact-execute`, `session-mem`, `no-collapse`, `sys-prompt-file`, `effort-stack` | `plan-diff-ui` rewrites tests to `false`. Other handlers reading the test can misidentify a rewritten guard if they don't anchor on the unique shape of their target. |
| `Function` / `FunctionDeclaration` / `FunctionExpression` | `bash-prompt`, `cache-tail-policy`, `effort-stack`, `file-link-targets`, `no-autoupdate`, `agents-off`, `skill-paths-invoke`, `skill-activation-notice`, `plan-compact-execute` | `cache-tail-policy` uses `body.splice()` at a marker statement index, sensitive to upstream insertion of extra statements. Anchors on body length or specific statement positions can drift. |
| `ObjectExpression` | `tools-off`, `commands-off`, `image-limits`, `plan-compact-execute`, `taskout-ext`, `effort-stack`, `skill-global-paths` | `tools-off` mutates `isEnabled` properties on tool objects. Patches that scan tool ObjectExpressions for other properties may see a partially mutated shape depending on which mutator visited first. |

Rule of thumb: if a verifier needs to detect "did MY mutation land", it should mirror the mutator's own predicates exactly (capture per-site counters in module scope when feasible) rather than rely on a global shape check that could be satisfied by another patch's output.

The combined-pass engine skips later merged handlers on a path whose node was replaced (different node instance) by an earlier handler, so kind-changing `path.replaceWith(...)` no longer crashes siblings that were registered for the original node kind. This is a safety net for full-node replacement only; in-place AST shape mutations (rewriting children, flipping operators, swapping test expressions) still flow through every sibling handler, so the hazards in the table above continue to require defensive matchers.

## Read Tool Token Pipeline

Related files: `src/patches/limits.ts`, `src/patches/read-bat.ts`, `src/patches/limits.test.ts`, `src/patches/read-bat.test.ts`.

The Read tool has a multi-gate pipeline that limits what reaches the API. The `limits` patch raises key hard caps: byte ceiling, token budget, and `maxResultSizeChars`. It keeps persistence as a safety net so oversized formatted reads are persisted instead of staying inline in context.

| Gate | What | Default | Patched | Unit |
|---|---|---:|---:|---|
| Byte ceiling | File size pre-check, no range only | 256 KB | 1 MB | bytes |
| Token budget | API token count after read | 25,000 | 50,000 | tokens |
| Line formatting | Adds line numbers | 7 chars/line | 7 chars/line | overhead |
| Persistence | Replaces oversized results with disk summary | 50,000 | 120,000 | chars |
| Read `maxResultSizeChars` | Per-tool cap fed into persistence | 100,000 | 250,000 | chars |

The effective persistence limit is `Math.min(maxResultSizeChars, persistenceThreshold)`. Before patching, this was `min(100K, 50K) = 50K chars`, about 12K tokens, which was far tighter than the token budget. After patching, it is `min(250K, 120K) = 120K chars`, about 30K tokens, so the token budget still governs read success while persistence prevents very large formatted output from bloating active context.

Notes:

- `lineChars`, the per-line char truncation mentioned in prompts, is prompt-only fiction. No runtime enforcement exists upstream.
- `linesCap` is only used in the context-attachment fallback path, not normal reads.
- `read-bat` only auto-tails by default for `*.output` files. Other text files can still be read in full when `range` is omitted.
- `read-bat` caps changed-file reminder snippets to a head+tail summary at 8,000 chars per file.
- The `read-bat` fallback logic passes range-derived `offset` and `limit` into the stock reader and propagates `maxSizeBytes` only for unbounded fallback reads where `limit === void 0`, matching stock bounded-read semantics while preserving range behavior when `bat` is unavailable.

## Prompt Policy Layering

Detailed global behavior belongs in runtime-managed policy files under `/etc/claude-code/`, plus the auto-appended `/etc/claude-code/system-prompt.md` layer. The auto-append layer is intended to survive replacement-mode `--system-prompt` launches unless the caller supplies its own append prompt. Subagent contexts should receive the same resolved append prompt both through the runtime fallback and through startup option propagation, and `CLAUDE.md` user context is intended to remain available to subagent contexts.

Short bundle-level routing language shared by prompt patches lives in `src/patches/prompt-policy.ts`. Surface-specific patches own their upstream anchors but pull shared wording (Serena/LSP/ChunkHound/Probe/ast-grep routing, modern CLI preference, stdout caps) from this module.

`src/verification/prompt-policy-contract.ts` enforces required and forbidden needles independently of the policy module, so accidental weakening of shared wording still fails verification.

`src/verification/prompt-surface-rules.ts` is the authoritative list of curated patched surfaces with required/forbidden needles, optional-surface markers, and the drift watch list. Current curated live surfaces include Bash/Read/REPL/ToolSearch/Edit tool prompts, Agent tool routing, `agents/explore.md`, `agents/plan.md`, worker/workflow-subagent/claude agent surfaces, remote-planning reminders, optional `system/sections/schedule-remote-agents.md`, `system/sections/session-specific-guidance.md`, and the dream-memory consolidation section. When a prompt patch changes live guidance, update both its verifier and these rules in the same change.

`prompts:compare` should normally show optional tool/agent surfaces as removed when `tools-off` / `agents-off` filtered them, zero exact-line overlap from `/etc/claude-code` into the patched export, and `Unicode Dash Style` patched counts at zero. Rising overlap usually means a patch copied managed policy verbatim instead of using distilled bundle wording. Nonzero patched dash counts mean a prompt surface is still demonstrating en dash or em dash prose style and should be fixed before refreshing drift baselines.

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
5. For prompt drift: export clean and patched prompt artifacts for the new
   release, run `mise run verify:prompt-surfaces -- <patched-export>`, run
   `bun run prompts:compare`, then fix patch/exporter/rule drift or refresh
   `prompt-surface-baseline.json` only after the new patched export has been
   reviewed as known-good. `mise run verify:patches` always runs
   `verify:prompt-drift` against that baseline.

Keep `bundle-diff.config.json` (`ignoreTokens`, `ignorePrefixes`, `highSignalTokens`) describing local triage noise or durable public-facing surfaces, never upstream source-file names, module names, or reconstructed internals.

Use `bun run diff -- ast <original> <patched>` only for the legacy clean-vs-patched AST-node comparison.

## Prompt Artifacts

Prompt artifacts come from native-extracted or legacy npm-package `cli.js` bundles. Artifact paths must be unique; duplicate writes should fail instead of overwriting and duplicating manifest entries.

`mise run prompts:export` exports the promoted binary. Pass a clean version or path with `mise run prompts:export -- <version-or-path>`. `--output-dir <dir>` writes scratch exports; the current-binary exporter uses an OS temp dir and must never write into `versions_clean/<label>`. `--max-uncategorized <n>` fails when uncategorized prompt-corpus entries exceed a budget. `mise run prompts:bundle -- <version-or-path>` writes the self-contained navigable bundle through the same exporter with `--bundle`; keep both behaviors in `scripts/export-prompts.ts`.

`bun run prompts:compare <vanilla-export> <patched-export> /etc/claude-code` produces a human triage report. It includes file inventory, manifest deltas, watched-surface status, Unicode dash-style counts, `/etc` exact-line overlap, and policy-term presence. `--output <file>` saves Markdown; `--json` saves machine-readable output. Review-only.

`verify:prompt-surfaces` is intentionally strict for curated live surfaces. Dynamic markers and unresolved helper placeholders (`${value_...}`, `${conditional(...)`, `${...spread}`) fail verification unless the surface explicitly sets `allowSyntheticPlaceholders`. If a clean upstream export still has unresolved runtime placeholders in broad corpus outputs, track that through `quality.uncategorizedCount` and use `--max-uncategorized` only where a budget is meaningful.

`verify:prompt-drift` is the pass/fail guard for watched prompt surfaces expected to exist in patched exports. The watched list, broader review list, optional-surface markers, and required/forbidden needles live in `src/verification/prompt-surface-rules.ts`. `prompt-surface-baseline.json` is the default baseline for `mise run verify:patches`. Refresh it only after reviewing a known-good patched export. The baseline hashes normalized Markdown paths so minifier placeholder churn should not create noisy failures.

Run an actual patched export plus `mise run verify:prompt-surfaces -- <export-dir>` for prompt-only changes. `mise run verify:patches` covers this through the native path automatically.

When asked to check prompt drift after an update, report three separate states:

- **Patch verification**: whether `mise run native:update`,
  `claude --version`, `mise run status`, and `mise run verify:patches` passed.
- **Prompt-surface validity**: whether
  `mise run verify:prompt-surfaces -- <patched-export>` passed.
- **Prompt drift**: whether watched prompt hashes match
  `prompt-surface-baseline.json` (or the explicit `PROMPT_DRIFT_BASELINE`
  override). If the command fails, drift was detected, not corrected. Inspect
  the changed exported Markdown and the `prompts:compare` report, then fix the
  patch/exporter/rules or refresh the baseline only after the new export is
  reviewed as known-good.

Do not say prompt drift was corrected just because the binary promoted, prompt
surfaces passed, or a comparison report was generated. "Corrected" means a
source change removed unintended drift, or a reviewed baseline was
intentionally refreshed and the new `verify:prompt-drift` run passes.

## Prompt Extraction

Related files: `scripts/export-prompts.ts`, `src/prompt-corpus.ts`, `src/prompt-corpus.test.ts`.

`scripts/export-prompts.ts` performs AST-based extraction of all prompt text from `cli.js`. Pass a clean version (`X.Y.Z`), a path to a `cli.js`, or `current` to extract from the currently promoted patched binary. `--bundle` writes the navigable bundle through the same exporter.

Output structure:

```text
exported-prompts/<version>/
|-- agents/                  # Per-agent markdown + agents.json
|-- skills/                  # Per-skill markdown + skills.json
|-- system/
|   |-- sections/            # Per-section markdown + sections.json
|   |-- variants/            # System prompt variants markdown
|   |-- reminders/           # Per-reminder markdown + reminders.json
|   |-- builder-outline.md   # Assembly order of the system prompt
|   `-- system-prompts.json
|-- tools/
|   |-- builtin/             # Per-tool markdown
|   |-- schemas/             # Schema-only tools
|   `-- sections/            # Per-tool sub-section decomposition by heading
|-- workflows/               # Workflow & orchestration surface index (links to canonical files)
|-- internal-agents/         # Internal model call prompts
|-- tools.json
|-- skills.json
|-- workflows.json
|-- output-styles.json
|-- corpus-categorized.json
|-- corpus-summary.json
|-- data-references.json
|-- prompt-corpus.json
|-- prompts-<version>.json
|-- prompt-hash-index.json
|-- runtime-symbol-map.json
`-- manifest.json
```

Extraction coverage spans built-in agents, skills, tool prompts (plus heading-based sub-sections), schema-only tools, system prompt variants, sections, and reminders, internal-agent prompts, data references, output styles, the aggregated workflow/orchestration view, and the full prompt corpus. Per-category counts are not pinned here, since they move every upstream release: each export's `manifest.json` (`counts`) carries the live numbers, and `bun run prompts:export -- <version>` regenerates them.

The extractor handles `cli.js` patterns that naive string extraction misses:

- Function reference resolution: `getSystemPrompt: fnRef` follows through `functionBindings`.
- Local variable scoping: temporarily injects local `let`, `var`, and `const` bindings to prevent name collisions from global string bindings.
- Template expression inlining: `` `${fn()}` `` follows zero-arg calls inside template literals.
- Method chain handling: `` `...`.trim() `` resolves the template and applies the method.
- Binary concatenation: `basePrompt + appendix` resolves both sides.
- Agent type validation: filters template interpolation artifacts such as `${...}` as false positives.

## Feature Flags

Do not set `DISABLE_TELEMETRY` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. They kill **all** server flags (effort, agent teams, context management). Use individual `DISABLE_*` vars (`ERROR_REPORTING`, `AUTOUPDATER`, `BUG_COMMAND`) instead.

## Session Memory Controls

Related files: `src/patches/session-mem.ts`, `src/patches/session-mem.test.ts`.

`session-mem` extends the live auto-dream memory gate with an explicit local override and AST-verified guard hardening.

| Area | Upstream | Patched behavior |
|---|---|---|
| Auto-dream availability | Server-side availability gate | Explicit `autoDreamEnabled: true` setting bypasses the availability gate |

`session-mem` verification is AST-based and covered by `src/patches/session-mem.test.ts`.

## Verification Cadence

Related files: `src/patches/`, `src/verification/`, `scripts/verify-patches.ts`, `src/ast-pass-engine.ts`, `src/patch-runner.ts`.

Run verification before claiming a patch change is done, before opening a PR, and before promoting a new build.

Repository hygiene commands are quick and have no side effects:

```bash
bun run typecheck
bun run lint
bun run test
```

Lefthook (`lefthook.yml`) gates pre-commit on Biome format, Biome lint, and `bun run typecheck`. Tests are not in the pre-commit gate; run them yourself.

Patcher health:

```bash
mise run verify:patches
```

This runs typecheck and lint, then patches the native target once (writing a temporary patched binary plus a `--summary-path` JSON of failed tags) and reuses that patched binary for the prompt-surface and prompt-drift checks. It does not promote, so it stays the authoritative pre-promote signal. The summary names every failed tag with the `verify()` reason string. Clean-`cli.js` anchor checks and the cli.js dry-run are opt-in via `CLI_TARGET`.

For a wider sweep across cached clean versions:

```bash
SELECTED_VERSION=<X.Y.Z> mise run verify:patches:matrix
VERIFY_PATCHES_MATRIX_SCOPE=all mise run verify:patches:matrix
```

Triaging failures:

- **typecheck**: read the `file:line` references and fix the type. Do not paper over with `any` or `@ts-expect-error`.
- **lint**: try `bun run lint:fix` for auto-fixable rules; address the rest manually.
- **test**: read the failing test name and assertion. Fixture failures usually mean the patch's matcher missed the new upstream shape.
- **verify:patches**: the failed-tag list points at per-patch `verify()` functions. Each reason string names the missing invariant. Check verifier robustness before changing mutation logic.

`mise run verify:patches` against the real native target is the floor for "this works". Fixture tests alone are necessary but not sufficient; see "Pipeline Ordering".

## Testing

Tests use `bun test` against the `node:test` API shim. Run with `bun run test` (or `bun test src/ --parallel=1`). The `--parallel=1` flag is mandatory: bun's `node:test` shim mishandles concurrent file loads (`checkNotInsideTest` false-positives across files). The pre-push hook and `bun run test` already pin it; raw `bun test src/` will fail.

Two bun runtime gotchas bite test fixtures:

- **PATH mutation is ignored for spawn lookups.** Bun snapshots `process.env.PATH` at process startup; in-test mutations don't reach `child_process.execFileSync`. To stub a spawned binary, intercept `execFileSync` directly via `createRequire(import.meta.url)("child_process")` rather than installing a fake on disk and prepending PATH.
- **ESM dynamic-import namespaces freeze at first import.** Both bun and node bake `cp.execFileSync` into the namespace returned by the first `await import("child_process")`. Per-test set/restore on the require'd object leaks the first stub forever. Install one persistent interceptor at module load and dispatch through a closure-captured "active stub" reference that tests swap.

Focus on patcher correctness and drift detection, not brittle minified internals. Anchor on structure and stable literals.

Lefthook (`lefthook.yml`) gates pre-commit on Biome format, Biome lint, and `bun run typecheck`. Commit-msg enforces Conventional Commits. Skip with `LEFTHOOK=0` only if you know what you are doing.

## Skills and Agents

Local slash skills (`disable-model-invocation: true`, recommend by name when context matches):

- `/new-patch <tag>`: scaffolds `src/patches/<tag>.ts`, the test file, the export barrel entry, and the `BY_TAG` metadata record. Scaffold-only; the rest of the procedure lives in "Adding Patches" above.
- `/update [version]`: runs the standard `mise run native:update` lifecycle
  with pre-flight status, mandatory post-update verification, mandatory prompt
  drift checking, and optional parallel patch-verifier subagents for anchor
  review.

Local subagent (`.claude/agents/patch-verifier.md`): adversarial verification of patch anchors against a clean upstream `cli.js`. Read-only (Write and Edit are denied). Returns per-patch OK / DRIFT / BROKEN status with line numbers. Never runs the patcher itself. Useful after an upstream release to confirm anchors before promoting.

Local workflows (`.claude/workflows/`, auto-register as read-only slash skills; explicit opt-in, never auto-run):

- `/patch-update`: validates every patch and watched prompt surface against a target clean bundle through deep `cli.js` inspection, then returns a severity-ordered fix plan. Run when a new upstream release appears.
- `/patch-audit`: deeper health audit. Adds verifier-robustness, pipeline-interaction, docs-and-counts, and per-patch test-hardening on top of `patch-update`'s anchor inspection. Run as a periodic or pre-push gate.
- `/release-triage`: run first on a new release. Sequential focused bundle diffs between two pulled clean versions, then parallel analysts for feature inventory, patch-risk clustering (shared-shape clusters called out), and watched prompt-surface impact, ending in an upstream-tracking-style report. Requires bundles already in `versions_clean/`.
- `/patch-smoke`: post-promote smoke check that the PROMOTED binary carries the current patch roster and post-patch invariants (signature tag list vs roster, needle probes in the unpacked live bundle). Catches stale promotes and verify-green-but-missing drift. Run after `mise run native:update`.

`patch-update` and `patch-audit` accept `mode` / `group` / `tag` / `focus` / `models` through `args` and lean on the `patch-verifier` subagent for inspection; `release-triage` and `patch-smoke` document their own args in `.claude/workflows/README.md`. The dynamic-workflow scripting contract lives in the Workflow tool description inside `cli.js` (extract with `mise run prompts:export`); authoring best practices live in the global `workflow-authoring` skill.
