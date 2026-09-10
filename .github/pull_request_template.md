<!-- Title: type(scope): description, as in fix(patches): support Claude Code 2.1.263, with type feat, fix, docs, style, refactor, perf, test, build, ci, chore, or revert. The merge commit body is the title. This description is public: describe upstream behavior and never name minified identifiers, reconstructed module names, or upstream source names. Write plain, specific prose with no em or en dashes, replace every COMMAND, HOST, RESULT, and X.Y.Z placeholder, and delete each section whose comment says it does not apply. -->

## Summary

<!-- What changed and why, substance first. For a bug fix: the problem, root cause, and fix, with the exact error in a fenced block. For patch or release work: the Claude Code version and the upstream behavior that changed. -->

## Verification

<!-- One line per check as it actually ran: command, host (OS, arch, `bun --version`), result, and the base commit when the result depends on it. List checks you did not run as "not run" with the reason. For a fix, add a test or reproduction that fails before the change and passes after it, and name any changed path that no check exercised, such as a platform branch. CI already runs typecheck, lint, docs:check, and the routing template tests on Linux, and `bun run test` on Linux, macOS, and Windows; list those only when your run adds a host or result CI does not show. -->
<!-- verify:patches: keep its lines in every PR, or collapse them to one "not run" line with the reason. The lines default to "not run"; replace a default only with the result of a run that happened, and name any failed tags. It needs no mise (`bun run verify:patches` works) but needs a native Claude Code binary, from a build this tool promoted or from `NATIVE_TARGET`. A run with --allow-missing-target checks only typecheck and lint, so it counts as not run. It is memory-heavy: never run it while another mise task is running. -->

- `COMMAND` on HOST: RESULT
- `mise run verify:patches` against Claude Code X.Y.Z on HOST:
  - patch verification: not run
  - prompt surfaces: not run
  - prompt drift: not run

## Checklist

<!-- Check each item that is true. Delete any item whose leading condition does not apply. -->

- [ ] Code, comments, tests, docs, config files, and this description name no minified identifiers, reconstructed module names, or upstream source names.
- [ ] Host-dependent test added: other hosts skip it with `t.skip(reason)`, never a silent return.
- [ ] Patch matching changed: it targets only the latest upstream form, anchors on stable literals and AST structure, and its co-located `verify` mirrors the mutator's predicates, preferably through `getVerifyAst()`.
- [ ] New patch: `src/patches/<tag>.ts`, an adjacent `node:test` test, the named export and `registeredPatches` entry in `src/patches/index.ts`, and a `BY_TAG` record in `src/patch-metadata.ts`.
- [ ] Patch count changed: every patch count in the README, badge included, matches `bun run cli --list`.
- [ ] Exported prompt text changed: `src/verification/prompt-surface-rules.ts` changed with it, plus `src/verification/prompt-policy-contract.ts` for shared policy.
- [ ] `prompt-surface-baseline.json` changed: I refreshed it only after reviewing a known-good patched export.

## Claude Code release

<!-- Delete unless this PR adds or repairs support for a Claude Code release. Target the newer of npm latest and next. Name the previous clean release you diffed against in the Summary; it is a diff baseline only, never a matcher, fixture, or matrix target. -->

- `SELECTED_VERSION=X.Y.Z mise run verify:patches:matrix` on HOST: not run
- [ ] The README badge and warning text, `docs/getting-started.md`, and the `prompt-surface-baseline.json` version name X.Y.Z.

## After merge

<!-- Delete unless merging needs a follow-up step, such as rerunning the deployment that fast-forwards the patcher and rebuilds Claude Code. -->
