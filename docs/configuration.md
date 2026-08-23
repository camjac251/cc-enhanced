# Configuration

[Documentation home](README.md) · [Patch catalog](patches.md) · [CLI reference](cli-reference.md)

This page separates patcher/maintainer controls from variables consumed by the installed patched runtime.

## Patcher and maintainer tooling

| Variable | Purpose |
| --- | --- |
| `CLAUDE_PATCHER_INCLUDE_TAGS` | Per-invocation comma-separated allowlist applied to the selected patch profile. Only listed patches run. |
| `CLAUDE_PATCHER_EXCLUDE_TAGS` | Per-invocation comma-separated blocklist applied after the allowlist. Listed patches are skipped. |
| `CLAUDE_PATCHER_REVISION` | Override the revision recorded in `.patch-meta.json` and the patched-build cache key. |
| `CLAUDE_PATCHER_CACHE_KEEP` | Retain extra cached builds beyond the default rotation. |
| `CLAUDE_PATCHER_PROFILE` | Set to `1` to emit per-phase and per-tag verify timings plus passive process-memory checkpoints to stderr during each patch run. |

## Runtime (installed binary)

| Variable | Consumed by | Default |
| --- | --- | --- |
| `CLAUDE_CODE_APPEND_SYSTEM_PROMPT_FILE` | [`sys-prompt-file`](../src/patches/sys-prompt-file.ts) | `/etc/claude-code/system-prompt.md` |
| `CLAUDE_CODE_BILLING_LABEL` | [`billing-label`](../src/patches/billing-label.ts) | unset; stock `API Usage Billing` fallback |
| `CLAUDE_CODE_FILE_OPEN_MODE` | [`file-link-targets`](../src/patches/file-link-targets.ts) | `auto` |
| `CLAUDE_CODE_FILE_OPENER` | [`file-link-targets`](../src/patches/file-link-targets.ts) | unset |
| `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` | [`limits`](../src/patches/limits.ts) | 50000 |
| `CLAUDE_CODE_CONFIGURED_MODEL_CATALOG` | [`configured-model-catalog`](../src/patches/configured-model-catalog.ts) | unset; JSON array of model metadata entries |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | [`model-context-metadata`](../src/patches/model-context-metadata.ts) | unset |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | [`model-context-metadata`](../src/patches/model-context-metadata.ts) | fallback for custom models without valid discovered metadata |
| `CLAUDE_CODE_AUTO_MODE_MODEL` | [`model-aliases`](../src/patches/model-aliases.ts) | unset; stock auto-mode classifier selection |
| `CLAUDE_CODE_MODEL_ALIASES` | [`model-aliases`](../src/patches/model-aliases.ts) | unset; JSON object mapping aliases to provider model IDs |
| `CLAUDE_CODE_MODEL_PICKER_SESSION_ONLY` | [`model-picker-session-only`](../src/patches/model-picker-session-only.ts) | unset; any present value enables session-only selection |
| `CLAUDE_CODE_SUBAGENT_MODEL` | [`subagent-model-tag`](../src/patches/subagent-model-tag.ts) | unset |

`CLAUDE_CODE_BILLING_LABEL` changes only the fallback text shown by the client when it cannot infer an account plan through its own authentication state. It does not select a credential or change how a provider charges a request. Scope it to the launcher that needs the clarification rather than placing it in shared Claude settings.

`file-link-targets` leaves stock `file:///...` hyperlinks intact and changes only their click dispatch. In `auto` mode, Linux runtimes with `WSL_INTEROP`, `WSL_DISTRO_NAME`, or `WSLENV` invoke `wslview` with the decoded path as one direct argument; no shell command is constructed. `wslview` must be available on `PATH`. This hands files and directories to their registered Windows applications. Outside WSL, `auto` preserves the stock file-manager behavior. Set `CLAUDE_CODE_FILE_OPEN_MODE=stock` or `off` to force stock behavior, `wslview` to force `wslview`, or `vscode` to run `code --reuse-window <path>`. In `auto` mode, `CLAUDE_CODE_FILE_OPENER` selects a custom executable before WSL detection; explicit `stock`, `off`, `wslview`, and `vscode` modes take precedence over it. Once an enhanced opener is attempted, its result is final, preventing a failed command from causing a second application or folder launch. Failures use the stock warning channel and report only the opener kind plus a numeric exit code or a generic exception label, never the target path.

