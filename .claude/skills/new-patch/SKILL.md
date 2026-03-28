---
name: new-patch
description: Scaffold a new patch with implementation file, test file, metadata entry, and index export.
disable-model-invocation: true
---

# New Patch Scaffold

Create all files needed for a new patch. `$ARGUMENTS` should be the patch tag (e.g., `my-feature`).

If no tag is provided, ask the user for: tag name, one-line purpose, and which group it belongs to (Prompt, Tooling, Agent, System, UX, Metadata).

## Files to create

### 1. `src/patches/<tag>.ts`

Look at an existing patch in `src/patches/` for the pattern. The key structure:

- Import `traverse`, `@babel/types`, and `getVerifyAst` from `./ast-helpers.js`
- Export a `Patch` object with `tag`, `astPasses`, and `verify`
- `astPasses` returns an array of `{ pass: "mutate", visitor: {...} }` objects
- `verify` returns `true` or a failure reason string

### 2. `src/patches/<tag>.test.ts`

Create a test file using `node:test` and `node:assert`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { <patchExport> } from "./<tag>.js";

describe("<tag> patch", () => {
	it("has correct tag", () => {
		assert.equal(<patchExport>.tag, "<tag>");
	});

	it("verify passes on patched code", () => {
		// TODO: add verification test with sample code
	});
});
```

### 3. Update `src/patches/index.ts`

- Add import: `import { <patchExport> } from "./<tag>.js";`
- Add export: `export { <patchExport> } from "./<tag>.js";`
- Add `<patchExport>` to the `basePatches` or `allPatches` array

### 4. Update `src/patch-metadata.ts`

Add entry to `BY_TAG`:

```typescript
"<tag>": {
    tag: "<tag>",
    label: "<Label from purpose>",
    group: "<Group>",
},
```

## After scaffolding

Tell the user the files are ready and they should implement the `astPasses` visitor and `verify` function. Suggest looking at a similar existing patch for reference.
