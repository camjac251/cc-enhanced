# Claude Code Patcher

A TypeScript CLI for downloading and patching the `@anthropic-ai/claude-code` CLI to improve usability.

## Features

- **Native-First Patching:** Auto-detects installed `claude` binary and patches in place
- **Native Binary Support:** Linux ELF built-in, macOS/Windows via optional `node-lief`
- **Native Release Fetching:** Downloads official native binaries with manifest checksum verification
- **Native Ops:** Backup/restore and unpack/repack workflows for native binaries
- **Automated Download (Legacy):** Fetches npm package versions with tarball caching
- **Normalization:** Formats `cli.js` with Prettier for readable diffs
- **AST Patching:** Uses Babel for safe, structure-aware transformations
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
# Default: auto-detect installed native claude first, fallback to npm flow if none found
pnpm cli

# Patch explicit native binary path
pnpm cli --target /path/to/claude

# Require native auto-detection (fail if not found)
pnpm cli --detect-target

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

# Legacy npm flow: patch a specific package version
pnpm cli -v 2.0.75

# Preview without writing (dry-run)
pnpm cli --dry-run

# Show diff of changes
pnpm cli --diff

# Skip formatting (faster)
pnpm cli --no-format

# Legacy npm flow: output to different directory
pnpm cli --out-dir ./my-output

# Legacy npm flow: download without patching (for diffing)
pnpm cli --no-patch --out-dir versions_clean
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
| `-v, --version <ver>` | latest | Legacy npm version flow |
| `--dry-run` | off | Preview without writing |
| `--diff` | off | Print diff output |
| `--no-format` | on | Skip formatting |
| `--no-patch` | on | Download/normalize only |
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
# Native-first patch flow
mise run patch
mise run patch:target /path/to/claude
mise run native:backup /path/to/claude
mise run native:restore /path/to/claude
mise run native:unpack /path/to/claude /tmp/claude.js
mise run native:repack /path/to/claude /tmp/claude.js
mise run native:fetch latest
mise run native:fetch-patch latest

# Legacy npm flow: inspect and diff
mise run legacy:inspect 2.0.75 "search term"
mise run legacy:diff 2.0.75

# Verify patcher health (native target by default)
mise run verify:patches

# Type check
mise run typecheck

# Clean output directories
mise run clean
```

## Adding Patches

1. Create a patch file in `src/patches/`
2. Export it from `src/patches/index.ts`
3. Add it to `allPatches` in `src/patches/index.ts`

See `CLAUDE.md` for architecture details.
