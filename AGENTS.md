# cc-enhanced

Stock Claude Code with a standard marketplace plugin, a setup script and shell PATH wrapper, and native-extraction/prompt-auditing tools. The executable is never modified and updates independently. The README badge records the tested upstream version; `claude --version` identifies the running executable, not whether its mod works.

## Hard rules

- Target only the latest upstream version. Never add compatibility fallbacks for older upstream forms. Use the immediately previous clean bundle only as a release-diff baseline.
- Never hardcode minified variable names. For bundle inspection and extraction, use stable literals, property names, and surrounding AST structure.
- Never use `ast-grep` on `cli.js`. Use `rg` for exact literals and `bun run inspect search` for parsed context with breadcrumbs.
- Never copy `/etc/claude-code/*` verbatim into mod text. Runtime policy stays managed; keep mod guidance concise and behavior-focused in `plugin/hooks/policy.ts` and its consumers.
- Never expose upstream internals such as minified identifiers, reconstructed module names, or source names in comments, docs, logs, memory, or diff configuration. Describe behavior.
- Keep `types/claude-code.d.ts` and `types/claude-code-tools.d.ts` declarations verbatim. Refresh them from the latest stock binary using `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` on a `--plugin-dir` launch. Check generated version headers and byte hashes; a successful hook invocation does not prove declarations refreshed.
- Built-in tool schemas cannot be changed through the mod API. Add a separate tool rather than advertising unsupported parameters on Read, Edit, or another built-in.
- Register tools with `isDeferred: false` in `session.start`, after `await next(e)`. Keep registration and resume description refresh together; invalidation is fire-and-forget, so preserve the host round trip before returning.
- Run `bun run verify:mods --binary <latest-stock-binary> --live` before claiming a mod works. Fixtures and plugin-engine tests alone are insufficient.
- Run heavy tasks sequentially, including every `mise run ...` task, mod verification, native extraction, diffs, prompt exports, and the full test suite. Never start a second heavy task while another is active. The process-tree lease is a safety guard, not permission to launch concurrently.
- On Linux/WSL, use configured `mise`/`bun run` aliases or `bun run bounded -- <command>` for heavy commands and ad-hoc bundle investigations. The kernel-enforced process-tree ceiling is at most 16 GiB, reduced to half available headroom, with swap disabled. Nested commands share that budget. Do not bypass the guard, raise the ceiling, or retry a killed workload unbounded. A memory-limit failure is not successful verification; do not activate on that evidence. Validate containment with small fixtures rather than reproducing a host OOM.
- Keep changed mod behavior, descriptions, engine tests, and live verification expectations consistent. Stock prompt exports are inventories, not evidence of model-visible mod behavior.
- Ship `plugin/` as TypeScript loaded directly by Claude Code. Do not add a plugin build step or a custom binary lifecycle. `install.sh` is the only installer; no Bun is required to install or run.
- Preserve explicit user settings, including `false`, when adding setup defaults. Keep shell PATH blocks idempotent and removable. The wrapper only supplies prompt appends; Claude Code owns binary and plugin updates.

