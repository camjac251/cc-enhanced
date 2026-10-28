# Getting started

[Documentation home](README.md) · [Configuration](configuration.md) · [CLI reference](cli-reference.md)

cc-enhanced installs a standard marketplace plugin and a PATH wrapper for system-prompt appends. Claude Code remains the official, unmodified installation and updates itself. The current tested release is **2.1.312**. The project targets the latest upstream form, without older-version compatibility fallbacks.

## Requirements

- macOS or Linux, Bash, and Git.
- Official Claude Code 2.1.300 or later on PATH, with normal authentication for your own sessions. When installing from this checkout, setup refuses an older version and tells you to run `claude update`. Another `--source` revision may have a different minimum. This minimum supports workflow `agent.spawn` routing; maintainers still target and live-test only the latest release.
- `jq` to add unset settings defaults automatically and to preserve marketplace update preferences when `--source` is used with existing settings. Without it, default setup prints a settings snippet for you to apply.

No Bun, mise, build step, or systemd setup is needed to install or run the plugin. Those development dependencies and memory-containment requirements apply only to repository maintenance commands.

## Install

```bash
curl -fsSL https://claude.ai/install.sh | bash
git clone https://github.com/camjac251/cc-enhanced.git
cd cc-enhanced
./install.sh
```

Open a new shell afterwards. The script finds the real `claude` on PATH, skipping its own wrapper directory. If it cannot find one, it stops and prints the official installation command.

Setup adds the `cc-enhanced` marketplace, installs `cc-enhanced@cc-enhanced`, and asks Claude Code to update the plugin. The default marketplace source is this checkout's absolute path. On rerun, setup refreshes the registered source unless `--source` explicitly selects a replacement. Claude Code loads the plugin's TypeScript directly; setup does not build a plugin, download a binary, or run maintainer verification.

### Setup options

```bash
./install.sh [--source <dir|owner/repo|git-url>] [--prompt-file <path>] [--no-shell] [--no-settings] [--no-agents]
./install.sh --uninstall
```

| Option | Effect |
| --- | --- |
| `--source <dir\|owner/repo\|git-url>` | Select a local marketplace directory, GitHub repository, or git URL, replacing the registered source if one exists. |
| `--prompt-file <path>` | Choose the wrapper's system-prompt file; default `/etc/claude-code/system-prompt.md`. Setup does not create the prompt. |
| `--no-shell` | Skip shell startup-file changes. The wrapper is still written, but setup does not put it on PATH. |
| `--no-settings` | Skip adding settings defaults. |
| `--no-agents` | Skip installing the Explore/Plan user-agent defaults. |
| `--uninstall` | Remove the plugin, marketplace, shell blocks, fish file, wrapper directory, and unchanged installer-owned agents. Leave custom agents and settings keys in place. |

### Files and settings changed

The wrapper is written to `${XDG_DATA_HOME:-~/.local/share}/cc-enhanced/bin/claude`; the official executable is not replaced.

Unless `--no-shell` is set, setup prepends that directory to PATH with one marked block (`# >>> cc-enhanced >>>` through `# <<< cc-enhanced <<<`) in:

- `~/.bashrc`, plus `~/.bash_profile` on macOS.
- `${ZDOTDIR:-~}/.zshrc` if zsh is installed or the file exists.
- `~/.config/fish/conf.d/cc-enhanced.fish` if fish is installed or that directory exists.

Rerunning setup keeps exactly one block. Uninstall removes the blocks, restoring the surrounding shell files byte-for-byte, and removes the fish file. If a block has malformed or missing markers, setup refuses to rewrite that shell file; repair the markers before rerunning it.

Unless `--no-settings` is set, setup uses `jq` to add only unset keys to `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`: `ultracode: true`, `promptCacheTtl: "1h"`, `subagentPromptCacheTtl: "1h"`, `env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: "50000"`, and `autoUpdate: true` in the marketplace entry created by Claude Code. Existing values, including an explicit `autoUpdate: false`, are preserved. Updates write through symlinks and preserve existing file permissions; settings that need no changes are not rewritten. Without `jq`, setup prints the snippet instead.

Unless `--no-agents` is set, setup installs `templates/agents/Explore.md` and `Plan.md` as bare user agents. It preserves existing definitions by frontmatter name, including differently named files in subdirectories. The shipped defaults inherit the parent model, keep repository instructions, and use read-only tools with plan permissions. Unchanged defaults refresh on setup reruns; modified ones are left alone. Their snapshot copies under the cc-enhanced data directory are only for detecting ownership during updates and uninstall.