`autoDreamEnabled` is a Claude Code setting rather than an env var. When it is explicitly `true`, `session-mem` lets auto-dream run even if the server-side availability flag is off.

When gateway model discovery is enabled, Claude Code manages its model-capability cache under its configured cache directory. Do not edit that cache directly. Matching positive safe-integer `max_input_tokens` values take precedence over `CLAUDE_CODE_MAX_CONTEXT_TOKENS`; the environment value remains the startup, offline, and unknown-model fallback.

`CLAUDE_CODE_CONFIGURED_MODEL_CATALOG` is a JSON array such as `[{"id":"provider/model","displayName":"Model","description":"Subscription route","maxInputTokens":258400,"maxOutputTokens":128000,"effortLevels":["low","medium","high","xhigh","max"],"defaultEffort":"medium"}]`. IDs are trimmed, unique case-insensitively, and cannot replace native aliases or contain `[1m]`. Context windows must be positive safe integers up to 1M; output limits must be safe integers from 4096 through 1M. Optional `autoCompactWindow` must be a safe integer from 100000 through 1M and strictly below that entry's `maxInputTokens`, matching the range the stock auto-compaction setting accepts; a value at or above the window would never compact, so it is rejected rather than silently ignored. Optional `effortLevels` must be duplicate-free, contain the native `low`, `medium`, and `high` base levels, and may additionally contain `xhigh` or `max`. `defaultEffort`, when set, must be one of that entry's declared levels. An exact configured match is available even when gateway discovery is off, but the catalog does not activate or consult unrelated cached gateway entries. Picker rows still obey stock `availableModels` policy, so include the canonical provider ID in that allowlist when one is configured.

Catalog effort metadata controls the native per-model `/effort` gates and default. It is sufficient for ordinary `xhigh` and `max` selection when the route preserves those provider values. The separate `effort-stack` patch is only for combining `max` with ultracode workflow orchestration. Provider effort values that Claude Code cannot represent in its selector or session state are not advertised through the catalog.

`CLAUDE_CODE_MODEL_ALIASES` is alias indirection, not an allowlist bypass. Its value is a JSON object such as `{"sol":"provider/model"}`. Keys are trimmed and matched case-insensitively. The map fails fast when it is malformed, has distinct keys that collide after normalization, replaces a native alias or `inherit`, includes `[1m]`, uses an empty or non-string target, or chains one alias to another. Exact duplicate JSON keys follow normal `JSON.parse` last-value semantics. Each resolved target still goes through stock model normalization and must be admitted by `availableModels`. Aliases work with `--model`, Agent `model`, Workflow `agent({model})`, agent frontmatter, resume, explicit teammate selection, and `CLAUDE_CODE_AUTO_MODE_MODEL`. Aliases alone do not add `/model` rows; use `CLAUDE_CODE_CONFIGURED_MODEL_CATALOG` when a launch also needs friendly picker entries and per-model capability metadata.

`CLAUDE_CODE_AUTO_MODE_MODEL` changes only the model attached to auto-mode classifier requests after auto mode is available and active. It accepts the same native aliases, configured aliases, and admitted provider model IDs as the normal model selector. Unset or empty values preserve the classifier selected by the upstream client. The override does not enable auto mode, bypass its model or account eligibility checks, or change permission behavior outside auto mode. Selecting the same model for the main session and classifier removes the independent-model boundary, so scope the variable to an explicit launcher instead of shared settings.

`CLAUDE_CODE_MODEL_PICKER_SESSION_ONLY` is intended for launch-scoped wrappers that share a settings directory with normal Claude Code. With the variable present, `/model` changes the current session without overwriting the default used by future normal launches.

Alias resolution is runtime plumbing, not a routing policy. A launch-scoped system prompt can teach an orchestrator when to select a configured alias without changing normal launches that use the same patched binary. Forks continue to inherit the parent model, and `CLAUDE_CODE_SUBAGENT_MODEL` is unnecessary for per-call alias selection.

Do not set `DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, or `DISABLE_GROWTHBOOK`. They disable feature-flag evaluation and the server-side flags that depend on it, including features this patcher relies on and the upstream Remote Control surface. Use the individual `DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER`, and `DISABLE_BUG_COMMAND` switches instead.
