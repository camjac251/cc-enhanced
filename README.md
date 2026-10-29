<h1 align="center">cc-enhanced</h1>

<p align="center"><strong>Stock Claude Code with a standard plugin and system-prompt wrapper</strong></p>

<p align="center">
  <a href="https://github.com/camjac251/cc-enhanced/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/camjac251/cc-enhanced/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Tested with Claude Code 2.1.312" src="https://img.shields.io/badge/tested-Claude_Code_2.1.312-8A2BE2">
  <img alt="Mod-only" src="https://img.shields.io/badge/architecture-mod--only-f97316">
  <img alt="Maintenance paused" src="https://img.shields.io/badge/maintenance-paused-dc2626">
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-2563eb"></a>
</p>

<p align="center">
  <a href="docs/getting-started.md">Get started</a> ·
  <a href="docs/configuration.md">Configuration</a> ·
  <a href="docs/cli-reference.md">Commands</a> ·
  <a href="docs/README.md">Documentation</a>
</p>

> [!WARNING]
>
> Maintenance is paused. I've switched from Claude Code to [oh-my-pi](https://github.com/can1357/oh-my-pi), so ongoing upstream release tracking remains paused. **Claude Code 2.1.263 is the last confirmed supported legacy patcher release**, preserved on [`legacy/patcher-2.1.263`](https://github.com/camjac251/cc-enhanced/tree/legacy/patcher-2.1.263). Automated checks of the separate stock-plugin implementation on `main` cover 2.1.312; they do not establish support for newer legacy patcher versions. Issues and pull requests are still welcome.

cc-enhanced runs an **unmodified official Claude Code executable** with a standard marketplace plugin. The mod changes prompt guidance, tool descriptions, and selected session behavior, and adds two tools for batch editing and ranged text viewing. A small PATH wrapper appends a system-prompt file for shell launches. Claude Code updates itself. There is no native patching, rebundling for execution, or repacking.

This repository contains the plugin, `install.sh`, and development tools. It does not publish Claude Code binaries, application bundles, container images, credentials, session state, or private verification evidence. No Bun or plugin build step is needed to install or run it.

## Quick start

Install official Claude Code, then clone this repository and run the setup script:

```bash
curl -fsSL https://claude.ai/install.sh | bash
git clone https://github.com/camjac251/cc-enhanced.git
cd cc-enhanced
./install.sh
```

Open a new shell afterwards. Setup installs `cc-enhanced@cc-enhanced`, adds unset settings defaults, installs Explore/Plan user-agent defaults when those names are unused, and prepends its wrapper directory to your shell's PATH. It does not replace the official executable. See [Getting started](docs/getting-started.md) for requirements, setup options, and shell changes.

Claude Code keeps updating itself; `claude update` remains its own update command. For the default local-checkout plugin source, pull repository changes, run `claude plugin update cc-enhanced@cc-enhanced` or rerun `./install.sh`, then use `/reload-plugins` or start a new session. GitHub/git marketplace sources can receive plugin auto-updates. Setup warns if Claude Code updates are disabled.

To uninstall the plugin, marketplace, wrapper, and shell blocks:

```bash
./install.sh --uninstall
```

Uninstall removes unchanged installer-owned agent defaults and leaves custom agents and settings keys in place. There is no cc-enhanced binary update, rollback, restore, or status command.

## What changes

| Surface | Behavior |
| --- | --- |
| Batch editing | `mcp__cc-enhanced__batch_edit` edits a file without a prior Read. It matches every `old_string` against the file's current content, validates the whole sequential batch, then makes one real Edit call per change; a stale or ambiguous `old_string` refuses the batch before anything changes. The Edit calls go through Edit's permission prompts and hooks. On a mid-batch failure the mod writes the original bytes back directly, including BOM and CRLF; that restore does not ask permission and is not recorded in rewind history. It accepts round-trippable UTF-8 text. |
| Text viewing | `mcp__cc-enhanced__view` provides numbered ranges and visible whitespace. It checks Read permission first, defaults `*.output` files to the last 500 lines, and accepts UTF-8 files up to 4 MiB. Use core Read for larger files, nontext content, or approval flows. |
| Prompt guidance | Session guidance and selected TodoWrite, Bash, Agent, Read, and Edit descriptions steer tool use. The mod strengthens CLAUDE.md instruction framing, narrows Claude API skill guidance to API/SDK work, and refreshes tool descriptions on resume. |
| Tool and agent visibility | Glob, Grep, WebSearch, WebFetch, and NotebookEdit receive deferred routing-only descriptions and are denied if invoked. The `statusline-setup` and `claude-code-guide` agents are hidden. Transcript tool groups stay expanded. |
| Plan and memory diffs | Completed Edit/Write rows show the full path and actual additions/deletions, including new-file contents. Each change appears once in compact and expanded transcripts; failed or unavailable diffs stay stock. |
| Agent definitions and routing | Setup supplies read-only Explore/Plan defaults under bare names without replacing existing definitions. Routed launches resolve configured Clodex aliases at `agent.spawn`, including Workflow workers, while preserving agent type and effort. The stock Agent model schema is unchanged. |
| Setup and shell wrapper | Setup adds unset defaults for one-hour prompt-cache TTLs, ultracode, the Read output-token budget, and plugin auto-updates. The wrapper appends the selected file to parent and print-mode subagent system prompts; interactive subagents receive it through the plugin as additional message context. See [configuration](docs/configuration.md) for settings and prompt overrides. |

