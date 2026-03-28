---
paths:
  - src/patches/limits.ts
  - src/patches/read-bat.ts
  - src/patches/limits.test.ts
  - src/patches/read-bat.test.ts
---

# Read Tool Token Pipeline

The Read tool has a multi-gate pipeline that limits what reaches the API. The `limits` patch
raises key hard caps (byte ceiling, token budget, maxResultSizeChars) while keeping persistence as
a safety net so oversized formatted reads are persisted instead of staying inline in context.

| Gate | What | Default | Patched | Unit |
|------|------|---------|---------|------|
| Byte ceiling | File size pre-check (no range only) | 256 KB | 1 MB | bytes |
| Token budget | API token count after read | 25,000 | 50,000 | tokens |
| Line formatting | Adds line numbers (7 chars/line) | -- | -- | overhead |
| Persistence | Replaces oversized results with disk summary | 50,000 | 120,000 | chars |
| Read `maxResultSizeChars` | Per-tool cap fed into persistence | 100,000 | 250,000 | chars |

The effective persistence limit is `Math.min(maxResultSizeChars, persistenceThreshold)`. Before patching,
this was `min(100K, 50K) = 50K chars` (~12K tokens), far tighter than the token budget.
After patching, it is `min(250K, 120K) = 120K chars` (~30K tokens), so the token budget
still governs read success while persistence prevents very large formatted output from bloating
active context.

Notes:
- `lineChars` (per-line char truncation) is prompt-only fiction. No runtime enforcement exists upstream.
- `linesCap` is only used in the context-attachment fallback path, not normal reads.
- `read-bat` only auto-tails by default for `*.output` files; other text files can still be read in full when `range` is omitted.
- `read-bat` caps changed-file reminder snippets to a head+tail summary at 8,000 chars per file.
- The `read-bat` fallback logic passes range-derived `offset/limit` into the stock reader and
  propagates `maxSizeBytes` only for unbounded fallback reads (`limit === void 0`), matching
  stock bounded-read semantics while preserving range behavior when `bat` is unavailable.
