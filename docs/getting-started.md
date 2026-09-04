# Getting started

[Documentation home](README.md) · [Patch catalog](patches.md) · [CLI reference](cli-reference.md)

The primary supported workflow patches the latest Claude Code native executable into a repository-managed local build, verifies every selected patch, and promotes the result through an atomic symlink swap. It does not modify or redistribute an upstream package in this repository.

## Requirements

- **Bun 1.4.0**, installed from the release pinned in [`mise.toml`](../mise.toml).
- **mise**, used as the task runner and runtime installer.
- **Linux x86_64** for the primary local lifecycle. Other native formats have separate structural and matching-host evidence boundaries documented under [target workflows](target-workflows.md).
- A working **Claude Code** installation.
- A local policy file at `/etc/claude-code/system-prompt.md`, or `CLAUDE_CODE_APPEND_SYSTEM_PROMPT_FILE` set to the prompt file that should be appended automatically.

The current validated upstream target is **Claude Code 2.1.260**. cc-enhanced supports the latest upstream form only; older releases do not receive compatibility fallbacks.

## Install the repository tooling

```bash
mise install
bun install --frozen-lockfile
```

`mise install` resolves the exact Bun release tag and installs Lefthook. The frozen Bun install must complete without changing `bun.lock`.

## Patch and activate the latest release

```bash
mise run native:update

claude --version
mise run status
```

`native:update` fetches the official native release, constructs a separate candidate, rebundles split JavaScript modules when present, applies and verifies the selected patch profile, repacks without changing the original byte length or virtual-address layout, and promotes the candidate only after every gate passes.

The active version string includes `patched:` followed by the exact runtime patch tags. `mise run status` shows the current, previous, and cached builds.

## Roll back

```bash
mise run native:rollback
```

Rollback atomically exchanges the `current` and `previous` symlink targets. It does not reinstall or rebuild the previous candidate.

## Select a patch subset

The default `cli-full` profile selects all 44 registered patches. Use per-invocation environment variables when a build needs an explicit subset:

```bash
CLAUDE_PATCHER_INCLUDE_TAGS=read-bat,limits,edit-extended mise run native:update
CLAUDE_PATCHER_EXCLUDE_TAGS=tools-off,agents-off mise run native:update
```

The include list is an allowlist, the exclude list is applied afterward, and exclusion wins if a tag appears in both. Profile selection is resolved anew for each invocation. See the [patch catalog](patches.md) for exact effects and the [configuration guide](configuration.md) for every variable.

## Runtime tooling assumptions

Several prompt patches intentionally route Claude Code away from the stock `find`/`grep`/`cat`/`head`/`tail` workflow. Keep these commands on `PATH` when the corresponding guidance is enabled:

| Tool | Purpose |
| --- | --- |
| `bat` | Range-based file viewing with `bat -r START:END`; the patched Read tool handles known ranges directly. |
| `fd` | File discovery. |
| `eza` | Directory listing. |
| `rg` | Exact lexical search across code, comments, configuration, logs, and prompt artifacts. |
| `ast-grep` | Structural code search and AST-aware rewrites. |
| `sd` | Literal or regular-expression replacement in non-code text. |
| `gh` | GitHub URL and API workflows through `gh api`. |
| `jq` / `yq` | Structured JSON and YAML inspection. |

The prompt policy also names optional symbol, semantic-search, and documentation integrations. The patched CLI remains usable without every integration, but routing quality depends on the tools actually available in each workspace. See [configuration](configuration.md) for model and runtime controls and the [maintainer reference](maintainer-reference.md) for authoring rules.

## Important traffic settings

Do not set `DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, or `DISABLE_GROWTHBOOK`. Those broad switches also disable server-controlled features and feature-flag evaluation. Use individual settings such as `DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER`, and `DISABLE_BUG_COMMAND` instead.

## Verification levels

| Gate | What it proves |
| --- | --- |
| `bun run typecheck` | TypeScript contracts compile. |
| `bun run lint` | Repository TypeScript and scripts satisfy Biome. |
| `bun run test` | Every test file passes through the memory-bounded serial runner. |
| `mise run verify:patches` | The current real native target patches without promotion, required prompt surfaces verify, and prompt drift passes. |
| `claude --version` plus `mise run status` | The promoted local launcher points to the expected verified build. |

Fixture tests are necessary but do not prove a live upstream bundle. Run the real patch gate before describing a patch or release update as compatible.

## Other targets

Desktop-local, Remote Control, and self-hosted runner profiles are reserved. Use their build-only and evidence commands from [target workflows](target-workflows.md); do not treat an offline candidate or structural receipt as authorization to activate a Desktop-managed artifact, launch Remote Control, register a runner, publish an image, or claim stock-client compatibility.
