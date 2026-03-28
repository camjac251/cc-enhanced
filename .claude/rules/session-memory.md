---
paths:
  - src/patches/session-mem.ts
  - src/patches/session-mem.test.ts
---

# Session Memory Controls

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