The built-in Read and Edit schemas remain stock, and stock Edit still asks for a prior Read; `batch_edit` is the path without one, for a single change or many. Ranges belong to `view`. Auto mode is the default permission mode in Claude Code 2.1.312, and it runs batch edits without prompting. In manual-approval mode, every change in a batch asks for approval separately. Ultracode still requires workflows and a supported model. The plugin and saved settings apply across Claude Code surfaces, including Desktop and VS Code. Only shells that load the PATH block receive the wrapper's system-prompt appends; clients that launch their own Claude Code do not.

## What changed from the legacy patcher

If you want the legacy native patcher and its 44-patch catalog, use [`legacy/patcher-2.1.263`](https://github.com/camjac251/cc-enhanced/tree/legacy/patcher-2.1.263). **2.1.263 is its last confirmed supported Claude Code version.** Disregard claims that later patched versions were confirmed; later checkpoints are not confirmed supported releases. The branch is frozen, not actively maintained.

Clone it into a separate directory so it does not replace your stock-plugin checkout:

```bash
git clone --branch legacy/patcher-2.1.263 --single-branch https://github.com/camjac251/cc-enhanced.git cc-enhanced-legacy
```

Follow that branch's README for the legacy workflow. Main's `install.sh` installs the stock plugin, not the legacy patcher.

Some former changes now come from stock Claude Code, saved settings, or the shell wrapper: Monitor availability, per-call Agent effort, 2576px image handling, prompt-cache TTLs, the Read token budget, system-prompt appends, ultracode, and the default effort setting.

The following legacy behavior is **not retained**:

- Core Read `range` and core Edit `edits[]` parameters, relaxed stale-read checks, changed-file reminder limits, and mtime-churn handling. The new tools cover ranged viewing and batch editing, not the other changes.
- Cache breakpoint, tail, and decimation policies; downscaling beyond 20 images; custom model aliases/catalogs; full model IDs in Agent calls; session-only model picking; and the old effort environment-seed/session-override behavior.
- Billing labels, WSL file-link opening, child network-environment handoff, MCP plugin-style allowlist names, and LSP multi-server/filename routing.
- Compact-and-execute UI, Tab-to-queue, skill path invocation/global paths/activation notices, and skill/agent listing previews. Plan/memory diffs now use plugin UI rendering rather than native changes.
- Auto-dream bypass, the subagent CLAUDE.md inclusion gate, worker prompt rewrites, memory/dream wording, dash normalization, hiding `/security-review`, and the patched signature. Explore/Plan guidance now uses normal user-agent definitions instead of rewriting built-ins.

The optional [subscription-routing setup](docs/subscription-routing/README.md) supplies a config-file marker for per-worker alias resolution. It does not add a model picker/catalog or a `claudex --max-context` override, and does not require patching the official executable.

## Verification and memory containment

For development, install the pinned runtimes with `mise install` and dependencies with `bun install --frozen-lockfile`. Run checks sequentially:

```bash
bun run docs:check
bun run typecheck
bun run lint
bun run test
bun run verify:mods --binary /path/to/stock/claude --live
```

The live mod gate validates the shipped plugin, stages its engine tests, and drives real CLI sessions against a local Messages stub. It checks model-visible tool descriptions, both added tools, successful and failed batch edits, view behavior, disabled-tool denial, resume refresh, and task/fork modes. Unit tests or `claude --version` alone do not establish those behaviors. This is a maintainer gate, not an installation step. Claude Code's early-access mod API can change before the plugin is updated.

On Linux/WSL, heavy commands use a verified cgroup-v2 scope with at most **16 GiB aggregate RAM**, reduced to half available headroom, **zero swap**, and whole-group OOM termination. A working systemd user manager is required. Nested commands share the same budget; `CC_ENHANCED_MEMORY_MAX_MIB` can only lower it. Native extraction, bundle diffs, and prompt export remain memory-heavy even though patching is gone. Other platforms report that this wrapper provides no kernel memory limit. See [memory limits](docs/cli-reference.md#memory-limits).

## Documentation

| Guide | Use it for |
| --- | --- |
| [Getting started](docs/getting-started.md) | Install, update the plugin, uninstall, and understand runtime requirements. |
| [Configuration](docs/configuration.md) | Set saved defaults, wrapper prompt overrides, effort, and memory limits. |
| [CLI and inspection reference](docs/cli-reference.md) | Run setup, plugin updates, verification, native extraction, prompt export, and release diffs. |
| [Maintainer reference](docs/maintainer-reference.md) | Author mods, refresh declarations, review upstream releases, and maintain auditing tools. |
| [Subscription routing](docs/subscription-routing/README.md) | Maintain the optional Clodex routing setup and its separate client requirements. |

## Disclaimer

This project is not affiliated with, endorsed by, or connected to Anthropic, PBC or any of its affiliates. "Claude" and "Claude Code" are trademarks of Anthropic, PBC. cc-enhanced does not modify the Claude Code executable: it runs stock Claude Code with a plugin and shell-wrapper prompt options. Users remain responsible for compliance with applicable terms and use it at their own risk.

## License

[MIT](LICENSE)
