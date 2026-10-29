# Documentation

[Project overview](../README.md)

cc-enhanced runs stock Claude Code with a standard marketplace plugin and a shell PATH wrapper for system-prompt appends. `install.sh` handles setup without Bun or a build step; Claude Code updates itself. The executable is not modified. The tested upstream version is **2.1.312**; only the latest upstream form is maintained.

## Use cc-enhanced

| Goal | Guide |
| --- | --- |
| Install, update the plugin, or uninstall | [Getting started](getting-started.md) |
| Configure saved settings, shell prompt appends, and effort | [Configuration](configuration.md) |
| Find setup, verification, and inspection commands | [CLI and inspection reference](cli-reference.md) |
| Set up optional subscription routing | [Subscription routing](subscription-routing/README.md) |

## Maintain the mod and auditing tools

The [maintainer reference](maintainer-reference.md) covers mod authoring, declaration refreshes, live verification, release updates, native extraction, binary-format inspection, prompt exports, and memory containment. Read the hard rules in [AGENTS.md](../AGENTS.md) before maintenance work.

Stock prompt exports describe the upstream bundle. They do not include runtime mod changes or managed prompt appends. Use live mod verification to establish what the model actually receives.

## Legacy patch-based version

The archived native patcher is available on [`legacy/patcher-2.1.263`](https://github.com/camjac251/cc-enhanced/tree/legacy/patcher-2.1.263). Claude Code 2.1.263 is its last confirmed supported version; later checkpoints are not confirmed supported releases. Its patch catalog, target profiles, native lifecycle, and verification procedures do not apply to main. The [project overview](../README.md#what-changed-from-the-legacy-patcher) explains how to obtain the archive and lists behavior that was replaced or dropped.

## Documentation conventions

Use one logical line per prose paragraph. The formatter uses `proseWrap: never`; structural line breaks remain in code blocks, tables, lists, and blockquotes. Describe observable behavior rather than minified upstream implementation details. Keep examples aligned with `package.json` and distinguish inspected behavior from exercised runtime verification.

```bash
bun run docs:check
```
