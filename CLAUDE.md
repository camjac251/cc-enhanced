# Claude Code Patcher

A tool for patching the `claude-code` CLI to improve privacy, performance, and usability.

## Architecture

**AST-Pass-First Patching** prioritizes correctness, performance, and resilience:

1. **AST Pass Patches** (preferred) - Babel traversal for structural changes using a unified
   combined-pass engine. All patches are executed in a single optimized lifecycle
   (`discover` → `mutate` → `finalize`).
2. **String Patches** (prompt-only) - Only for replacing large prompt text blocks where AST adds no value.
3. **Co-located Verification** - Each patch includes its own `verify` function, preferably AST-based.
4. **Descriptive UX** - All CLI logs, spinners, and summaries use descriptive UI labels from
   metadata instead of technical tags.

AST pass patches are required for any logic/structure changes. String patches are only acceptable for
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
│   ├── bun-format.ts     # Shared Bun binary format primitives
│   ├── inspector.ts      # AST search tool with breadcrumbs
│   ├── diff.ts           # Diff viewer for comparing versions
│   ├── native.ts         # Native binary extraction/repack (ELF + Mach-O/PE via node-lief)
│   ├── native-linux.ts   # Linux ELF-specific Bun overlay logic
│   ├── native-release.ts # Official release bucket fetch + caching
│   ├── promote.ts        # Promote/rollback/status lifecycle management
│   ├── version-paths.ts  # Shared path constants for symlink management
│   ├── installation-detection.ts # Installed target auto-detection
│   ├── patch-metadata.ts # Patch grouping, labels, and summary builder
│   ├── types.ts          # Patch interface, PatchResult
│   ├── patches/          # Individual patches (25 active tags + helpers + index)
│   │   ├── index.ts      # Exports allPatches array
│   │   ├── ast-helpers.ts # Shared AST traversal utilities
│   │   └── *.ts          # Individual patch implementations
│   └── templates/
│       └── edit_hook.js  # Injected Edit tool logic
├── scripts/              # Auxiliary shell/TS scripts
│   ├── export-prompts.ts          # AST-based prompt corpus extractor
│   ├── export-prompts-current.ts  # Unpack promoted binary and export prompts
│   └── verify-patches-matrix.sh   # Multi-target patch verification
├── src/verification/
│   ├── anchor-types.ts            # Typed anchor verification result model
│   └── verify-cli-anchors.ts      # Compare patched vs clean anchor invariants
├── src/prompt-corpus.ts   # Prompt filtering, dataset/hash generation
├── versions_clean/       # Output: clean formatted JS from native binaries (gitignored)
│   └── <version>/cli.js
├── exported-prompts/     # Output: extracted prompt artifacts per version (gitignored)
│   └── <version>_patched/
├── mise.toml             # Task runner configuration
└── biome.json            # Linter/formatter configuration
```

## Output Directories

- **versions_clean/** - Clean formatted JS extracted from native binaries (for diffing)
- **exported-prompts/** - Extracted prompt artifacts (agents, tools, system sections, corpus)
- **~/.claude-patcher/native-cache/** - Cached native binaries fetched from official release bucket
- **~/.claude-patcher/backups/** - Automatic default backup location for native backup/restore

`versions_clean/` and `exported-prompts/` are gitignored.

## Patch Interface

Each patch is self-contained and adheres to the following interface:

```typescript
interface Patch {
  tag: string;                              // Unique identifier, e.g., "bash-prompt"
  string?: (code: string) => string;        // String transformation (runs first)
  astPasses?: (ast: t.File) => PatchAstPass[] | Promise<PatchAstPass[]>; // Combined AST pass registration
  postApply?: (ast: t.File, appliedTags: string[]) => void | Promise<void>;  // Post-verification hook (signature)
  verify: (code: string, ast?: t.File) => true | string;  // Returns true or failure reason
}
```

Runtime contract: AST execution is driven exclusively by `astPasses` (the unified pass engine).
Individual `ast()` hooks are deprecated and removed. All AST transformations must yield visitor
objects for the `discover`, `mutate`, or `finalize` phases.

## Patches Overview

Current patch set is 26 active patches, grouped by metadata in `src/patch-metadata.ts`.

### Prompt

| Tag | Purpose |
|-----|---------|
| `bash-prompt` | Bash tool prompt improvements |
| `built-in-agent-prompt` | Rewrite built-in Explore/Plan prompts in place |
| `prompt-rewrite` | Neutral cleanup for stale Glob/Grep/Task prompt references |
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
| `effort-max` | Enable interactive max effort and align effort UI |
| `no-autoupdate` | Disable auto-updater |
| `session-mem` | Session memory env/threshold controls + coral-fern guard hardening |
| `sys-prompt-file` | System prompt file injection via local file |
| `flag-bypass` | Feature flag bypass (effort, agent teams, write guard) |
| `limits` | Raise file read limits (see Token Pipeline below) |

### UX

| Tag | Purpose |
|-----|---------|
| `memory-write-ui` | Memory write rendering behavior |
| `plan-diff-ui` | Normalize plan file UI labels and show Edit/Write diffs |
| `no-collapse` | Disable tool output collapse |
| `subagent-model-tag` | Hide Task subagent model tag when subagent model is globally pinned |

### Metadata

| Tag | Purpose |
|-----|---------|
| `signature` | Inject patch signature into version/UI strings |

## Native Alternatives (2.1.0+)

Some patches have native alternatives in recent versions:

| Patch | Native Alternative |
|-------|-------------------|
| `limits.ts` | `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` env var covers token budget only (not byte ceiling, persistence cap, or maxResultSizeChars) |
| `tools-off.ts` | Use `--tools` CLI flag to restrict tools |
| `agents-off.ts` | Use `Task(AgentName)` syntax in settings.json permissions |
| ~~`allowed-tools-prompt.ts`~~ | Prompt removed upstream in 2.1.0 (patch removed) |
| ~~`chrome-wsl.ts`~~ | Fixed upstream in 2.1.1 (patch removed) |

## Read Tool Token Pipeline

The Read tool has a multi-gate pipeline that limits what reaches the API. The `limits` patch
raises key hard caps (byte ceiling, token budget, maxResultSizeChars) while keeping persistence as
a safety net so oversized formatted reads are persisted instead of staying inline in context.

| Gate | What | Default | Patched | Unit |
|------|------|---------|---------|------|
| Byte ceiling | File size pre-check (no range only) | 256 KB | 1 MB | bytes |
| Token budget (`rtI`) | API token count after read | 25,000 | 50,000 | tokens |
| Line formatting (`OV$`) | Adds line numbers (7 chars/line) | -- | -- | overhead |
| Persistence (`BdI`) | Replaces oversized results with disk summary | 50,000 | 120,000 | chars |
| Read `maxResultSizeChars` | Per-tool cap fed into persistence | 100,000 | 250,000 | chars |

The effective persistence limit is `Math.min(maxResultSizeChars, ZPA)`. Before patching,
this was `min(100K, 50K) = 50K chars` (~12K tokens) -- far tighter than the token budget.
After patching, it is `min(250K, 120K) = 120K chars` (~30K tokens), so the token budget
still governs read success while persistence prevents very large formatted output from bloating
active context.

Notes:
- `lineChars` (per-line char truncation) is prompt-only fiction -- no runtime enforcement exists upstream.
- `linesCap` is only used in the context-attachment fallback path, not normal reads.
- `read-bat` only auto-tails by default for `*.output` files; other text files can still be read in full when `range` is omitted.
- `read-bat` caps changed-file reminder snippets to a head+tail summary at 8,000 chars per file.
- The `read-bat` fallback logic passes range-derived `offset/limit` into the stock reader and
  propagates `maxSizeBytes` only for unbounded fallback reads (`limit === void 0`), matching
  stock bounded-read semantics while preserving range behavior when `bat` is unavailable.

## Session Memory Controls

`session-mem` extends upstream session memory with explicit env overrides and AST-verified guard
hardening.

| Area | Upstream | Patched behavior |
|------|----------|------------------|
| Extraction enable | `tengu_session_memory` | `ENABLE_SESSION_MEMORY || tengu_session_memory` |
| Past-context prompt inclusion | `tengu_coral_fern` | `ENABLE_SESSION_MEMORY_PAST || tengu_coral_fern` |
| Legacy negative coral-fern guard | `if (!gate) return null/[]` | Rewritten to respect `ENABLE_SESSION_MEMORY_PAST` |
| Section cap | fixed `2000` | `CC_SM_PER_SECTION_TOKENS` (default `2000`) |
| Total file cap | fixed `12000` | `CC_SM_TOTAL_FILE_LIMIT` (fallback `CM_SM_TOTAL_FILE_LIMIT`, default `12000`) |
| Extraction thresholds | fixed `10000/5000/3` | `CC_SM_MINIMUM_MESSAGE_TOKENS_TO_INIT`, `CC_SM_MINIMUM_TOKENS_BETWEEN_UPDATE`, `CC_SM_TOOL_CALLS_BETWEEN_UPDATES` |

Notes:
- Compaction toggle remains upstream-native (`ENABLE_CLAUDE_CODE_SM_COMPACT` / `DISABLE_CLAUDE_CODE_SM_COMPACT`).
- `session-mem` verification is AST-based and covered by `src/patches/session-mem.test.ts`.

## Commands

### CLI Options

```bash
pnpm cli [options]

