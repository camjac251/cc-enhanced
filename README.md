# Claude Code Patcher

A TypeScript CLI for patching the `@anthropic-ai/claude-code` native binary with
AST-anchored, self-verifying transformations.

## Features

- **Native-First Patching:** Auto-detects installed `claude` binary and patches in place
- **Native Binary Support:** Linux ELF built-in, macOS/Windows via optional `node-lief`
- **Native Release Fetching:** Downloads official native binaries with manifest checksum verification
- **Native Ops:** Backup/restore and unpack/repack workflows for native binaries
- **Normalization:** Formats `cli.js` with Prettier for readable diffs
- **Combined AST Pass Engine:** Runs `discover/mutate/finalize` patch passes with per-patch isolation
- **Verification:** Auto-validates patches after application
- **Dry-Run:** Preview changes without writing

## Installation

```bash
pnpm install
```

For macOS/Windows native binary repacking support, install `node-lief`:

```bash
pnpm add node-lief
```

## Usage

```bash
# Default: auto-detect and patch installed native claude target
pnpm cli

# Standard update flow (fetch + patch + promote)
pnpm cli --update

# Update dry-run (fetch + patch preview, no promote)
pnpm cli --update --dry-run

# Update specific version
pnpm cli --update --native-fetch 2.1.56

# Patch explicit native binary path
pnpm cli --target /path/to/claude

# Patch explicit cli.js path
pnpm cli --target /path/to/cli.js

# Native backup/restore (target mode)
pnpm cli --target /path/to/claude --backup-only
pnpm cli --target /path/to/claude --restore

# Native unpack/repack workflows
pnpm cli --target /path/to/claude --unpack /tmp/claude.js
pnpm cli --target /path/to/claude --repack /tmp/claude.js

# Fetch official native binary into cache and patch it (writes sibling .patched file)
pnpm cli --native-fetch latest

# Fetch only (no patch), useful for staging updates
pnpm cli --native-fetch stable --native-fetch-only

# Fetch specific version/platform
pnpm cli --native-fetch 2.1.37 --native-platform linux-x64

# Preview without writing (dry-run)
pnpm cli --dry-run

# Show diff of changes
pnpm cli --diff

# Build lifecycle controls
pnpm cli --status
pnpm cli --promote /path/to/patched/claude
pnpm cli --rollback
```

## Common CLI Options

| Option | Default | Description |
|--------|---------|-------------|
| `--target <path>` | auto-detect | Patch specific `cli.js` or native `claude` binary |
| `--output <path>` | in-place | Output path for `--target` mode |
| `--detect-target` | off | Require auto-detection of installed `claude` target |
| `--backup-only` | off | Create backup of detected/target file and exit |
| `--restore` | off | Restore detected/target file from backup and exit |
| `--backup-path <file>` | auto | Backup file path for backup/restore |
| `--backup-dir <dir>` | `~/.claude-patcher/backups` | Backup root directory |
| `--unpack <file>` | off | Extract embedded native JS to file and exit |
| `--repack <file>` | off | Repack JS file into native target and exit |
| `--native-fetch <spec>` | off | Fetch native binary (`latest`, `stable`, or `X.Y.Z`) and patch that target |
| `--native-fetch-only` | off | Fetch native binary to cache and exit |
| `--native-platform <id>` | auto | Override fetch platform (e.g. `linux-x64`, `darwin-arm64`) |
| `--native-cache-dir <dir>` | `~/.claude-patcher/native-cache` | Native fetch cache root |
| `--native-force-download` | off | Ignore cached native binary and re-download |
| `--update` | off | Run combined fetch + patch + promote workflow |
| `--status` | off | Show current/previous/cached promoted versions |
| `--promote <path>` | off | Promote a patched binary to active launcher |
| `--rollback` | off | Roll back to previous promoted binary |
| `--rollback-target <path>` | off | Roll back to explicit binary target |
| `--skip-smoke-test` | off | Skip post-promote `--version` smoke check |
| `--fast-verify` | off | Skip duplicate per-patch verifier pass in update-time anchor checks |
| `--dry-run` | off | Preview without writing |
| `--diff` | off | Print diff output |
| `--no-patch` | on | Format-only mode (skip patch transformations) |
| `--summary-path <file>` | - | Write JSON summary report |
| `--list` | - | List available patch tags |

