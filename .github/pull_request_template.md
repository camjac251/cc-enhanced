<!-- Title: type(scope): description, as in fix(mods): preserve stock tool permission checks, with type feat, fix, docs, style, refactor, perf, test, build, ci, chore, or revert. The merge commit body is the title. This description is public: describe upstream behavior and never name minified identifiers, reconstructed module names, or upstream source names. Write plain, specific prose with no em or en dashes, replace every COMMAND, HOST, RESULT, and X.Y.Z placeholder, and delete each section whose comment says it does not apply. -->

## Summary

<!-- What changed and why, substance first. For a bug fix: the problem, root cause, and fix, with the exact error in a fenced block. For mod or release work: the stock Claude Code version and the runtime behavior that changed. -->

## Verification

<!-- One line per check as it actually ran: command, host (OS, arch, Bun version), result, and the base commit when the result depends on it. List checks you did not run as "not run" with the reason. For a fix, add a test or reproduction that fails before the change and passes after it, and name any changed path that no check exercised. Run checks serially through the bounded runner; never overlap memory-heavy jobs. Mod verification requires an explicit stock Claude Code executable. -->

- `COMMAND` on HOST: RESULT
- `CC_ENHANCED_MEMORY_MAX_MIB=4096 bun run bounded -- bun run typecheck` on HOST: not run
- `CC_ENHANCED_MEMORY_MAX_MIB=4096 bun run bounded -- bun run lint` on HOST: not run
- `CC_ENHANCED_MEMORY_MAX_MIB=4096 bun run test` on HOST: not run
- `CC_ENHANCED_MEMORY_MAX_MIB=4096 bun run verify:mods --binary /path/to/stock/claude --live` against Claude Code X.Y.Z on HOST: not run

## Checklist

<!-- Check each item that is true. Delete any item whose leading condition does not apply. -->

- [ ] Code, comments, tests, docs, config files, and this description name no minified identifiers, reconstructed module names, or upstream source names.
- [ ] Host-dependent test added: other hosts skip it with `t.skip(reason)`, never a silent return.
- [ ] Runtime changes use the public mod API and preserve stock permissions and tool behavior outside the stated feature.
- [ ] Changed mod behavior has coverage in `tests/unit/` or `mods/tests/`, including reachable denial and error paths.
- [ ] Setup or wrapper changes preserve user settings, keep shell blocks idempotent and removable, and leave official Claude Code updates independent.
- [ ] Stock audit tools describe the supplied stock input without applying local runtime prompt transforms.
- [ ] User-facing behavior changes are documented without claiming native binary patching.

## Claude Code release

<!-- Delete unless this PR adds or repairs support for a Claude Code release. Name the stock version tested and any earlier release used for a stock audit comparison. -->

- Stock Claude Code X.Y.Z on HOST: RESULT
- [ ] The documented supported version matches the stock executable exercised by mod verification.

## After merge

<!-- Delete unless merging needs a follow-up step, such as publishing a new plugin version or refreshing a local marketplace installation. The plugin ships as TypeScript without a build step; Claude Code updates independently. -->