# Build lifecycle (most common)
  --update              Fetch + patch + promote in one command (default: latest)
  --status              Show current/previous/cached version status
  --promote <path>      Promote a patched binary to active launcher
  --rollback            Roll back to previous promoted binary
  --rollback-target <p> Explicit binary path to roll back to
  --skip-smoke-test     Skip post-promote --version check
  --fast-verify         Skip duplicate per-patch verifier pass during update-time anchor checks (opt-in)

# Patching
  --no-patch            Skip patching (format only)
  --dry-run             Preview without writing
  --force               Force patching even if target is already patched
  --diff                Show diff of changes
  --list                List available patches (grouped with type indicators)
  --summary-path <file> Write JSON summary to file
  --target <path>       Patch a local target path (cli.js or native claude binary)
  --detect-target       Auto-detect installed claude path from PATH and patch it
  --output <path>       Output path for --target mode (default: patch target in-place)

# Native binary operations
  --native-fetch <spec> Fetch official native binary (latest|stable|X.Y.Z)
  --native-fetch-only   Fetch to cache and exit without patching
  --native-platform     Override platform (linux-x64, darwin-arm64, windows-x64, etc.)
  --native-cache-dir    Override cache directory
  --native-force-download Force re-download even if cached
  --backup-only         Create backup of target and exit
  --restore             Restore target from backup and exit
  --backup-path <file>  Explicit backup file path
  --backup-dir <dir>    Backup root directory (default: ~/.claude-patcher/backups)
  --unpack <file>       Extract embedded JS from native target
  --repack <file>       Repack JS file into native target

