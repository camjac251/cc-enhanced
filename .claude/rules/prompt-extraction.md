---
paths:
  - scripts/export-prompts.ts
  - scripts/export-prompts-current.ts
  - src/prompt-corpus.ts
  - src/prompt-corpus.test.ts
---

# Prompt Extraction

`scripts/export-prompts.ts` performs AST-based extraction of all prompt text from cli.js.
`scripts/export-prompts-current.ts` wraps it to unpack the promoted (patched) binary first.

## Output Structure

```
exported-prompts/<version>/
├── agents/                  # Per-agent markdown + agents.json
├── skills/                  # Per-skill markdown + skills.json (17 prompt-type skills)
├── system/
│   ├── sections/            # Per-section markdown + sections.json
│   ├── variants/            # System prompt variants markdown
│   ├── reminders/           # Per-reminder markdown + reminders.json
│   ├── builder-outline.md   # Assembly order of the system prompt
│   └── system-prompts.json
├── tools/
│   ├── builtin/             # Per-tool markdown (prompt + description)
│   ├── schemas/             # Schema-only tools (browser automation, etc.)
│   └── sections/            # Per-tool sub-section decomposition by heading
├── internal-agents/         # Internal model call prompts (compaction, memory, security, etc.)
├── tools.json               # All tools with prompt/description/schema flags
├── skills.json              # All skills with metadata + resolved prompt text
├── output-styles.json       # Built-in output style definitions
├── corpus-categorized.json  # Full corpus with category + attribution tags
├── corpus-summary.json      # Category distribution breakdown
├── data-references.json     # Embedded SDK/API reference docs
├── prompt-corpus.json       # Full corpus with text, pieces, identifiers
├── prompts-<version>.json   # Dataset with stable IDs and hash-safe decomposition
├── prompt-hash-index.json   # SHA-256 hashes for drift detection
├── runtime-symbol-map.json  # Internal symbol -> descriptive alias
└── manifest.json            # Counts and file listing
```

## Extraction Capabilities

| Category | Coverage | Notes |
|----------|----------|-------|
| Built-in agents | 5/5 | Follows function refs, resolves local vars, handles `.trim()` |
| Skills | 17/17 | Registered, builtin, marketplace-preview |
| Tool prompts | 36 | 3 genuinely dynamic (Agent, EnterPlanMode, Skill), 1 empty (mcp) |
| Tool sub-sections | 12 tools | Heading-based decomposition of large tool prompts |
| Schema-only tools | 20/20 | Browser automation + internal classifiers |
| System prompt variants | 10 | Main, simple mode, SDK, agent base, guide, preamble |
| System sections | 18 | All major prompt sections with snippet collections |
| System reminders | 16 | `<system-reminder>` templates + wrapper calls |
| Internal agent prompts | 24+ | Compaction, session memory, security monitor, title gen, etc. |
| Data references | 26+ | Embedded SDK/API docs (Python, TS, Go, Java, etc.) |
| Output styles | 2/2 | Explanatory, Learning |
| Prompt corpus | 315 | Stable IDs, SHA-256 hashes, 69% auto-categorized |

## Key Techniques

The extractor handles cli.js patterns that naive string extraction misses:

- **Function reference resolution**: `getSystemPrompt: fnRef` -> follows through `functionBindings`
- **Local variable scoping**: Temporarily injects local `let`/`var`/`const` bindings to prevent
  name collisions from global string bindings
- **Template expression inlining**: `\`${fn()}\`` -> follows zero-arg calls inside template literals
- **Method chain handling**: `\`...\`.trim()` -> resolves the template, applies the method
- **Binary concatenation**: `basePrompt + appendix` -> resolves both sides
- **Agent type validation**: Filters template interpolation artifacts (`${...}`) as false positives
