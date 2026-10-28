# CLI and inspection reference

[Documentation home](README.md) · [Getting started](getting-started.md) · [Maintainer reference](maintainer-reference.md)

`install.sh` owns user setup; no Bun or build step is needed to install or run the plugin. For development, `package.json` is the canonical command table and `mise.toml` mirrors it as a thin task index. Use `mise run <task> -- ...` when forwarding arguments through mise. Run heavy maintenance commands sequentially, including across terminals.

## Setup and updates

```bash
./install.sh [--source <dir|owner/repo|git-url>] [--prompt-file <path>] [--no-shell] [--no-settings] [--no-agents]
./install.sh --uninstall
claude update                                    # Official Claude Code update
claude plugin update cc-enhanced@cc-enhanced      # Refresh the installed plugin
```

Setup finds the real `claude` on PATH, adds or refreshes the marketplace, installs and updates the plugin, and writes `${XDG_DATA_HOME:-~/.local/share}/cc-enhanced/bin/claude`. The default source is the checkout's absolute path; `--source` selects another directory, GitHub repository, or git URL. `--prompt-file` selects the wrapper's prompt, defaulting to `/etc/claude-code/system-prompt.md`. `--no-shell` skips PATH blocks; `--no-settings` skips unset settings defaults; `--no-agents` skips the non-overwriting Explore/Plan user-agent installation. Open a new shell after setup.

The wrapper appends the readable prompt to parent and subagent contexts only for launches through its PATH entry. Plugin loading and saved settings apply across Claude Code surfaces. `CC_ENHANCED_PROMPT_FILE` overrides the prompt per run; `CC_ENHANCED_DISABLE=1` bypasses the wrapper without disabling the plugin. See [configuration](configuration.md) for explicit append overrides, settings, and shell paths.

Claude Code updates itself; there is no cc-enhanced binary lifecycle or restore record. GitHub/git plugin sources can auto-update. For a local source, pull the checkout and update the plugin or rerun setup, then use `/reload-plugins` or a new session. Setup warns if `DISABLE_AUTOUPDATER=1` or `DISABLE_UPDATES=1` is set in the environment or settings `env` block; it does not edit those values. Plugin auto-update needs `FORCE_AUTOUPDATE_PLUGINS=1` if `DISABLE_AUTOUPDATER` is set.