Environment variables:
  CLAUDE_PATCHER_INCLUDE_TAGS=a,b  Only run these patches (comma-separated tags)
  CLAUDE_PATCHER_EXCLUDE_TAGS=a,b  Skip these patches (comma-separated tags)
  CLAUDE_PATCHER_CACHE_KEEP=N      Keep N most recent cached versions (default: 2)
  CLAUDE_PATCHER_FETCH_TIMEOUT_MS=N     Timeout for manifest/channel fetch requests (default: 30000)
  CLAUDE_PATCHER_DOWNLOAD_TIMEOUT_MS=N  Timeout for native binary downloads (default: 180000)
  CLAUDE_PATCHER_REVISION=<sha>    Override patcher revision string used in patched-build cache keys

Default behavior: `pnpm cli` auto-detects the installed target and patches it.
Project policy: use `--update` for the standard flow, not detect-target/in-place patching.
```

### Mise Tasks

```bash
# Update (one command for the common case)
mise run native:update            # Fetch latest + patch + promote
mise run native:update 2.1.56     # Fetch specific version
mise run native:update --force    # Force re-download
mise run native:update --dry-run  # Fetch + patch preview only (no promote)
mise run native:update --summary /tmp/update.json  # Write update JSON summary
mise run status                   # Show current/previous/cached versions