The user-scope plugin, agent definitions, and saved settings apply across Claude Code surfaces, including Desktop and VS Code. Prompt appends apply only to shell launches that use the PATH wrapper. Parent prompts and print-mode subagents use stock system-prompt flags; interactive subagents receive the same selected file through the plugin as additional message context, not system-role text. Other clients launching their own executable do not receive those appends.

## Updates and uninstall

Claude Code updates itself independently. `claude update` remains the official update command; cc-enhanced does not intercept it.

For the default local-checkout source, pull repository changes, then run:

```bash
claude plugin update cc-enhanced@cc-enhanced
# Or rerun ./install.sh from the checkout.
```

Use `/reload-plugins` or start a new session afterwards. Keep the checkout available as the marketplace source.

For a GitHub/git source, plugin auto-update pulls new versions when the marketplace's `autoUpdate` setting is enabled. If `DISABLE_AUTOUPDATER` is set, plugin auto-updates also need `FORCE_AUTOUPDATE_PLUGINS=1`. Setup warns when `DISABLE_AUTOUPDATER=1` or `DISABLE_UPDATES=1` appears in your environment or settings `env` block; it does not change either setting. This setup relies on Claude Code updating itself. Its early-access mod API can change before the plugin is updated.

```bash
./install.sh --uninstall
```

There is no cc-enhanced binary update, rollback, restore, or status command, and no restore record. Uninstall leaves the settings defaults in place; review them separately if you no longer want them.

To bypass only the wrapper:

```bash
CC_ENHANCED_DISABLE=1 claude
```

The installed plugin and saved settings still apply. Disable the plugin in `/plugin`, or use `CC_ENHANCED_DISABLE=1 claude --safe-mode` to bypass the wrapper and omit plugins.

## Runtime tools and behavior

The mod adds `mcp__cc-enhanced__batch_edit` and `mcp__cc-enhanced__view`; it does not extend the built-in Edit or Read schemas. Stock Edit still asks for a prior Read; `batch_edit` does not, for one change or many. It matches every `old_string` against the file's current content and refuses the whole batch before any change if one is missing or ambiguous. Each change is a real Edit call, so Edit's permission prompts and hooks apply. In manual-approval mode each change asks separately; auto mode, the 2.1.312 default, does not prompt. A mid-batch rollback writes the original bytes back directly, without a permission prompt or a rewind record. View supports numbered UTF-8 text ranges for files up to 4 MiB; core Read remains the path for larger files, nontext content, and approval-required reads.

Prompt guidance prefers tools such as `fd`, `eza`, `rg`, `ast-grep`, `sd`, `gh`, `jq`, and `yq` when appropriate. Install the tools and optional semantic/symbol integrations you intend to use. Guidance does not install them or make an unavailable integration work. Glob, Grep, WebSearch, WebFetch, and NotebookEdit are denied by the mod, so review this policy before adopting it.

The [project overview](../README.md#what-changed-from-the-legacy-patcher) lists legacy behavior that is no longer available. In particular, this installation does not preserve native UI changes such as Tab-to-queue or custom model catalogs.

## Traffic settings

Avoid broad switches such as `DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, and `DISABLE_GROWTHBOOK`; they can disable server-controlled features. Use individual settings such as `DISABLE_ERROR_REPORTING` or `DISABLE_BUG_COMMAND` instead. Setup does not disable the stock updater.

## Verification levels

These are maintainer checks, not installation prerequisites. Install the pinned development runtimes with `mise install` and dependencies with `bun install --frozen-lockfile`, then run checks sequentially, never alongside another heavy operation:

| Gate | What it establishes |
| --- | --- |
| `bun run docs:check` | Markdown formatting passes. |
| `bun run typecheck` | TypeScript contracts compile. |
| `bun run lint` | Repository source satisfies Biome. |
| `bun run test` | Tests pass through the bounded, serial, isolated-file runner. |
| `bun run verify:mods --binary <stock-binary>` | Plugin validation and real mod-engine tests pass. |
| `bun run verify:mods --binary <stock-binary> --live` | Live stock CLI sessions expose the intended descriptions and tools, enforce disabled-tool policy, and preserve resume/task/fork behavior under the local stub. |
| `claude --version` | Identifies the running executable version, not whether the plugin works. |

Setup does not run these gates. See the [CLI reference](cli-reference.md) for inspection commands and [memory limits](cli-reference.md#memory-limits) for maintenance containment requirements.
