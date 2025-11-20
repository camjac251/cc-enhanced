# Claude Code Patcher

A Node.js/TypeScript CLI for downloading, normalizing, and patching the `@anthropic-ai/claude-code` CLI.

## Features

- **Automated Download:** Fetches versions directly from the NPM registry.
- **Normalization:** Formats `cli.js` using Prettier (via Babel parser) to ensure readable and deterministic code.
- **Robust Patching:** Uses AST-based transformations (Recast) instead of brittle regex replacement.
- **Safety:** Verifies patches against expected structures and reports detailed results.

## Installation

```bash
cd patcher
pnpm install
pnpm build # optional, compiles to dist/
```

## Usage

Run commands from the `patcher/` directory.

### Basic Commands

```bash
# Download and patch the latest version
pnpm cli --latest 1

# Download and patch a specific version
pnpm cli -v 2.0.47

# Download ONLY (no patches, useful for diffing)
pnpm cli -v 2.0.47 --out-dir test-output-clean --no-patch
```

### Advanced Options

*   `--out-dir <path>`: Specify where to save versions (default: `versions`).
*   `--skip-format`: Skip Prettier formatting (faster, but patches might be less reliable on minified code).
*   `--summary-path <file.json>`: Write a machine-readable report of what happened.
*   `--no-enhance-prompts`: Disable prompt text modifications.
*   `--no-bump-limits`: Disable limit increases.

### Developer Tools

**Inspector (Search Code Context):**
Finds where code patterns exist in the AST. Essential for updating patches when upstream changes.
```bash
# Search for "A tool for editing files"
pnpm inspect search versions/2.0.47/package/cli.js "A tool for editing files"

# Search for identifiers named "kI"
pnpm inspect search versions/2.0.47/package/cli.js "kI" --type Identifier
```

**Smart Diff (Verify Patches):**
Compares two files by AST structure, ignoring whitespace/formatting noise.
```bash
pnpm diff diff test-output-clean/2.0.47/package/cli.js test-output/2.0.47/package/cli.js
```
