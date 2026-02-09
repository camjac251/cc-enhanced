# Claude Code Patcher

A tool for patching the `claude-code` CLI to improve privacy, performance, and usability.

## Architecture

**AST-First Patching** prioritizes correctness and resilience:

1. **AST Patches** (preferred) - Babel traversal for structural changes, resilient to minification
2. **String Patches** (prompt-only) - Only for replacing large prompt text blocks where AST adds no value
3. **Co-located Verification** - Each patch includes its own verify function

AST patches are required for any logic/structure changes. String patches are only acceptable for
replacing prompt text (tool descriptions, system messages) where the change is purely textual.

## Project Structure

```
.
├── src/
│   ├── index.ts          # CLI entry point (yargs-based)
│   ├── manager.ts        # Orchestrates format → patch
│   ├── normalizer.ts     # Prettier formatting
│   ├── patch-runner.ts   # Executes patches, runs verification, injects signature
│   ├── loader.ts         # Babel parser/generator wrapper
│   ├── inspector.ts      # AST search tool with breadcrumbs
│   ├── diff.ts           # Diff viewer for comparing versions
│   ├── native.ts         # Native binary extraction/repack (ELF + Mach-O/PE via node-lief)
│   ├── native-linux.ts   # Linux ELF-specific Bun overlay logic
│   ├── native-release.ts # Official release bucket fetch + caching
│   ├── installation-detection.ts # Installed target auto-detection
│   ├── patch-metadata.ts # Patch grouping, labels, and summary builder
│   ├── types.ts          # Patch interface, PatchResult
│   ├── patches/          # Individual patches (25 active tags + index)
│   │   ├── index.ts      # Exports allPatches array
│   │   └── *.ts          # Individual patch implementations
│   └── templates/
│       └── edit_hook.js  # Injected Edit tool logic
├── versions_clean/       # Output: clean formatted JS from native binaries (gitignored)
│   └── <version>/cli.js
├── mise.toml             # Task runner configuration
└── biome.json            # Linter/formatter configuration
```

## Output Directories