## MCP CLI Setup

When `ENABLE_EXPERIMENTAL_MCP_CLI=true` is set, Claude Code exposes MCP server interaction via `mcp-cli`. The upstream alias resolves symlinks at session start and goes stale after re-patching. A stable script at `~/.local/bin/mcp-cli` fixes this:

```bash
#!/usr/bin/env bash
exec ~/.local/share/claude/versions/current --mcp-cli "$@"
```

This delegates through the `current` symlink (updated by `mise run native:promote`), so it stays valid across version changes. The upstream code skips alias creation when `command -v mcp-cli` finds this script.

## Development

```bash
# Standard flow
mise run native:update
mise run native:update --dry-run

# Granular flow
mise run patch:target /path/to/claude
mise run native:fetch-patch latest
mise run native:promote /path/to/patched/claude
mise run native:rollback
mise run status

# Binary operations
mise run native:backup /path/to/claude
mise run native:restore /path/to/claude
mise run native:unpack /path/to/claude /tmp/claude.js
mise run native:repack /path/to/claude /tmp/claude.js
mise run native:fetch latest
mise run native:pull latest

# Inspection and diffing
mise run inspect versions_clean/<version>/cli.js "Edit"
mise run inspect:view versions_clean/<version>/cli.js 1000:1050
mise run diff /path/to/original.js /path/to/patched.js

# Verify patcher health (native target by default)
mise run verify:patches
mise run verify:anchors /path/to/patched-cli.js /path/to/clean-cli.js

# Live cache efficiency benchmark (requires ANTHROPIC_API_KEY)
mise run verify:cache --output-json /tmp/cache-report.json --output-csv /tmp/cache-report.csv

# Typecheck / lint / format
mise run typecheck
mise run lint
mise run lint:fix
mise run format

# Clean output directories
mise run clean
```

## Cache Efficiency Verification

`verify:cache` compares two request-shaping policies over the same transcript:

- `baseline`: tail window `1`, cache both user + assistant tail messages
- `patched`: tail window `2`, cache user tail messages only

The verifier sends both policies to the Anthropic Messages API and compares:

- `cache_read_input_tokens` (higher is generally better for reuse / ITPM headroom)
- `cache_creation_input_tokens` split (`ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`)
- estimated effective input cost using cache multipliers (`5m write=1.25x`, `1h write=2x`, `read=0.1x`)

By default the gate fails on:

- patched estimated cost regression (`--max-cost-regression-pct`, default `0`)
- patched cache-read delta below minimum (`--min-cache-read-delta`, default `0`)
- requests exceeding `--max-breakpoints` (default `4`) when `--fail-on-breakpoint-overflow` is enabled
- live runs where prompt caching never engages (`cache_creation_input_tokens=0` and `cache_read_input_tokens=0` for both baseline and patched) are marked inconclusive and fail

Notes:

- Benchmark output depends on transcript shape, model, and TTL; use the same fixture/model for stable comparisons.
- Tail-window expansion can increase cache writes early while improving later cache reads.

## Update Performance Notes

- `native:update` reuses compatible patched builds when clean binary hash, selected patch tags, and patcher revision match.
- `--fast-verify` skips duplicate per-patch verifier checks inside update-time anchor verification (anchor checks still run).

## Test Strategy (Upstream `cli.js` Drift)

`cli.js` is minified and owned upstream, so tests should validate patcher behavior and drift detection, not
specific minified symbols.

- Keep deterministic tests for patcher internals: runner invariants, pass-engine semantics, and patch `verify()` logic.
- Keep integration checks against real extracted binaries: `verify:anchors`, forced `native:update --force`, smoke `--version`.
- Avoid brittle tests tied to minified variable names or full-file snapshots of upstream `cli.js`.
- Treat verification failures as drift signals that need patch anchor updates, not as flaky test noise.

## Adding Patches

1. Create a patch file in `src/patches/`
2. Export it from `src/patches/index.ts`
3. Add it to `allPatches` in `src/patches/index.ts`

Prompt-patch contributor note: keep patch-injected prompt text behavior-specific and compatibility-focused; do not duplicate global policy from `/etc/claude-code/CLAUDE.md` or `~/.claude/system-prompt.md`.

See `CLAUDE.md` for architecture details.
