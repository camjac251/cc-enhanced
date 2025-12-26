# Claude Code Patcher

A TypeScript CLI for downloading and patching the `@anthropic-ai/claude-code` CLI to improve usability.

## Features

- **Automated Download:** Fetches versions from NPM registry with tarball caching
- **Normalization:** Formats `cli.js` with Prettier for readable diffs
- **AST Patching:** Uses Babel for safe, structure-aware transformations
- **Verification:** Auto-validates patches after application
- **Dry-Run:** Preview changes without writing

## Installation

```bash
pnpm install
```

## Usage

```bash
# Patch the latest version (default)
pnpm cli

# Patch a specific version
pnpm cli -v 2.0.75

# Preview without writing (dry-run)
pnpm cli --dry-run

# Show diff of changes
pnpm cli --diff

# Skip formatting (faster)
pnpm cli --skip-format

# Output to different directory
pnpm cli --out-dir ./my-output

# Download without patching (for diffing)
pnpm cli --no-patch --out-dir versions_clean
```

## Patch Options

| Option | Default | Description |
|--------|---------|-------------|
| `--prompts` | true | Prompt enhancements (bash, policy, guards) |
| `--edit-tool` | true | Edit tool extensions (line insert, diff, batch) |
| `--limits` | true | Bump read limits (5000 lines, 1MB) |
| `--signature` | true | Inject patch signature |
| `--verify` | true | Verify patches after applying |
| `--list` | - | List all available patches |

Use `--no-<option>` to disable (e.g., `--no-prompts`).

## Development

```bash
# Inspect AST for a string
mise run inspect version=2.0.75 query="search term"

# Compare patched vs clean
mise run diff version=2.0.75

# Verify a patched version
mise run verify version=2.0.75

# Type check
mise run typecheck

# Clean output directories
mise run clean
```

## Adding Patches

1. Create a rule in `src/patches/`
2. Register in `src/manager.ts`
3. Add tag in `src/patches/signature.ts`

See `CLAUDE.md` for architecture details.