# Build lifecycle (granular)
mise run native:fetch-patch latest # Fetch + patch without promoting
mise run native:promote <build>   # Promote a specific patched build
mise run native:rollback          # Roll back to previous promoted binary
mise run native:fetch latest      # Download into cache only
mise run native:pull latest        # Extract clean formatted JS (for diffing)

# Binary operations
mise run patch:target /path/to/claude   # Patch explicit binary (-> <target>.patched)
mise run native:backup /path/to/claude  # Backup binary
mise run native:restore /path/to/claude # Restore from backup
mise run native:unpack /path/to/claude /tmp/claude.js # Extract JS
mise run native:repack /path/to/claude /tmp/claude.js # Repack JS
mise run list                     # List available patches

# Prompt extraction
mise run prompts:export           # Extract prompts from promoted (patched) binary
mise run prompts:export 2.1.71    # Extract from clean version in versions_clean/
pnpm prompts:export               # Same via pnpm
pnpm prompts:export 2.1.71        # Same, clean version

# Inspection (for patch development)
mise run inspect <file> <query>   # AST search with breadcrumbs
mise run inspect <file> <q> -d    # Definitions only
mise run inspect:view <file> <range>  # View line range
mise run diff <original> <patched>    # Structural AST diff

# Development
mise run typecheck                # TypeScript type checking
mise run lint                     # Lint source files
mise run lint:fix                 # Auto-fix lint and format issues
mise run format                   # Format source files
mise run clean                    # Remove output directories
mise run verify:patches           # Full health check (typecheck + lint + dry-runs)
mise run verify:anchors <patched> <clean>  # Compare anchor strings
mise run verify:cache --dry-run   # Cache benchmark plan (no API call)
ANTHROPIC_API_KEY=... mise run verify:cache --output-json /tmp/cache-report.json --output-csv /tmp/cache-report.csv  # Live cache benchmark
```

### Patching Runbook

```bash
# Standard update (one command)
mise run native:update

# Verify
claude --version
mise run status

# Roll back if needed
mise run native:rollback

# Granular flow (when you need control)
mise run native:fetch-patch latest
mise run native:promote ~/.claude-patcher/native-cache/<version>/linux-x64/builds/<timestamp>-claude

# Full health check
mise run verify:patches
mise run verify:cache --dry-run
ANTHROPIC_API_KEY=... mise run verify:cache --output-json /tmp/cache-report.json --output-csv /tmp/cache-report.csv

# Override dry-run targets if needed
CLI_TARGET=/path/to/cli.js \
NATIVE_TARGET=/path/to/claude \
mise run verify:patches

# Extract prompts after update
mise run prompts:export
```

Notes:
- `--update` is the standard flow: fetches latest, patches, promotes, runs smoke test.
- `--update --dry-run` fetches and patches only (no promote/rollback mutation).
- `--update` fails closed before promote if patching reports failed verification tags.
- `--update` now reuses compatible patched builds from cache when clean binary hash + selected patch tags + patcher revision match.
- `--fast-verify` is opt-in; default update verification still runs full anchor checks with per-patch verifier pass.
- `--force` on fetch commands forces re-download. Only needed when re-patching the same version after code changes.
- Promotion uses atomic symlinks: `~/.local/bin/claude -> versions/current -> <patched binary>`.
- Rollback swaps current/previous symmetrically (double rollback returns to original).
- Promoted/previous versions are protected from cache eviction.
- `verify:patches` auto-detects the native target from the promoted binary's cache directory.
- `verify:cache` is live by default (uses Anthropic API + billing); use `--dry-run` for non-network planning-only checks.
- Cache-policy gate evaluates three dimensions: cost regression threshold (`--max-cost-regression-pct`), cache-read delta (`--min-cache-read-delta`), and breakpoint overflow (`--max-breakpoints` with fail-on-overflow).
- Live cache runs fail as inconclusive when both policies report zero cache creation/read tokens (prompt caching did not engage).
- Linux ELF native support is built-in. macOS/Windows uses optional `node-lief`.

### Runtime Launch Chain

The patched binary is invoked directly through a symlink chain managed by promote:

```
claude (resolved via PATH)
  → ~/.local/bin/claude (symlink)
    → ~/.local/share/claude/versions/current (symlink, atomic swap point)
      → ~/.claude-patcher/native-cache/<version>/<platform>/builds/<ts>-claude