Uninstall removes the plugin, marketplace, wrapper directory, shell blocks, and fish file. It leaves saved settings in place. See [Getting started](getting-started.md#files-and-settings-changed) for the exact changes.

## Plugin verification

Claude Code loads `plugin/hooks/*.ts` directly. There is no plugin build command.

```bash
bun run verify:mods --binary /path/to/latest-stock/claude
bun run verify:mods --binary /path/to/latest-stock/claude --live
bun run verify:minimum                       # Validation and engine tests on the declared oldest version
bun run docs:check
bun run typecheck
bun run lint
bun run test
```

`verify:mods` stages `plugin/` exactly as shipped, adds `mods/tests/` to the temporary test copy, validates it with `claude plugin validate --strict`, and runs `claude plugin test`. `--live` additionally drives real stock CLI sessions against a local Messages stub with `--plugin-dir`. `verify:minimum` downloads the version in `plugin.json`'s `metadata.minimumClaudeCodeVersion` and runs the same checks without `--live`, because live checks assert the latest release's prompt wording. Setup does not run these maintainer gates.

The live checks cover model-visible descriptions, both registered tools, successful batch editing and failure without changed file bytes, ranged viewing, disabled-tool denial, persisted resume description refresh, and default/legacy task modes with fork on/off. They do not make provider requests or prove client-specific behavior in an IDE extension or Desktop. Use the latest **stock executable**, not the shell wrapper, as `--binary`; on the standard Linux install, resolve it with `readlink -f ~/.local/bin/claude`.

## Native extraction and release inspection

These commands fetch or read official artifacts for analysis. They do not modify or install executables. Download-cache eviction protects the targets of the official `~/.local/bin/claude` and `~/.local/share/claude/versions/{current,previous}` paths.

```bash
bun run changelog                        # Upstream changes after the README's tested version
bun run changelog --since <version>      # Or after any version; --until bounds the newest
bun run changelog --match 'plugin|mod'   # Only entries matching a case-insensitive regex
bun run native:fetch <version>
bun run native:pull <version>
bun run native:unpack <binary> <output.js>
```

`changelog` reads Claude Code's published `CHANGELOG.md` from the `anthropics/claude-code` repository and prints the releases newer than the version in the README's tested badge. `--file <path>` reads a saved copy instead.

`native:pull` writes clean JavaScript to `versions_clean/<version>/cli.js`. Split embedded modules are combined into an inspection surface when necessary; the result is not an executable replacement. Use only the immediate previous clean release as the baseline for latest-release maintenance.

The inspector parses a bundle once and can run multiple queries:

```bash
bun run inspect search versions_clean/<version>/cli.js "You are Claude Code" "Read a file" \
  --json --limit 5 --breadcrumb-depth 10 --object
bun run inspect search versions_clean/<version>/cli.js '^read$' --regex --ignore-case --field string
bun run inspect prompts versions_clean/<version>/cli.js "Command sandbox" --context 2
```

Use `rg` for quick literal searches in `cli.js`, not `ast-grep`. Use the inspector for ranked AST matches, value-kind filters, object context, byte spans, breadcrumbs, scopes, and JSON output. Keep upstream minified identifiers and reconstructed implementation names out of public reports.

## Bundle diffs

```bash
bun run diff -- versions_clean/<old>/cli.js versions_clean/<new>/cli.js --limit 20
bun run diff -- versions_clean/<old>/cli.js versions_clean/<new>/cli.js --focus commands
bun run diff -- versions_clean/<old>/cli.js versions_clean/<new>/cli.js --focus settings
bun run diff -- versions_clean/<old>/cli.js versions_clean/<new>/cli.js --focus env
bun run diff -- versions_clean/<old>/cli.js versions_clean/<new>/cli.js --focus rewrites --markdown
bun run diff -- versions_clean/<old>/cli.js versions_clean/<new>/cli.js \
  --prompt-export /tmp/prompts-<new> --focus prompts
bun run diff -- matrix versions_clean/<v1>/cli.js versions_clean/<v2>/cli.js versions_clean/<v3>/cli.js --cache
```

The default comparison groups stable bundle surfaces rather than raw minified text: commands and nearby flags, settings writes, environment variables, routes, prompt-like strings, reminders, and text rewrites. Matrix mode attributes changes to adjacent releases. `--cache` reuses extracted surfaces; it is not verification evidence by itself. `bun run diff -- ast <old.js> <new.js>` provides AST-node comparison when needed.

Keep optional `bundle-diff.config.json` rules focused on durable public surfaces or local noise:

```json
{
  "ignoreTokens": ["placeholder"],
  "ignorePrefixes": ["[debug]"],
  "highSignalTokens": ["gateway", "purge"]
}
```

## Prompt artifacts

Prompt exports require an explicit clean version or bundle path. They describe **stock bundle text**, not runtime mod guidance or managed prompt appends.

```bash
bun run prompts:export <version> --output-dir /tmp/prompts-<version>
bun run prompts:export versions_clean/<version>/cli.js --label <version>-review \
  --output-dir /tmp/prompts-<version>-review --max-uncategorized 200
bun run prompts:bundle <version> --output-dir /tmp/prompts-<version>-bundle
bun run prompts:compare /tmp/prompts-<old> /tmp/prompts-<new> /etc/claude-code
bun run prompts:compare:matrix /tmp/prompts-<old> /tmp/prompts-<new> /etc/claude-code
```

Both comparison commands take baseline export, candidate export, and managed-policy directory. The matrix report adds interpolation-dependency comparison to stock release review; it no longer takes paired clean/modified exports. Use `--json` for machine-readable output or `--output <file>` to save a report. A comparison report identifies differences, not whether runtime behavior is correct.

| Artifact | Purpose |
| --- | --- |
| `manifest.json` | Input path, generated files, counts, and quality metadata. |
| `tools/builtin/*.md`, `agents/*.md`, `system/sections/*.md` | Human-reviewable stock prompt inventories. |
| `corpus-categorized.json`, `corpus-summary.json` | Corpus grouping and coverage. |
| `prompt-corpus.json` | Prompt entries and hashed interpolation dependencies. |
| `workflows/README.md`, `workflows.json` | Workflow/orchestration inventory linking to canonical prompt files. |

Static inventories can include conditional alternatives and unresolved runtime values. `--max-uncategorized <n>` imposes a coverage budget when appropriate; it does not turn an inventory into a captured model request. Regenerate older hashless exports with the current exporter before dependency comparison. Keep scratch exports in an OS-temp workspace, not `versions_clean/`.

`bun run harness:map` is retained for harness inspection. See the [maintainer reference](maintainer-reference.md#prompt-extraction) for extraction semantics and artifact coverage.

## Memory limits

On Linux/WSL, heavy aliases and `bun run test` use `scripts/run-memory-limited.ts`. It creates a verified systemd user scope with a cgroup-v2 aggregate RAM limit, zero swap, and whole-group OOM termination. Nested commands share that scope rather than receiving independent budgets. The wrapper stops its owned scope on completion or interruption so descendants do not continue running.

The ceiling is the smaller of **16 GiB** and **half available headroom**, accounting for `/proc/meminfo` and finite ancestor cgroup limits. `CC_ENHANCED_MEMORY_MAX_MIB` accepts an integer from **64 to 16384** and can only lower it. Set the value on the outer command; a nested command cannot escape its inherited scope for another budget.

```bash
CC_ENHANCED_MEMORY_MAX_MIB=2048 bun run test
bun run bounded -- bun test src/heavy-operation-guard.test.ts
bun run bounded -- bun --smol path/to/investigation.ts
```

Linux requires cgroup v2 with the memory controller and a working systemd user manager. If the wrapper cannot establish and verify the controls from the kernel, heavy work is refused. An environment marker is not proof of containment. macOS and Windows explicitly report that this runner does not provide a kernel memory limit there.

Native extraction, diffing, prompt export, and full tests remain potentially expensive. The heavy-operation lease serializes guarded work; it does not authorize concurrent launches. A killed process or failed verifier is not a passing gate: do not retry unbounded or publish on that evidence. Limits cover the maintenance command's process tree, not unrelated applications, external daemons, or ordinary Claude Code sessions.