- **versions_clean/** - Clean formatted JS extracted from native binaries (for diffing)
- **~/.claude-patcher/native-cache/** - Cached native binaries fetched from official release bucket
- **~/.claude-patcher/backups/** - Automatic default backup location for native backup/restore

`versions_clean/` is gitignored.

## Patch Interface

Each patch is self-contained:

```typescript
interface Patch {
  tag: string;                              // Signature tag, e.g., "bash-prompt"
  string?: (code: string) => string;        // String transformation (runs first)
  ast?: (ast: t.File) => void | Promise<void>;     // AST transformation
  verify: (code: string, ast?: t.File) => true | string;  // Returns true or failure reason
}
```

## Patches Overview

Current patch set is 25 active patches, grouped by metadata in `src/patch-metadata.ts`.

### Prompt

| Tag | Purpose |
|-----|---------|
| `bash-prompt` | Bash tool prompt improvements |
| `prompt-rewrite` | Glob/Grep prompt rewrite to ast-grep/rg/fd |
| `claudemd-strong` | CLAUDE.md system prompt hardening |
| `skill-tools` | Skill allowed-tools prompt alignment |
| `todo-use` | Todo prompt trimming |

### Tooling

| Tag | Purpose |
|-----|---------|
| `bash-tail` | Bash output tail support |
| `taskout-ext` | Task output/status extensions |
| `mcp-server-name` | MCP server name validation fix |
| `edit-extended` | Edit tool enhancements |
| `tools-off` | Disable selected built-in tools |
| `read-bat` | Read tool behavior tuned for `bat` |
| `write-result-trim` | Reduce write result verbosity |

### Agent

| Tag | Purpose |
|-----|---------|
| `agents-off` | Disable/limit selected agent tools |

### System

| Tag | Purpose |
|-----|---------|
| `cache-tail-policy` | Cache tail window and user-only tail controls |
| `no-autoupdate` | Disable auto-updater |
| `mcp-timeout` | Increase MCP timeout defaults |
| `session-mem` | Session memory env/threshold controls |
| `sys-prompt-file` | System prompt file injection via local file |
| `flag-bypass` | Feature flag bypass (effort, agent teams, write guard) |
| `limits` | Read/token/size limit bumps |

### UX

| Tag | Purpose |
|-----|---------|
| `output-tokens` | Output token display behavior |
| `memory-write-ui` | Memory write rendering behavior |
| `no-collapse` | Disable tool output collapse |

### Metadata

| Tag | Purpose |
|-----|---------|
| `signature` | Inject patch signature into version/UI strings |

## Native Alternatives (2.1.0+)

Some patches have native alternatives in recent versions:

| Patch | Native Alternative |
|-------|-------------------|
| `limits.ts` | Set `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` and `API_MAX_INPUT_TOKENS` env vars |
| `disable-tools.ts` | Use `--tools` CLI flag to restrict tools |
| `agent-tools.ts` | Use `Task(AgentName)` syntax in settings.json permissions |
| ~~`allowed-tools-prompt.ts`~~ | Prompt removed upstream in 2.1.0 (patch removed) |
| ~~`chrome-wsl.ts`~~ | Fixed upstream in 2.1.1 (patch removed) |

## Commands

### CLI Options

```bash
pnpm cli [options]

Options:
  --no-format           Skip Prettier formatting
  --no-patch            Skip patching (format only)
  --dry-run             Preview without writing
  --diff                Show diff of changes
  --list                List available patches
  --summary-path <file> Write JSON summary to file
  --target <path>       Patch a local target path (cli.js or native claude binary)
  --detect-target       Auto-detect installed claude path from PATH and patch it
  --output <path>       Output path for --target mode (default: patch target in-place)
  --backup-only         Create backup of target and exit
  --restore             Restore target from backup and exit
  --backup-path <file>  Explicit backup file path for backup/restore
  --backup-dir <dir>    Backup root directory (default: ~/.claude-patcher/backups)
  --unpack <file>       Extract embedded JS from native target to file and exit
  --repack <file>       Repack JS file into native target and exit
  --native-fetch <spec> Fetch official native binary and use it as patch target (latest|stable|X.Y.Z)
  --native-fetch-only   Fetch native binary and exit without patching
  --native-platform     Override native fetch platform (linux-x64, darwin-arm64, windows-x64, etc.)
  --native-cache-dir    Override native release cache dir
  --native-force-download Force re-download even if cached binary exists

Environment variables:
  CLAUDE_PATCHER_INCLUDE_TAGS=a,b  Only run these patches (comma-separated tags)
  CLAUDE_PATCHER_EXCLUDE_TAGS=a,b  Skip these patches (comma-separated tags)

Default behavior: `pnpm cli` auto-detects the installed target and patches it.
`pnpm cli --detect-target` is equivalent (explicit auto-detect).
```

### Mise Tasks

```bash
# Patching
mise run patch                    # Auto-detect installed native claude and patch in-place (maintenance flow)
mise run patch:target /path/to/claude   # Patch explicit native binary path
mise run native:backup /path/to/claude  # Backup explicit native binary
mise run native:restore /path/to/claude # Restore explicit native binary
mise run native:unpack /path/to/claude /tmp/claude.js # Extract embedded JS
mise run native:repack /path/to/claude /tmp/claude.js # Repack JS into binary
mise run native:fetch latest      # Download latest native binary into cache only
mise run native:fetch-patch latest # Download latest native binary and patch it (writes to builds/ subdir)
mise run native:fetch-patch latest --force          # Force re-download
mise run native:fetch-patch latest --platform linux-x64  # Cross-platform
mise run native:promote /path/to/builds/timestamp-claude # Promote patched binary via symlinks
mise run native:rollback          # Roll back to previous promoted binary
mise run native:pull latest       # Extract clean formatted JS from native binary (for diffing)
mise run list                     # List available patches

# Development
mise run typecheck                # Run TypeScript type checking
mise run lint                     # Lint source files
mise run format                   # Format source files
mise run clean                    # Remove output directories
mise run verify:patches           # Full health check (typecheck + lint + dry-runs + summaries)
```

### Patching Runbook

```bash
# Recommended update flow: patch from a clean native binary
mise run native:fetch-patch latest --force

# Promote patched artifact to active launcher
mise run native:promote ~/.claude-patcher/native-cache/<version>/linux-x64/claude.patched

# Verify active launcher target + patch signature
claude --version

# Roll back to previous promoted binary if needed
mise run native:rollback

# Full health check (typecheck + lint + native dry-runs + summaries)
mise run verify:patches

# Override dry-run targets if needed
CLI_TARGET=/path/to/cli.js \
NATIVE_TARGET=/path/to/claude \
mise run verify:patches

# One-off dry-run with summary
pnpm cli --target /path/to/target --dry-run --summary-path /tmp/patch-summary.json

# In-place maintenance flow (patches currently installed target directly)
pnpm cli --detect-target
# equivalent:
mise run patch
```

Notes:
- `--target` accepts either a `cli.js` file or a native `claude` binary.
- Linux ELF native support is built-in. macOS/Windows native patching uses optional `node-lief`.
- Summary output is safe for large runs (`ast` is omitted and circular references are handled).
- `.tmp-build/` is generated build output and is gitignored.
- Promotion is symlink-based: `~/.local/bin/claude -> ~/.local/share/claude/versions/current -> <patched binary>`.
- Rollback uses `~/.local/share/claude/versions/previous` (updated automatically during promotion).
- `mise run verify:patches` skips native dry-run unless `NATIVE_TARGET` is set (e.g. `NATIVE_TARGET=~/.claude-patcher/native-cache/<version>/linux-x64/claude`).
- To avoid stale signatures from previously patched binaries, prefer `native:fetch-patch` + `native:promote` over repeated in-place patching.


### MCP CLI

When `ENABLE_EXPERIMENTAL_MCP_CLI=true` is set, Claude Code creates a shell alias `mcp-cli` pointing to the running binary with `--mcp-cli`. The upstream alias resolves symlinks at session start, so it goes stale after re-patching/promoting (points to the old binary path).

A stable script at `~/.local/bin/mcp-cli` bypasses this by delegating through the `current` symlink:

```bash
#!/usr/bin/env bash
exec ~/.local/share/claude/versions/current --mcp-cli "$@"
```

The upstream code checks `command -v mcp-cli` before creating the alias, so the PATH script takes priority. The symlink chain keeps it stable across version changes:

```
~/.local/bin/mcp-cli (stable script, created once)
  → ~/.local/share/claude/versions/current (symlink, updated by promote)
    → actual patched binary
```

## Adding Patches

1. Create patch file in `src/patches/`
2. Export from `src/patches/index.ts`
3. Add to `allPatches` array in `src/patches/index.ts`

That's it! No more updating types.ts, signature.ts, or manager.ts.

### Patch Template

```typescript
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";

export const myPatch: Patch = {
  tag: "my-patch",

  // Optional: string transformation (ONLY for prompt text replacement)
  // string: (code) => code.replace("old prompt", "new prompt"),

  // Optional: AST transformation
  ast: (ast) => {
    traverse.default(ast, {
      StringLiteral(path) {
        // Find by structure, not variable names
        if (path.node.value === "target") {
          path.node.value = "replacement";
        }
      },
    });
  },

  // Required: verification (returns true or failure reason)
  verify: (code) => {
    if (!code.includes("expected result")) {
      return "Missing expected result";
    }
    return true;
  },
};
```

## Key Principles

- **Never hardcode minified variable names** - they change between versions
- **Find by structure** - look for unique patterns (string literals, property names)
- **Resolve variables** - follow bindings to find actual string values
- **Co-locate verification** - each patch verifies its own success
- **AST patches for all logic** - use Babel traversal for any structural/behavioral change
- **String patches for prompts only** - only use string type for replacing tool description text

## Searching cli.js

**Never use ast-grep (sg) on cli.js** - use rg or the inspect tool instead.

The cli.js file is ~15MB, ~490K lines, with lines up to 189K characters (embedded prompts). While technically parseable, ast-grep patterns are useless because:

1. **Minified names** - Variable/function names are mangled (`j3`, `fD`, `qV`), so structural patterns like `function handleEdit($$)` won't match
2. **Find by strings** - The only reliable anchors are string literals like `"Edit"`, `"Read"`, `"Task"` which rg handles better
3. **Performance** - rg is ~10x faster for simple string searches on this file

**Tool choice:**
- **rg** - Fast discovery, find files/lines containing a string
- **inspect** - AST context, breadcrumbs showing parent chain, find definitions

Use `mise run native:pull latest` to extract clean formatted JS into `versions_clean/<version>/cli.js` for searching.

```bash
# rg: fast string search
rg '"Edit"' versions_clean/<version>/cli.js -n
rg 'name:\s*"Task"' versions_clean/<version>/cli.js -C2

# BAD: ast-grep patterns won't work with minified names
sg -p 'function handleEdit($$) { $$BODY }' cli.js  # Never matches
```

**inspect tool** - AST search with breadcrumbs, context, and node types:

```bash
# Search for string/identifier containing "agentType"
pnpm inspect search versions_clean/<version>/cli.js "agentType"

# Find variable/function DEFINITIONS only (-d)
pnpm inspect search versions_clean/<version>/cli.js "Edit" -d

# Exact match (-e), more context (-C 5), more results (-l 20)
pnpm inspect search versions_clean/<version>/cli.js "Task" -e -C 5 -l 20

# Filter by node type (-t)
pnpm inspect search versions_clean/<version>/cli.js "name" -t ObjectProperty

# View specific line range
pnpm inspect view versions_clean/<version>/cli.js 1000:1050
```

## Debugging

```bash
# Search strings in clean extracted JS (fast)
rg "pattern" versions_clean/<version>/cli.js -n

# Find variable definitions by pattern
rg "^var.*=.*\"MyString\"" versions_clean/<version>/cli.js
```

## Variable Name Mapping

Common tool/agent variable names (change between versions):

| Purpose | Example Vars | String Value |
|---------|--------------|--------------|
| Edit tool | `j3`, `fD` | `"Edit"` |
| Write tool | `FI` | `"Write"` |
| Read tool | `T3` | `"Read"` |
| Glob tool | `qV` | `"Glob"` |
| Grep tool | `OX` | `"Grep"` |
| Task tool | `n3` | `"Task"` |
| NotebookEdit | `lM` | `"NotebookEdit"` |
| claude-code-guide agent | `QCB`, `ln1` | `"claude-code-guide"` |

Always resolve by finding the string literal, not by variable name.

## Verification

Each patch includes a `verify` function that returns `true` on success or a descriptive failure message:

```typescript
verify: (code) => {
  if (!code.includes("expected string")) {
    return "Missing expected string";
  }
  if (code.includes("removed string")) {
    return "Old string still present";
  }
  return true;
},
```

The runner:
1. Runs all string patches
2. Parses AST
3. Runs all AST patches
4. Runs verify() on each patch
5. Collects tags from verified patches
6. Injects signature with all verified tags
7. Prints final output with failure reasons

Failed verifications display the reason and don't stop the process.
