# Claude Code Patcher

A tool for patching the `claude-code` CLI to improve privacy, performance, and usability.

## Architecture

**Hybrid Patching** balances performance and safety:

1. **String Rules** - Fast regex replacements, run before AST parsing (~15MB minified file)
2. **AST Rules** - Complex logic via Babel traversal for structural changes

String rules are preferred when possible (faster), AST rules when structure matters.

## Project Structure

```
src/
├── index.ts          # CLI entry point
├── manager.ts        # Orchestrates download → format → patch → verify
├── downloader.ts     # NPM registry + tarball caching
├── normalizer.ts     # Prettier formatting
├── patch-runner.ts   # Executes string + AST rules
├── verify-patch.ts   # Post-patch validation
├── types.ts          # PatchReport interface, report keys
├── patches/          # Individual patch rules
│   ├── index.ts      # Exports all patches
│   └── *.ts          # Individual patches
└── templates/
    └── edit_hook.js  # Injected Edit tool logic
```

## Patches Overview

### Tool Modifications

| Patch | Type | Purpose |
|-------|------|---------|
| `disable-tools.ts` | AST | Disables Glob, Grep, WebSearch, WebFetch, NotebookEdit globally |
| `restrict-file-read.ts` | AST | Limits Read tool to images/PDFs only |
| `edit-tool.ts` | AST | Extends Edit with line insert, range, diff, batch modes |
| `shrink-write-result.ts` | AST | Reduces Write tool output verbosity |

### Agent Modifications

| Patch | Type | Purpose |
|-------|------|---------|
| `agent-tools.ts` | AST | Disables statusline-setup agent; converts claude-code-guide from whitelist to blocklist |

**Built-in Agents** (in `cli.js`):
- `general-purpose` (JX1): `tools: ["*"]` - all tools
- `statusline-setup` (Ty2): disabled via `isEnabled: false`
- `Explore` (LL): `disallowedTools: [Task, ExitPlanMode, Edit, Write, NotebookEdit]`
- `Plan` (SHA): inherits from Explore
- `claude-code-guide` (QCB): `disallowedTools: [Write, Edit, NotebookEdit]` (was whitelist)

### Prompt Modifications

| Patch | Type | Purpose |
|-------|------|---------|
| `bash-prompt.ts` | String | Condenses Bash tool description, adds tool preferences |
| `tool-policy.ts` | AST | Softens Glob/Grep recommendations → ast-grep/rg |
| `read-write.ts` | AST | Relaxes "must read before write" guard |
| `todo.ts` | AST | Trims verbose todo examples |
| `remove-glob-grep-refs.ts` | String | Removes stale Glob/Grep references |
| `task-tool-prompt.ts` | String | Fixes Task tool examples |
| `skill-allowed-tools.ts` | String+AST | Removes disabled tools from skill configs |

### Limits

| Patch | Type | Purpose |
|-------|------|---------|
| `limits.ts` | AST | Bumps read limits (5000 lines, 1MB), adds env override |

### Metadata

| Patch | Type | Purpose |
|-------|------|---------|
| `signature.ts` | AST | Injects patch signature into version string |
| `definitions.ts` | File | Updates sdk-tools.d.ts with extended Edit types |

## Commands

```bash
# Patch latest version
mise run patch

# Patch specific version
mise run patch:version version=2.0.76

# Preview without writing
pnpm cli --dry-run

# Show diff of changes
pnpm cli --diff

# Skip formatting (faster)
pnpm cli --skip-format

# Inspect AST for a string
mise run inspect version=2.0.76 query="searchTerm"

# Verify patches applied
mise run verify version=2.0.76

# Compare patched vs clean
mise run diff version=2.0.76

# Type check
mise run typecheck
```

## Adding Patches

1. Create rule in `src/patches/`
2. Export from `src/patches/index.ts`
3. Register in `src/manager.ts` (`configureRunner()`)
4. Add report key to `src/types.ts` (interface + initialReport)
5. Add signature tag in `src/patches/signature.ts`

### String Rule Template

```typescript
import type { PatchContext } from "../types.js";

const TRIGGER_PHRASE = "unique string to match";

export function myPatchString(code: string, ctx: PatchContext): string {
  if (!code.includes(TRIGGER_PHRASE)) return code;

  let result = code.replace("old", "new");
  if (result !== code) {
    ctx.report.my_patch_applied = true;
  }
  return result;
}
```

### AST Rule Template

```typescript
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { PatchContext } from "../types.js";

export function myPatch(ast: any, ctx: PatchContext) {
  traverse.default(ast, {
    ObjectExpression(path: any) {
      // Find by structure, not variable names
      const nameProp = path.node.properties.find(
        (p: any) => t.isObjectProperty(p) &&
                    t.isIdentifier(p.key, { name: "name" })
      );
      // ... modify AST
      ctx.report.my_patch_applied = true;
    },
  });
}
```

## Key Principles

- **Never hardcode minified variable names** - they change between versions
- **Find by structure** - look for unique patterns (string literals, property names)
- **Resolve variables** - follow bindings to find actual string values
- **Test with `--skip-format`** - faster iteration during development
- **Add verification** - ensure patches apply correctly

## Debugging

```bash
# Search strings in patched file
rg "pattern" versions/2.0.76/package/cli.js -n

# Find variable definitions
rg "^var.*=.*\"MyString\"" versions/2.0.76/package/cli.js

# Inspect AST around a string
mise run inspect version=2.0.76 query="agentType"

# Compare before/after
mise run diff version=2.0.76
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

## Report Keys

Each patch sets flags in `ctx.report` for verification and signature:

```typescript
// Types defined in src/types.ts
tools_disabled: boolean;
agents_disabled: boolean;
claude_guide_blocklist: boolean;
edit_tool_extended: boolean;
// ... etc
```

Signature tags are collected in `signature.ts` and injected into the version string.