Do not set `DISABLE_TELEMETRY` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`; broad traffic switches disable server-controlled features. Use individual `DISABLE_*` settings instead.

## Working model

The root `.claude-plugin/marketplace.json` exposes `plugin/` as `cc-enhanced@cc-enhanced`. `plugin/.claude-plugin/plugin.json` identifies the plugin; `plugin/hooks/hooks.json` loads `./register.ts` directly. `plugin/hooks/register.ts` installs event handlers and registers additional tools. `install.sh` adds or refreshes the marketplace, installs and updates the plugin, writes a PATH wrapper, and adds unset settings, shell blocks, and non-overwriting Explore/Plan agent defaults unless opted out. It never replaces the official executable.

The wrapper runs the first real `claude` later on PATH and appends the selected readable file to the parent system prompt and print-mode subagent system prompts, unless the caller owns that append family. Interactive launches instead pass a private file marker to the plugin's `SubagentStart` hook, which supplies additional message context, not system-role text. Clear inherited markers before handling disable/caller overrides; without the marker the hook must add nothing. Only wrapper launches receive these appends; user-scope plugins and settings also apply on other Claude Code surfaces. `CC_ENHANCED_DISABLE=1` skips wrapper additions but does not disable the plugin. Uninstall removes installer-owned files and unchanged agent defaults, preserving custom agents and settings.

Claude Code updates itself. GitHub/git marketplace sources receive plugin auto-updates when enabled. Local checkout users pull changes, run `claude plugin update cc-enhanced@cc-enhanced` or rerun setup, then reload plugins or start a new session. Setup warns about disabled Claude Code updates without changing those controls.

Keep native extraction read-only. The retained binary-format code locates and validates embedded data for inspection; it must not become a native writer. Split bundles may be combined for analysis, never installed as modified executables.

Memory cleanup in bundle parsing, `src/babel.ts`, `src/diff.ts`, and `scripts/export-prompts.ts` is load-bearing. Release large ASTs and traversal caches when they are no longer needed. For nested scoped scans, reuse the existing Program NodePath rather than wrapping the same live Program in another File and creating a second scope graph.

## Find the right surface

| Task | Start here |
| --- | --- |
| Setup, uninstall, shell wrapper, and saved defaults | `install.sh`, `scripts/install.test.ts` |
| Marketplace and plugin metadata | `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`, `plugin/hooks/hooks.json` |
| Mod event registration and runtime behavior | `plugin/hooks/register.ts`, `plugin/hooks/` |
| Unit tests, engine tests, and live verification | `tests/unit/`, `mods/tests/`, `src/verify-mod.ts` |
| Upstream mod API contracts | `types/claude-code.d.ts`, `types/claude-code-tools.d.ts` |
| Prompt policy and transforms | `plugin/hooks/policy.ts`, `plugin/hooks/prompt-transforms.ts`, `plugin/hooks/prompts.ts` |
| Transcript diffs and session-local path state | `plugin/hooks/transcript.ts`, `plugin/state.d.ts` |
| User-agent defaults and ownership | `templates/agents/`, `install.sh` |
| Official release fetch and extraction | `src/native-release.ts`, `src/native.ts`, `src/native-linux.ts`, `src/native-lief.ts` |
| Embedded data and inspection bundle | `src/bun-format.ts`, `src/native-rebundle.ts` |
| Bundle inspection or release diff | `src/inspector.ts`, `src/diff.ts` |
| Prompt export and comparison | `scripts/export-prompts.ts`, `src/prompt-corpus.ts`, `src/verification/` |
| Memory containment and serialization | `scripts/run-memory-limited.ts`, `src/heavy-operation-guard.ts` |
| Subscription routing setup | `docs/subscription-routing/README.md` |
| Pull request description | `.github/pull_request_template.md` |

Load only the relevant heading from `docs/maintainer-reference.md` when binary-format detail, mod authoring, release updates, prompt artifacts, or testing behavior is needed.

## Commands and verification

`package.json` owns development command aliases; `mise.toml` is a thin task index. Keep development workflow logic in TypeScript entrypoints and scripts. User setup stays in `install.sh`.

```bash
bun run docs:check
bun run typecheck
bun run lint
bun run test
bun run verify:mods --binary /path/to/latest-stock/claude --live
./install.sh
./install.sh --uninstall
claude plugin update cc-enhanced@cc-enhanced
bun run native:pull <version>
bun run native:unpack <binary> <output.js>
bun run diff -- versions_clean/<previous>/cli.js versions_clean/<latest>/cli.js
bun run prompts:export <version> --output-dir /tmp/prompts-<version>
```

Tests run serially through `bun run test` across `src`, `scripts`, and `tests`; raw parallel Bun test loading can produce false failures and retain too much memory. Use `bun run bounded -- bun test <file>` for targeted tests. Lint covers `src`, `scripts`, `tests`, `plugin`, and `mods`. The verifier stages the shipped `plugin/` plus `mods/tests/` for host-engine tests; tests are not shipped in the plugin.

## Release updates

1. Resolve the newest upstream release with `npm view @anthropic-ai/claude-code version dist-tags --json`; use `next` if it is newer than `latest`. Older explicit versions are comparison-only.
2. Record the official executable version and the worktree state. Keep scratch evidence and prompt exports in one OS-temp workspace, never in `versions_clean/`.
3. Pull the clean target with `bun run native:pull <target>` and compare it with its immediate clean predecessor. Review changes affecting plugin APIs, launch flags, tools, and prompt guidance.
4. Refresh the exact generated declarations in `types/` from the latest binary, then update mod handlers and tests for that shape only.
5. Run repository gates sequentially and `bun run verify:mods --binary <latest-stock-binary> --live`. Do not substitute static exports or a version-only launch for runtime evidence.
6. Update README version anchors only after verification. Bump `plugin/.claude-plugin/plugin.json`'s version for release detection, then publish the plugin changes.
7. Report repository gates, live mod behavior, and any stock prompt drift separately. Users receive published plugin updates through their marketplace source; Claude Code updates independently, so early-access mod-API changes can arrive before a compatible plugin release.

Inspection-only requests do not authorize install/update or heavy verification. Report exactly what was inspected and what remains unverified. A comparison report identifies drift; it does not prove drift was corrected.

Lefthook runs formatting, lint, and typecheck before commit. Tests and live mod verification remain explicit responsibilities.
