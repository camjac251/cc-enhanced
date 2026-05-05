---
paths:
  - src/patches/session-mem.ts
  - src/patches/session-mem.test.ts
---

# Session Memory Controls

`session-mem` extends the past-context memory search prompt with an explicit env override
and AST-verified guard hardening.

| Area | Upstream | Patched behavior |
|------|----------|------------------|
| Past-context prompt inclusion | `tengu_coral_fern` | `ENABLE_SESSION_MEMORY_PAST || tengu_coral_fern` |
| Legacy negative coral-fern guard | `if (!gate) return null/[]` | Rewritten to respect `ENABLE_SESSION_MEMORY_PAST` |

Notes:
- `session-mem` verification is AST-based and covered by `src/patches/session-mem.test.ts`.
