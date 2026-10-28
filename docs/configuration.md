# Configuration

[Documentation home](README.md) · [Getting started](getting-started.md) · [CLI reference](cli-reference.md)

There is no patch selection or native profile configuration on main. cc-enhanced uses stock Claude Code settings, a standard marketplace plugin, and a shell PATH wrapper. The [legacy patcher revision](../README.md#what-changed-from-the-legacy-patcher) retains the old configuration for historical reference.

## Setup and paths

`./install.sh` is the only installer. It accepts `--source <dir|owner/repo|git-url>`, `--prompt-file <path>`, `--no-shell`, `--no-settings`, `--no-agents`, or `--uninstall`. See [Getting started](getting-started.md#setup-options) for the full setup contract.

| Path or variable | Purpose |
| --- | --- |
| `${XDG_DATA_HOME:-~/.local/share}/cc-enhanced/bin/claude` | Generated shell wrapper. The official executable is left in place. |
| `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json` | Saved settings; setup adds only unset defaults unless `--no-settings` is used. |
| `${CLAUDE_CONFIG_DIR:-~/.claude}/agents/{Explore,Plan}.md` | Read-only user-agent defaults, installed only when no definition with the same frontmatter name exists. `--no-agents` skips them. |
| `~/.bashrc`, plus `~/.bash_profile` on macOS | Marked PATH blocks, unless `--no-shell` is used. |
| `${ZDOTDIR:-~}/.zshrc` | Marked PATH block when zsh is installed or the file exists. |
| `~/.config/fish/conf.d/cc-enhanced.fish` | PATH setup when fish is installed or the directory exists. |

Open a new shell after setup. Rerunning keeps one marked block; uninstall removes the blocks, fish file, wrapper directory, plugin, marketplace, and unchanged installer-owned agent defaults. Custom, modified, or user-symlinked agent files and saved settings stay in place. Agent-default snapshots live under the cc-enhanced data directory so setup can distinguish its files from user edits. There is no installed executable cache or binary restore record.

## Saved settings

With `jq`, setup adds the following defaults only when each key is unset:

| Setting | Default |
| --- | --- |
| `ultracode` | `true` |
| `promptCacheTtl` | `"1h"` |
| `subagentPromptCacheTtl` | `"1h"` |
| `env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` | `"50000"` |
| `extraKnownMarketplaces.cc-enhanced.autoUpdate` | `true` on the marketplace entry created by Claude Code |

An explicit user value is never replaced, including `false`. Without `jq`, setup prints a settings snippet instead. Edit your saved Claude Code settings to change these defaults; the wrapper does not inject settings. Stock `--settings <json-or-file>` remains available for per-run settings:

```bash
claude --settings '{"promptCacheTtl":"5m","subagentPromptCacheTtl":"5m","ultracode":true}'
```

Ultracode still needs workflows and a supported model. Interactive toggles remain session-only. The Read output-token budget does not change Read's schema.

## Wrapper controls

The wrapper runs the first real `claude` later on PATH and prepends `--append-system-prompt-file <prompt>`. For print-mode launches (`-p`/`--print`), it also passes `--append-subagent-system-prompt-file <prompt>` and enables that stock option with `CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT=1` unless explicitly set otherwise. Stock accepts but does not deliver the subagent append in interactive sessions. There, the wrapper instead sets a private file marker; the plugin reads that selected file at `SubagentStart` and supplies **additional message context, not system-role text**. Forks reuse the parent's context.

Each append family backs off when the caller supplies its own option. An unreadable file or `CC_ENHANCED_DISABLE=1` skips wrapper additions, and the marker is cleared at each wrapper invocation to prevent inherited values from leaking into nested launches. Without the wrapper's marker, the subagent hook does nothing. `claude update` still runs Claude Code's own updater.

| Control | Behavior |
| --- | --- |
| `./install.sh --prompt-file <path>` | Selects the default prompt file at setup; otherwise `/etc/claude-code/system-prompt.md`. |
| `CC_ENHANCED_PROMPT_FILE` | Overrides the prompt file for a run. |
| `CC_ENHANCED_DISABLE=1` | Runs the real Claude Code without wrapper additions. The plugin and saved settings still apply. |

```bash
CC_ENHANCED_PROMPT_FILE=/path/to/policy.md claude
CC_ENHANCED_DISABLE=1 claude
CC_ENHANCED_DISABLE=1 claude --safe-mode
```

Disable the plugin in `/plugin` when you do not want its behavior, or start with `--safe-mode` to omit plugins. Bypassing the wrapper alone does not disable it.

## Updates

Claude Code updates itself. Setup warns if `DISABLE_AUTOUPDATER=1` or `DISABLE_UPDATES=1` is set in the environment or settings `env` block, but does not edit those values.

For GitHub/git marketplace sources, `autoUpdate` enables plugin updates; `FORCE_AUTOUPDATE_PLUGINS=1` is also needed if `DISABLE_AUTOUPDATER` is set. For a local source, pull the checkout, run `claude plugin update cc-enhanced@cc-enhanced` or rerun `./install.sh`, then `/reload-plugins` or start a new session. The checkout remains the marketplace source, not an executable-update command.

## Managed prompts and client surfaces

Detailed global policy belongs in managed files such as `/etc/claude-code/system-prompt.md`, not copied into the plugin. Setup does not create or copy that policy. The parent and subagent appends use the same resolved file by default. A replacement `--system-prompt` does not by itself suppress the wrapper's append; pass your own append option to take ownership of that layer.

Only shells that read the setup PATH block go through the wrapper. Desktop, VS Code, and other clients launching their own Claude Code still load the user-scope plugin and saved settings, but do not receive the wrapper's system-prompt appends.

Mod hooks supply concise session guidance and tool descriptions, with stronger CLAUDE.md framing where stock Claude Code supplies that context. They do not restore the legacy subagent CLAUDE.md inclusion override or rewrite every built-in agent prompt. Setup's Explore/Plan files use normal user-agent precedence, inherit the parent model, keep repository instructions, and restrict the shipped defaults to read-only tools and plan permissions. Existing user definitions keep all their own settings. A stock prompt export cannot show runtime additions; verify the actual launch shape when changing prompt composition. In organization-managed sessions, prompt hooks from user-installed plugins may be skipped; the interactive subagent append then requires an organization-approved plugin.

## Effort and models

Use the stock `effortLevel` setting for the default effort, up to `xhigh`. `CLAUDE_CODE_EFFORT_LEVEL=max` selects maximum effort but locks `/effort`; it does not provide the legacy environment-seed plus session-override behavior. Model support and workflows still constrain available choices.

cc-enhanced does not implement `CLAUDE_CODE_MODEL_ALIASES`, `CLAUDE_CODE_CONFIGURED_MODEL_CATALOG`, a model picker, or an expanded Agent schema. In an opted-in routed launch, `CC_ENHANCED_AGENT_ROUTING_CONFIG` names the Clodex config whose `modelAliases` entries map to canonical `clodex:<providerId>:<modelId>` IDs at `agent.spawn`. Only explicitly requested configured aliases are rewritten. Full IDs, unknown models, stock aliases, forks, resumed agents, and omitted model choices retain stock behavior.

Use Workflow `agent(prompt, { agentType, model: "luna", effort: "max" })` for per-worker routing. The built-in Agent tool still accepts only stock model aliases; do not send it arbitrary routed IDs. The hook changes only the model, preserving the selected agent type, task, and stock effort handling. See the [subscription-routing guide](subscription-routing/README.md).

## Mod tool policy

The mod's policy is fixed rather than selected through environment tags:

- `mcp__cc-enhanced__batch_edit` edits without a prior Read, matching every `old_string` against the file's current content and refusing the whole batch if one is missing or ambiguous. Each change is one real Edit call, so Edit's permission prompts and hooks apply. A mid-batch rollback restores file bytes directly, without a permission prompt or rewind record, and does not undo transcript side effects.
- `mcp__cc-enhanced__view` adds numbered text ranges and whitespace rendering. Its 4 MiB input limit and output caps are independent of the stock Read token setting.
- Glob, Grep, WebSearch, WebFetch, and NotebookEdit are denied and receive routing-only deferred descriptions.
- `statusline-setup` and `claude-code-guide` are hidden from agent discovery; transcript tool groups are expanded.
- Plan/memory Edit and Write rows show one full-path diff from the stored result, without rereading the file. Custom plan/memory roots and engine-reported paths are recognized. Errors, staged writes, unchanged output, unavailable patches, and diffs beyond the UI drawing limit remain stock.

Disable the plugin in `/plugin` or use `--safe-mode` when you need behavior without the mod. Do not send mod-only parameters to built-in Read or Edit.

## Maintenance memory limits

`CC_ENHANCED_MEMORY_MAX_MIB` accepts an integer from 64 to 16384 and only lowers the Linux/WSL process-tree limit. The effective ceiling is also reduced to half available headroom. It cannot disable containment or give a nested command another budget.

```bash
CC_ENHANCED_MEMORY_MAX_MIB=2048 bun run prompts:export <version> --output-dir /tmp/prompts-review
```

These limits apply to repository maintenance commands, not normal installed Claude sessions. See [memory limits](cli-reference.md#memory-limits) for systemd/cgroup requirements and failure behavior.

Avoid `DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, and other broad traffic-disabling switches when server-controlled features are required. Prefer individual `DISABLE_*` controls.
