# cc-enhanced

AST-based patcher for customizing the Claude Code CLI. Patches a ~16MB minified cli.js embedded in a native Bun binary.

## Architecture

**AST-Pass-First Patching**: all logic/structure changes use Babel AST traversal via a unified combined-pass engine (`discover` -> `mutate` -> `finalize`). String patches are only acceptable for replacing prompt text where AST adds no value. Each patch includes a co-located `verify` function. See `src/types.ts` for the `Patch` interface.

26 active patches grouped in `src/patch-metadata.ts`. Run `pnpm cli --list` to see them.

## Commands

No build step. All source runs directly via `tsx`. Babel AST + generator needs ~10GB heap for cli.js. `mise.toml` sets `NODE_OPTIONS="--max-old-space-size=12288"` automatically. Running `pnpm cli` directly without mise will OOM.

Standard workflow: `mise run native:update` (fetch + patch + promote). `mise run patch` deliberately fails as a safety guard; always use `native:update`. See `mise.toml` for all tasks, `pnpm cli --help` for all CLI options.

Key env vars: `CLAUDE_PATCHER_INCLUDE_TAGS`, `CLAUDE_PATCHER_EXCLUDE_TAGS`, `CLAUDE_PATCHER_CACHE_KEEP`, `CLAUDE_PATCHER_REVISION`.

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
- **Prompt policy lives outside patches**. Global policy belongs in `/etc/claude-code/CLAUDE.md` and `/etc/claude-code/system-prompt.md`.
- **Future-forward only**. Target latest upstream, no backward-compatibility fallbacks.
- **Abstract over upstream internals**. Comments, docs, and logs should describe behavior and purpose, not reproduce upstream code or reference its internal identifiers. Keep the surface area of exposed internals minimal.

## Verifier Robustness

- Verify behavior/invariants, not exact minified expression shape.
- Never use generic minified identifier-name heuristics as a failure signal.
- Support both legacy and current schema layouts when upstream may switch forms.
- Keep mutation and verification consistent: a verifier must not reject constructs injected by the same patch.
- Prefer semantic checks for prohibited behavior over proxy checks.
- When a verifier fails against latest clean upstream, first validate whether it is a false positive before changing mutation logic.

## Searching cli.js

**Never use ast-grep (sg) on cli.js.** Minified names make structural patterns useless. Use `rg` for string search or `pnpm inspect search` for AST context with breadcrumbs. Extract clean JS first with `mise run native:pull <version>`.

## Feature Flags

Do not set `DISABLE_TELEMETRY` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. These kill ALL server flags (effort, agent teams, context management). Use individual `DISABLE_*` vars (`ERROR_REPORTING`, `AUTOUPDATER`, `BUG_COMMAND`) instead.

## Testing

Tests use Node's built-in test runner: `pnpm test` runs `tsx --test`. Focus on patcher correctness and drift detection, not brittle minified internals. Anchor on structure and stable literals.
