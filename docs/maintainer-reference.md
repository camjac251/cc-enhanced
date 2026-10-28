# cc-enhanced maintainer reference

Mod authoring, release updates, native extraction, prompt auditing, and memory containment. Read [AGENTS.md](../AGENTS.md) first, then load only the sections needed for the task.

[Documentation home](README.md) · [CLI reference](cli-reference.md) · [Configuration](configuration.md)

## Architecture

The installed system has three parts:

1. The user's official, unmodified Claude Code installation, which updates itself.
2. A standard marketplace plugin in `plugin/`, loaded directly from TypeScript with no build step.
3. A shell PATH wrapper written by `install.sh`, which appends a readable system-prompt file to parent and subagent contexts.

The root `.claude-plugin/marketplace.json` exposes `./plugin` as `cc-enhanced@cc-enhanced`. `plugin/.claude-plugin/plugin.json` supplies plugin metadata and the `plugin/state.d.ts` session-state contract; `plugin/hooks/hooks.json` declares `"modules": ["./register.ts"]`. The mod owns session guidance, selected tool descriptions, CLAUDE.md framing, skill scope, agent visibility, tool denial, transcript expansion/diffs, opted-in agent model routing, and the added batch-edit/view tools. It cannot change built-in tool schemas or native behavior outside the exposed UI hooks.

`install.sh` adds or refreshes the marketplace, installs and updates the plugin, writes the wrapper, and adds unset settings, shell blocks, and non-overwriting Explore/Plan user-agent defaults unless opted out. No Bun is required for setup or runtime. The plugin, agents, and saved settings apply across Claude Code surfaces; only wrapper launches receive its prompt appends. Uninstall removes installer-owned files, including unchanged agent defaults, while preserving custom agents and settings. There is no custom binary lifecycle. Native extraction and bundle analysis are read-only maintenance tools.

