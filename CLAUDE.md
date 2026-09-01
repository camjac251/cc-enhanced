# cc-enhanced

AST-based patcher for the latest Claude Code CLI. It extracts the JavaScript bundle embedded in the native binary, applies verifiable patches, and repacks the bundle in place. The README badge is the version anchor; the promoted binary's `claude --version` output is the runtime check.

## Hard rules

These are loaded up front because violating one can corrupt a build, invalidate verification, or reintroduce update-time memory failures.

- Target only the latest upstream version. Never add compatibility fallbacks for older upstream forms.
- Use the immediately previous clean bundle only as a release-diff baseline. Patch matching, tests, matrix selection, and promotion target the latest bundle only.
- Never hardcode minified variable names. Match stable literals, property names, and surrounding AST structure.
- Never use `ast-grep` on `cli.js`. Use `rg` for exact literals and `bun run inspect search` for parsed context with breadcrumbs.
- Never copy `/etc/claude-code/*` verbatim into bundle patches. Runtime policy stays managed; bundle wording is distilled through `src/patches/prompt-policy.ts`.
- Never expose upstream internals such as minified identifiers, reconstructed module names, or source names in comments, docs, logs, memory, or diff configuration. Describe behavior.
- Prefer AST passes. Use string patches only for prompt text where an AST transform adds no value.
- Co-locate each patch's `verify` function. Prefer AST verification through `getVerifyAst()`.
- Run `mise run verify:patches` against a real native bundle before claiming a patch works. Fixtures are necessary, not sufficient.
- Use `mise run native:update`; `mise run patch` intentionally aborts.
- Run every `mise run ...` task sequentially. Never start one while another `mise` task is active, including `diff`, `verify:patches`, `verify:patches:matrix`, native lifecycle tasks, builds, prompt exports, baseline refreshes, and full tests. Concurrent tasks can exhaust memory and may share mutable cache state. Heavy entrypoints also enforce a single process-tree lease, but that guard does not authorize parallel launches. Normal patch and update runs skip structural telemetry; `--summary-path` alone stays lean, while `--structural-evidence` explicitly adds handler counts, overlap evidence, and recursive structural hashes.
- Change prompt mutation, patch verification, and exported-surface contracts together. Refresh drift baselines only after reviewing a known-good export.

Do not set `DISABLE_TELEMETRY` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`; both disable server-controlled features. Use individual `DISABLE_*` settings instead.

## Working model

The patch contract is in `src/types.ts`. Execution is:

1. string transforms in registration order;
2. one parse;
3. shared `discover`, `mutate`, and `finalize` traversals;
4. print;
5. per-patch verification;
6. signature injection and verification;
7. write only when no tag failed.

Memory cleanup in `src/types.ts`, `src/patch-runner.ts`, `src/babel.ts`, `src/diff.ts`, `scripts/export-prompts.ts`, and the update path in `src/index.ts` is load-bearing. Removing dropped ASTs, traverse-cache cleanup, the large-verifier-set midpoint release, or pre-verification GC reintroduces update-time OOMs.

Native repacking must preserve the original byte length and virtual-address layout. Promotion is an atomic symlink swap; rollback swaps current and previous.

## Find the right surface

| Task | Start here |
|---|---|
| Patch contract or pipeline | `src/types.ts`, `src/patch-runner.ts`, `src/ast-pass-engine.ts` |
| Existing patch | `src/patches/<tag>.ts` and its adjacent test |
| Patch registry | `src/patches/index.ts`, `src/patch-metadata.ts` |
| AST helpers | `src/patches/ast-helpers.ts` |
| Native lifecycle | `src/manager.ts`, `src/native*.ts`, `src/bun-format.ts` |
| Bundle inspection or drift | `src/inspector.ts`, `src/diff.ts` |
| Prompt policy and contracts | `src/patches/prompt-policy.ts`, `src/verification/` |
| Prompt export | `scripts/export-prompts.ts`, `src/prompt-corpus.ts` |
| Subscription routing setup | `docs/subscription-routing/README.md` |
| Project workflows | `.claude/workflows/README.md` |

Load the relevant heading from `docs/maintainer-reference.md` when a task needs binary-format detail, patch-interaction hazards, the full command catalog, release-diff procedure, prompt artifact semantics, or authoring recipes. Do not load that entire reference by default.

## Patch changes

For a new patch:

1. Create `src/patches/<tag>.ts`, its adjacent `node:test` test, the named export and `registeredPatches` entry in `src/patches/index.ts`, and the `BY_TAG` metadata record in `src/patch-metadata.ts`.
2. Implement durable AST matching and behavioral verification.
3. If exported guidance changes, update prompt-surface rules and the prompt policy contract where applicable.
4. If the patch count changes, update the README count and badge, then confirm against `bun run cli --list`.

Patches in one pass share a traversal. A sibling may mutate a node before the current visitor sees it. Fixture tests cannot expose this. Match unique durable shapes and make verification mirror the mutator's predicates.

Never call `path.stop()` in a combined traversal. It is downgraded to `path.skip()` because stopping would halt sibling patches.

## Commands and verification

`package.json` owns command aliases; `mise.toml` is only a thin task index. Keep workflow logic in TypeScript entrypoints and scripts.

Quick repository gates:

```bash
bun run typecheck
bun run lint
bun run test
```

Tests run serially through `bun run test`; raw parallel Bun test loading is known to produce false failures.

Real patch gate:

```bash
mise run verify:patches
```

This typechecks, lints, patches a native target without promotion, verifies prompt surfaces, and checks prompt drift. Its failed-tag summary is the authoritative pre-promotion evidence.

For release inspection, repair, and promotion:

1. Resolve the newest live target with `npm view @anthropic-ai/claude-code version dist-tags --json`; if `next` is newer than `latest`, use it. Older explicit versions are comparison-only.
2. Record `mise run status` and the worktree state, then create one OS-temp workspace for evidence and prompt artifacts. Never write scratch exports into `versions_clean/`.
3. Pull the clean target with `mise run native:pull -- <target>` and use only its immediate clean predecessor for release comparison.
4. Inspect `mise run diff -- matrix ...` and focused diffs before source edits.
5. If the user requests inspection only or forbids heavy verification, do not run `verify:patches`, `verify:patches:matrix`, or `native:update`. Use clean-bundle diffs, direct anchor inspection, focused tests, and a patched temp-bundle summary instead.
6. Otherwise run `SELECTED_VERSION=<target> mise run verify:patches:matrix` before promotion. Fix only the latest upstream shape and rerun failed evidence.
7. Patch and export into the temp workspace, then verify prompt surfaces and prompt drift. Refresh `prompt-surface-baseline.json` only after reviewing a known-good patched export.
8. Update the README target anchors and baseline version. Change the README patch count only when the registered patch count changed.
9. Promote with `mise run native:update -- <target>`. Use `--force` after source fixes only when cached-build reuse leaves old behavior in the promoted binary.
10. Confirm `claude --version` and `mise run status`, then run `mise run verify:patches` independently. Report patch verification, prompt-surface validity, and prompt drift as separate states.

Do not describe drift as corrected merely because a binary promoted or a comparison report exists. Correction requires a source fix or an intentionally reviewed baseline refresh followed by a passing drift verifier.

Lefthook runs formatting, lint, and typecheck before commit. Tests and the real patch gate remain explicit responsibilities.
