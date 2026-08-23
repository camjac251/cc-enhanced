# Documentation

[Project overview](../README.md)

cc-enhanced documentation is organized by task. The root README is the public landing page; operational detail lives here so release status, patch behavior, and maintainer internals do not compete for attention.

## Use the patched CLI

| Goal | Guide |
| --- | --- |
| Install dependencies, patch the current release, verify activation, or roll back | [Getting started](getting-started.md) |
| Understand every registered patch and its exact effect | [Patch catalog](patches.md) |
| Configure patch selection, runtime variables, models, file opening, and prompt policy | [Configuration](configuration.md) |
| Run lifecycle, evidence, prompt-export, inspection, or release-diff commands | [CLI and inspection reference](cli-reference.md) |

## Work with other targets

| Goal | Guide |
| --- | --- |
| Construct or inspect Desktop, Remote Control, and self-hosted candidates without overstating live support | [Target workflows](target-workflows.md) |
| Configure the optional direct-plus-mixed-model launcher setup | [Subscription routing](subscription-routing/README.md) |

Reserved target profiles are intentionally separate from the supported `cli-full` profile. Structural candidates, matching-host execution, stock-client presentation, and live control-plane behavior are different evidence classes; a passing earlier class never implies a later one.

## Maintain the patcher

The [maintainer reference](maintainer-reference.md) owns architecture, binary-format constraints, command internals, patch authoring, traversal interactions, prompt exports, drift verification, release cadence, and testing. Repository-specific safety invariants also live in `AGENTS.md` and must be followed before native lifecycle or release work.

The most useful source entrypoints are:

| Area | Files |
| --- | --- |
| Patch contract and execution | [`src/types.ts`](../src/types.ts), [`src/patch-runner.ts`](../src/patch-runner.ts), [`src/ast-pass-engine.ts`](../src/ast-pass-engine.ts) |
| Patch registry and metadata | [`src/patches/index.ts`](../src/patches/index.ts), [`src/patch-metadata.ts`](../src/patch-metadata.ts) |
| Native lifecycle | [`src/manager.ts`](../src/manager.ts), [`src/native.ts`](../src/native.ts), [`src/bun-format.ts`](../src/bun-format.ts) |
| Target capabilities and profiles | [`src/profiles/`](../src/profiles/), [`src/targets/`](../src/targets/), [`src/operations/`](../src/operations/) |
| Prompt policy and verification | [`src/patches/prompt-policy.ts`](../src/patches/prompt-policy.ts), [`src/verification/`](../src/verification/) |

## Documentation conventions

Markdown prose uses one logical line per paragraph. Long prose lines are intentional: the formatter is configured with `proseWrap: never`, and Markdown line-length linting is disabled. Structural line breaks remain in code blocks, tables, lists, blockquotes, and other syntax where a newline changes rendering or meaning.

Internal relative links are preferred so documentation works from a checkout and on GitHub. The live patch registry remains the patch-count source of truth; when its count changes, update the root badge, root summary, and [patch catalog](patches.md) together.