The old patch-based architecture remains in the [last public patcher revision](../README.md#what-changed-from-the-legacy-patcher). Its native writers, target profiles, and patch verification procedures do not apply to main.

## File map

| Need | Look at |
| --- | --- |
| Setup, shell wrapper, settings, and uninstall | `install.sh`, `scripts/install.test.ts` |
| Marketplace and plugin metadata | `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`, `plugin/hooks/hooks.json` |
| Mod registration | `plugin/hooks/register.ts` |
| Batch editing and ranged viewing | `plugin/hooks/batch-edit.ts`, `plugin/hooks/view.ts` |
| Prompt guidance and transforms | `plugin/hooks/prompts.ts`, `plugin/hooks/policy.ts`, `plugin/hooks/prompt-transforms.ts` |
| Other runtime event handlers | `plugin/hooks/claudemd.ts`, `plugin/hooks/skill-scope.ts`, `plugin/hooks/agent-visibility.ts`, `plugin/hooks/disabled-tools.ts`, `plugin/hooks/transcript.ts` |
| Generated upstream contracts | `types/claude-code.d.ts`, `types/claude-code-tools.d.ts` |
| Unit tests | `tests/unit/` |
| Engine tests and live verification | `mods/tests/`, `src/verify-mod.ts` |
| Official artifact fetch | `src/native-release.ts` |
| Native extraction | `src/native.ts`, `src/native-linux.ts`, `src/native-lief.ts` |
| Embedded module data and inspection bundling | `src/bun-format.ts`, `src/native-rebundle.ts` |
| Bundle parsing and traversal cleanup | `src/babel.ts`, `src/loader.ts` |
| Bundle inspector and release diff | `src/inspector.ts`, `src/diff.ts` |
| Prompt extraction | `scripts/export-prompts.ts`, `src/prompt-corpus.ts` |
| Prompt comparisons | `scripts/compare-prompts.ts`, `scripts/compare-prompt-matrix.ts`, `src/verification/` |
| Memory containment and serialization | `scripts/run-memory-limited.ts`, `src/heavy-operation-guard.ts` |
| Serial test runner | `scripts/run-tests-serial.mjs` |

`package.json` owns command aliases; `mise.toml` is a thin index. Keep workflow logic in source and scripts, not duplicated shell task bodies. See the [CLI reference](cli-reference.md) for commands.

## Mod authoring

Use the latest stock API declarations in `types/claude-code.d.ts` and `types/claude-code-tools.d.ts`. Keep generated files verbatim; do not hand-edit them to describe an API the host does not implement. Headless declaration refreshes need `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` on a launch with `--plugin-dir`. Verify the generated version headers and byte hashes before replacing the declarations. A hook firing or a plugin validating does not prove stale declaration files were refreshed.

Register event handlers through `plugin/hooks/register.ts` and follow the existing module boundaries. Keep pure prompt transformations testable independently in `tests/unit/`, then exercise their actual event hooks in the host engine through `mods/tests/`. Do not copy managed `/etc/claude-code/*` text into the mod; shared guidance in `plugin/hooks/policy.ts` should be distilled and behavior-focused.

Built-in tool schemas are not mutable through this API. Add a namespaced tool instead of adding parameters to Read or Edit. Tools registered through `tool.register` need `isDeferred: false` and must be registered inside `session.start` after `await next(e)`. Preserve the description invalidation and host round trip before returning so resumed sessions receive refreshed descriptions; invalidation itself is fire-and-forget.

Declare session state in the manifest's self-contained `types` contract, not in executable hook modules or generated upstream declarations. Transcript rendering stores observed paths in `$.state`, never shared module variables. Completed diffs render in `ToolUse`; matching standalone `ToolResult` rows draw nothing to avoid duplicates. Pending, failed, staged, and unavailable-diff rows stay stock. Check both compact and Ctrl+O views in a real terminal: isolated row fixtures cannot detect duplicate host rows.

### Added tool boundaries

`mcp__cc-enhanced__batch_edit` deliberately needs no prior Read: core skips Edit's read-before-edit and stale-file checks for plugin calls, and the mod does not add them back. Its safety comes from content addressing instead: it reads the file's current bytes, requires every `old_string` to match the sequential state (unique unless `replace_all`), and refuses the whole batch before any change otherwise. It then applies one core Edit per change through `$.tool.call`, which runs Edit's permission check, dialog, and hooks. If a later edit fails, the mod writes the original bytes back through `$.fs.write` (BOM/CRLF preserved); that write is not permission-checked and is not recorded for rewind. The input must round-trip as UTF-8. Do not claim atomicity or rewind coverage.

`mcp__cc-enhanced__view` checks Read permission before reading UTF-8 text. It supports `30:40`, `30:`, `:40`, `-30:`, `50:+20`, and `100::10`, numbered output, and optional whitespace glyphs. Files ending in `.output` default to the last 500 lines. Input is capped at 4 MiB because the mod filesystem API cannot stream just a range; output is bounded to 1,000 content lines and 100,000 characters. Route larger files, images, PDFs, notebooks, and approval-required reads to core Read.

Descriptions and guidance must make these boundaries explicit. Disabled tools need enforced denial as well as routing-only descriptions; hiding or deferring a description alone does not prevent invocation.

## Mod verification

For development, install the pinned runtimes with `mise install` and dependencies with `bun install --frozen-lockfile`. Run checks sequentially:

```bash
bun run docs:check
bun run typecheck
bun run lint
bun run test
bun run verify:mods --binary /path/to/latest-stock/claude --live
```

`src/verify-mod.ts` stages `plugin/` exactly as shipped plus the engine tests from `mods/tests/`; those tests are not shipped in the plugin. It validates the staged plugin with `claude plugin validate --strict`, executes engine tests through `claude plugin test`, then uses `--plugin-dir` for real CLI sessions against a local Messages stub when `--live` is set. Live checks establish model-visible descriptions, both new tools, batch editing on a never-read file, untouched bytes after failure, view behavior, disabled-tool denial, persisted resume refresh, and default/legacy task modes with fork on/off. They do not use paid provider inference. User setup does not run these gates.

A standalone engine test or version-only launch is not enough to claim live behavior. Always use the latest stock executable as the verification target, not the shell wrapper that appends prompt options. On the standard Linux install, use `bun run verify:mods --binary $(readlink -f ~/.local/bin/claude) --live`. Report the exercised gate and its exact target; stock prompt extraction is separate evidence.

For changes to wrapper policy, agent definitions, routing, or transcript rendering, also run a real PTY smoke against a local Messages stub. Assert interactive versus print-mode policy placement, caller-owned/disabled/direct-launch isolation, bare Explore/Plan prompt selection, one copy of each diff in compact and Ctrl+O views, and actual Workflow child model IDs and effort at the endpoint. Run the PTY child inside the bounded process tree rather than through an already-running terminal server. The minimum-version gate checks API loading and engine tests only; it is not a second live compatibility target.

## Release update procedure

1. Resolve the newest live release with `npm view @anthropic-ai/claude-code version dist-tags --json`. If `next` is newer than `latest`, use that target. Older versions are comparison-only. Read what changed since the last validated release with `bun run changelog`, and narrow it with `--match` for plugin/mod API, tools, and prompt items.
2. Record the official executable version and note existing worktree changes. Create one OS-temp workspace for private evidence and prompt exports; do not place scratch exports in `versions_clean/`.
3. Fetch/extract the latest stock bundle with `bun run native:pull <target>`. Compare it with its immediate clean predecessor, focusing on plugin API behavior, launch options, tools, and prompt guidance.
4. Refresh declarations from the latest binary with `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` and `--plugin-dir`. Check generated version headers and hashes; preserve the files verbatim in `types/`.
5. Adapt mod code and tests to the latest shape only. Do not add compatibility branches for old host APIs. When the mod starts using a mods API feature, hook, or field, check the mods reference for a "Requires Claude Code v…" note and the changelog for fixes the mod depends on; raise `metadata.minimumClaudeCodeVersion` in `plugin/.claude-plugin/plugin.json` when it is newer, then confirm with `bun run verify:minimum`. Claude Code has no manifest field that enforces a minimum, so `install.sh` enforces this value at setup and the docs state it. Older versions are a floor for loading, not a supported target for prompt shape.
6. Run the repository checks and `bun run verify:mods --binary <latest-stock-binary> --live`, sequentially. Resolve failures before changing the tested-version claims.
7. Update README version anchors and release-facing documentation. Bump `plugin/.claude-plugin/plugin.json`'s version, then publish the plugin changes. Treat the version bump as required release practice for update detection; version-based detection is inferred from plugin documentation rather than verified by the runtime gate.
8. Report repository gates, live mod checks, and any reviewed stock prompt drift separately. GitHub/git marketplace users receive new versions through plugin auto-update; local-checkout users pull, update the plugin or rerun setup, then reload plugins or start a new session.

Claude Code updates independently. The mod API is early access, so a breaking upstream change can surface before a compatible plugin release. Setup warns if `DISABLE_AUTOUPDATER=1` or `DISABLE_UPDATES=1` is set in the environment or settings `env` block without changing those values. Plugin auto-update needs `FORCE_AUTOUPDATE_PLUGINS=1` when `DISABLE_AUTOUPDATER` is set.

If the assignment is inspection-only or forbids heavy verification, stop short of installation and report the missing runtime evidence. Do not call drift corrected merely because a comparison report exists or installation succeeded.

## Native extraction and Bun standalone format

Related files: `src/native-linux.ts`, `src/native-lief.ts`, `src/bun-format.ts`, `src/native-rebundle.ts`, and `src/native.ts`.

Native code is retained for locating and extracting embedded JavaScript. The downloaded executable remains untouched. Bounds, offsets, module descriptors, and entry-point metadata must be validated before reading; malformed native data must fail rather than produce a plausible partial bundle.

Bun 1.3+ standalone ELF format uses:

- A `.bun` section containing `BUN_COMPILED.size`, a virtual address pointing to appended data.
- A `PT_LOAD` mapping for appended data, using the segment formerly represented by `PT_GNU_STACK`.
- Payload layout `[u64 payload_len][module data][offsets (32 bytes)][trailer]`.
- Relocated section headers and a corresponding `e_shoff` value.

Mach-O and PE hold the Bun payload behind a length header in bounded native sections: `__BUN/__bun` for Mach-O and `.bun` for PE. `node-lief` provides typed section and segment offsets for locating the raw range. Extraction must not invoke a generic binary writer, change sections or segments, remove signatures, or sign an artifact.

A single-module executable exposes its entry JavaScript directly. Split embedded JavaScript may need dependency resolution and rebundling to produce one inspection surface. Keep the original executable and its non-JavaScript assets unchanged; generated `cli.js` is analysis output, not an installable replacement. Format support does not prove runtime support on a different host.

```bash
bun run native:fetch <version>
bun run native:pull <version>
bun run native:unpack <binary> /tmp/stock-cli.js
```

`native:pull` writes `versions_clean/<version>/cli.js`. Keep that tree for clean upstream evidence only. Download-cache eviction protects whatever the official `~/.local/bin/claude` and `~/.local/share/claude/versions/{current,previous}` paths resolve to; this audit cache is not part of user installation.

## Searching cli.js

Use `rg` for exact literals; never run `ast-grep` over the giant bundle. For parsed context, `bun run inspect search <cli.js> <query...>` parses once for multiple queries and ranks exact strings and durable object keys ahead of incidental identifier substrings.

Useful options include `--field string|template|identifier|key`, `--regex`, `--ignore-case`, `--object`, `--json`, `--scope`, `--children`, and `--breadcrumb-depth <n>`. `bun run inspect prompts <cli.js> [query]` inventories prompt-like strings and templates. Describe findings by behavior, never by copied minified identifiers or reconstructed source names.

## Bundle diff triage

`bun run diff -- <old-cli.js> <new-cli.js>` compares stable bundle surfaces for upstream release review. Focused reports include:

- `--focus commands`: command-like changes and nearby flags.
- `--focus env`: environment and traffic-control changes.
- `--focus settings`: configuration writes and count changes.
- `--focus rewrites`: prefix/text rewrites.
- `--focus prompts --prompt-export <dir>`: prompt-like surfaces and reminder changes, cross-checked against an export.
- `--cache`: reuse extracted surfaces for repeated analysis.

Matrix mode, `bun run diff -- matrix <old> <mid> <new>`, attributes changes to adjacent releases. For ordinary latest-only maintenance, the immediate predecessor is the baseline; older bundles are not compatibility targets. `bun run diff -- ast <old> <new>` provides AST-node comparison.

Keep `bundle-diff.config.json` rules about durable public surfaces and local triage noise. Do not add upstream source-file names, reconstructed module names, or minified identifiers.

## Prompt policy layering

Detailed global behavior remains in runtime-managed `/etc/claude-code/` files. The shell wrapper appends the selected readable file to the parent system prompt. Print-mode subagents receive the stock subagent system-prompt flag; interactive launches instead set `CC_ENHANCED_SUBAGENT_PROMPT_FILE`, and the plugin delivers that exact file as `SubagentStart` additional context. The marker is set only when the wrapper owns the subagent append, reset each invocation, and ignored when disabled. It must not default to a managed path inside the plugin. `--prompt-file` selects the default and `CC_ENHANCED_PROMPT_FILE` overrides it per run. Caller appends, unreadable files, and non-wrapper launches retain their documented ownership. See [configuration](configuration.md#wrapper-controls) for message-role and organization-managed-session limitations.

The mod supplies concise session guidance and tool descriptions, not copies of managed policy. It strengthens CLAUDE.md framing where stock context is present; it does not restore the old native subagent inclusion override. Stock prompt artifacts omit both the plugin's runtime changes and launch-time managed appends. Use captured live requests to establish the resulting composition.

## Prompt artifacts

Exports come from an explicit clean version or native-extracted bundle path:

```bash
bun run prompts:export <version> --output-dir /tmp/prompts-<version>
bun run prompts:bundle <version> --output-dir /tmp/prompts-<version>-bundle
bun run prompts:compare /tmp/prompts-<old> /tmp/prompts-<new> /etc/claude-code
bun run prompts:compare:matrix /tmp/prompts-<old> /tmp/prompts-<new> /etc/claude-code
```

`--bundle` through `prompts:export` and the `prompts:bundle` alias produce the same navigable artifact view. Use `--label` for explicit-path exports and `--max-uncategorized <n>` when a coverage budget is appropriate. Artifact paths must be unique; duplicate writes must fail rather than silently overwrite entries.

Comparison commands take baseline export, candidate export, and managed-policy directory. Reports review inventory and manifest changes, policy overlap, and prompt content; the matrix also compares interpolation-dependency multisets. Dependency expressions are hashed rather than published as raw source. Regenerate older hashless corpora with the current exporter before comparing them. Reports are review aids, not a pass/fail claim about runtime mod behavior.

Section inventories exclude local scalar fragments used only within enclosing template text. Conditional alternatives and unresolved runtime values can still appear: the export is an inventory of possible guidance, not a claim that every variant is sent together. Use `manifest.json` quality metadata to track extraction coverage.

## Prompt extraction

Related files: `scripts/export-prompts.ts`, `src/prompt-corpus.ts`, and their tests.

The exporter extracts prompt text with AST-based resolution. It accepts a clean version or explicit bundle path; there is no implicit active modified-binary export. Keep scratch output in an OS-temp workspace.

```text
exported-prompts/<version>/
|-- agents/                  # Per-agent Markdown and inventory
|-- skills/                  # Per-skill Markdown and inventory
|-- system/
|   |-- sections/
|   |-- variants/
|   |-- reminders/
|   |-- builder-outline.md
|   `-- system-prompts.json
|-- tools/
|   |-- builtin/
|   |-- schemas/
|   `-- sections/
|-- workflows/
|-- internal-agents/
|-- tools.json
|-- skills.json
|-- workflows.json
|-- output-styles.json
|-- corpus-categorized.json
|-- corpus-summary.json
|-- data-references.json
|-- prompt-corpus.json
|-- prompt-hash-index.json
`-- manifest.json
```

Coverage includes built-in agents, skills, tool descriptions and heading-based sections, schema-only tools, system variants/sections/reminders, internal model-call prompts, data references, output styles, workflows, and the full prompt corpus. Counts vary by release; use the generated manifest rather than hardcoding them in documentation.

Maintain these extraction semantics:

- Follow stable function references when resolving prompt builders.
- Respect local lexical bindings so unrelated globals cannot supply same-named values.
- Treat unknown parameters, destructuring, missing arguments, and uninitialized locals as masking outer values. Immutable scalars and literal-return helpers may resolve static conditions; mutable initializers cannot.
- Export unresolved tool-prompt branches as labeled conditional alternatives with provenance. Bound nested fragments instead of expanding a Cartesian product.
- Resolve supported template calls, string trimming, and concatenation without pretending runtime-only values are known.
- Reject interpolation artifacts as agent names.

## Memory containment

The Linux/WSL runner uses verified cgroup-v2 controls under a systemd user scope: at most 16 GiB aggregate RAM, reduced to half available headroom, no swap, and whole-group OOM termination. `CC_ENHANCED_MEMORY_MAX_MIB` lowers but cannot raise the ceiling. Nested commands share the outer scope. Missing controls fail closed; other platforms explicitly report the lack of kernel containment.

Run heavy aliases and ad-hoc investigations through the bounded runner. Never launch heavy tasks concurrently, bypass containment, or retry a killed workload unbounded. The heavy-operation lease is a second serialization guard, not permission for parallel work. Native extraction, diffs, exports, and full tests still parse or retain large data.

Preserve large-object cleanup in parsers and exporters. Reuse existing Program NodePaths for nested scoped scans; wrapping the same live Program in a second File creates another Babel path/scope graph. Release traversal caches and AST references when no longer needed. Validate memory controls with small fixtures rather than reproducing a host OOM.

See [memory limits](cli-reference.md#memory-limits) for requirements and examples. Containment is crash protection, not compatibility verification, and does not wrap normal installed Claude sessions.

## Testing

Tests use the `node:test` API through Bun. `bun run test` starts one isolated Bun process per file, sequentially, runs every file even after a failure, and reports failed files at the end. Per-file processes bound memory and avoid concurrent-load shim failures. Do not substitute a raw whole-tree Bun test invocation.

Plugin unit tests live in `tests/unit/`; host-engine tests live in `mods/tests/` and are staged by the verifier. The serial suite scans `src`, `scripts`, and `tests`; lint covers those directories plus `plugin` and `mods`. `scripts/install.test.ts` exercises setup hermetically with a fake `claude` and throwaway HOME.

For a targeted test or investigation:

```bash
bun run bounded -- bun test <test-file>
bun run bounded -- bun --smol <investigation-script>
```

The serial runner resolves a compatible Bun once and makes child spawns use that runtime. Preserve this behavior when changing test infrastructure. Test mod contracts and observable effects rather than brittle upstream names.

Two fixture hazards remain important: Bun can retain the startup PATH for spawn lookup, and dynamic-import namespaces can retain the first imported child-process function. Follow the existing interceptor patterns when stubbing spawned commands rather than relying on in-test PATH mutation or repeatedly swapping imported functions.

Lefthook gates formatting, lint, and typecheck before commit; tests and live mod verification remain explicit responsibilities. Never report unrun gates as passing.