```

Model defaults are correct for first-party (direct Anthropic API) users without any env
overrides. Subagent pinning uses `CLAUDE_CODE_SUBAGENT_MODEL` in settings.json env block.
For sonnet override: `ANTHROPIC_MODEL=claude-sonnet-4-6 claude` (or alias).

To deploy to another machine: copy the patched binary, put it in PATH. Model defaults
are built into the binary for first-party users.

## Feature Flags and Analytics

The nonessential traffic check returns true if `DISABLE_TELEMETRY` or
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set. When true, the feature flag fetcher is
disabled and ALL server flags return defaults (usually false). This kills effort, agent teams,
context management, and other server-gated features.

**Do not use broad disable vars.** Instead use individual `DISABLE_*` vars (`ERROR_REPORTING`,
`AUTOUPDATER`, `BUG_COMMAND`) that don't trigger the nonessential traffic check. The Segment
analytics SDK was removed upstream in 2.1.83.

## Adding Patches

1. Create patch file in `src/patches/`
2. Export from `src/patches/index.ts`
3. Add to `allPatches` array in `src/patches/index.ts`

That's it! No more updating types.ts, signature.ts, or manager.ts.

When adding/removing patches, keep these in sync:
- `src/patches/index.ts` — allPatches array and exports
- `src/patch-metadata.ts` — BY_TAG record (label, group)
- Patches Overview tables above

### Patch Template

```typescript
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { Patch } from "../types.js";
import { getVerifyAst } from "./ast-helpers.js";

const runMyPatch = (ast: t.File) => {
  traverse.default(ast, {
    StringLiteral(path) {
      // Find by structure, not variable names
      if (path.node.value === "target") {
        path.node.value = "replacement";
      }
    },
  });
};

