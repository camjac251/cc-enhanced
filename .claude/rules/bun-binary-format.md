---
paths:
  - src/native-linux.ts
  - src/bun-format.ts
  - src/native.ts
---

# Bun Standalone Binary Format (Linux ELF)

Bun 1.3+ (used since claude-code 2.1.83) changed how standalone binaries embed and discover
modules. The repack strategy must match the format version.

**Bun 1.3+ format** (current):
- A `.bun` ELF section holds `BUN_COMPILED.size`, a virtual address pointing to appended data
- `PT_GNU_STACK` is repurposed as a `PT_LOAD` segment mapping the appended data into memory
- Payload format: `[u64 payload_len][module data][offsets (32 bytes)][trailer]`
- Runtime reads vaddr from `.bun` section, dereferences directly (no file I/O)
- Section headers are relocated after the payload; `e_shoff` updated accordingly

**Repack strategy** (in-place patching):
- The cli.js module has ~105MB of pre-compiled bytecode in the data section
- Patched JS (~16MB formatted) is written directly over the bytecode area
- Module content pointer is updated; bytecode pointer is zeroed
- No overlay rebuild, no size changes, no ELF structure modifications
- Binary stays exactly the same size; all vaddrs and mappings remain valid

**Why not append-and-rebuild**: Rebuilding the overlay changes `byteCount`, the payload length
header, and the data section boundaries. The `BUN_COMPILED.size` vaddr and `PT_LOAD` mapping
would need updating to match, along with the `.bun` section offset. In-place patching avoids
all of this by keeping the original binary structure intact.