export const myPatch: Patch = {
  tag: "my-patch",

  // Optional: string transformation (ONLY for prompt text replacement)
  // string: (code) => code.replace("old prompt", "new prompt"),

  // Combined-pass registration (execution path)
  astPasses: (ast) => [
    {
      pass: "mutate",
      visitor: {
        Program: {
          exit() {
            runMyPatch(ast);
          },
        },
      },
    },
  ],

  // Required: verification (returns true or failure reason)
  verify: (code, ast) => {
    const verifyAst = getVerifyAst(code, ast);
    if (!verifyAst) return "Unable to parse AST during verification";
    
    // Check for invariants in the AST
    // if (!hasRequiredStructure(verifyAst)) return "Missing expected result";
    
    return true;
  },
};
```

## Key Principles

- **Never hardcode minified variable names** - they change between versions
- **Find by structure** - look for unique patterns (string literals, property names)
- **Resolve variables** - follow bindings to find actual string values
- **Co-locate verification** - each patch verifies its own success
- **AST passes for all logic** - use Babel traversal + `astPasses` for any structural/behavioral change
- **String patches for prompts only** - only use string type for replacing tool description text
- **Prompt policy authority lives outside patches** - global policy belongs in `/etc/claude-code/CLAUDE.md` and `~/.claude/system-prompt.md`; patch prompt edits should stay behavior-specific and compatibility-focused
- **Future-forward patching only** - target the latest supported upstream version and avoid adding backward-compatibility fallbacks for older prompt/runtime shapes

## Prompt Extraction

`scripts/export-prompts.ts` performs AST-based extraction of all prompt text from cli.js.
`scripts/export-prompts-current.ts` wraps it to unpack the promoted (patched) binary first.

### Output Structure

```
exported-prompts/<version>_patched/
├── agents/                  # Per-agent markdown + agents.json
├── system/
│   ├── sections/            # Per-section markdown + sections.json
│   ├── variants/            # System prompt variants markdown
│   ├── builder-outline.md   # Assembly order of the system prompt
│   └── system-prompts.json
├── tools/
│   ├── builtin/             # Per-tool markdown (prompt + description)
│   └── schemas/             # Schema-only tools (browser automation, etc.)
├── tools.json               # All tools with prompt/description/schema flags
├── output-styles.json       # Built-in output style definitions
├── prompt-corpus.json       # Full corpus with text, pieces, identifiers
├── prompts-<version>.json   # Dataset with stable IDs and hash-safe decomposition
├── prompt-hash-index.json   # SHA-256 hashes for drift detection
├── runtime-symbol-map.json  # Minified symbol -> descriptive alias
└── manifest.json            # Counts and file listing
```

### Extraction Capabilities

| Category | Coverage | Notes |
|----------|----------|-------|
| Built-in agents | 5/5 | Follows function refs, resolves local vars, handles `.trim()` |
| Tool prompts | 30/34 | 3 genuinely dynamic (Agent, EnterPlanMode, Skill), 1 empty (mcp) |
| Schema-only tools | 20/20 | Browser automation + internal classifiers |
| System prompt variants | 10 | Main, simple mode, SDK, agent base, guide, preamble |
| System sections | 16 | All major prompt sections with snippet collections |
| Output styles | 2/2 | Explanatory, Learning |
| Prompt corpus | 250+ | Stable IDs, SHA-256 hashes, piece/identifier decomposition |

### Key Techniques

The extractor handles minified cli.js patterns that naive string extraction misses:

- **Function reference resolution**: `getSystemPrompt: fnRef` -> follows through `functionBindings`
- **Local variable scoping**: Temporarily injects local `let`/`var`/`const` bindings to prevent
  minified name collisions from global string bindings
- **Template expression inlining**: `\`${fn()}\`` -> follows zero-arg calls inside template literals
- **Method chain handling**: `\`...\`.trim()` -> resolves the template, applies the method
- **Binary concatenation**: `basePrompt + appendix` -> resolves both sides
- **Agent type validation**: Filters template interpolation artifacts (`${...}`) as false positives

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
verify: (code, ast) => {
  const verifyAst = getVerifyAst(code, ast);
  if (!verifyAst) return "Unable to parse AST during verification";

  // Prefer AST invariants over string matching
  if (!hasRequiredStructure(verifyAst)) {
    return "Missing required AST structure";
  }
  return true;
},
```

Guideline: prefer AST-based verification for behavior/logic patches. Use string-based checks only
for prompt/text replacement patches where AST structure adds no value. Always use the 
`getVerifyAst(code, ast)` helper from `ast-helpers.ts` to ensure consistent error handling
and fallback parsing.

The runner:
1. Runs all string patches
2. Parses AST
3. Registers each patch's `astPasses`
4. Runs combined AST passes (`discover`/`mutate`/`finalize`) with per-patch error isolation
5. Prints AST to code
6. Runs `verify()` on each patch, collects applied/failed tags (using descriptive UI labels)
7. Calls `signature.postApply(ast, appliedTags)` to inject signature
8. Prints final output with failure reasons (identifying patches by label)

## Verifier Robustness

Verifier logic must be resilient to upstream shape drift while still catching real regressions.

- Verify behavior/invariants, not exact minified expression shape (`&&` vs `||`, nesting form, helper-local variable names).
- Never use generic minified identifier-name heuristics (for example bare `$` argument checks) as a failure signal.
- Support both legacy and current schema layouts when upstream may switch forms (for example `input_schema` property and `get inputSchema()` getter paths).
- Keep mutation and verification consistent: a verifier must not reject constructs intentionally injected by the same patch.
- Prefer semantic checks for prohibited behavior (for example actual file I/O calls) over proxy checks (for example path-resolution helper presence).
- When a verifier fails against latest clean upstream, first validate whether it is a verifier false positive before changing patch mutation logic.

## Testing Philosophy

`cli.js` is upstream-owned and minified. Tests should focus on patcher correctness and drift detection,
not on brittle minified internals.

- Keep deterministic tests for runner invariants, combined pass semantics, and patch `verify()` behavior.
- Use `verify:anchors` and forced update runs as the primary integration signal against real upstream binaries.
- Do not rely on minified variable-name snapshots; anchor on structure and stable literals.
