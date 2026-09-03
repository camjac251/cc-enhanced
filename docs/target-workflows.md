# Desktop, Remote Control, and self-hosted targets

[Documentation home](README.md) · [Getting started](getting-started.md) · [CLI reference](cli-reference.md) · [Maintainer reference](maintainer-reference.md)

cc-enhanced uses the same patch catalog and native build machinery for the standalone CLI, Desktop-local sessions, Remote Control hosts, and self-hosted runners, but it keeps each surface in a separate profile with explicit evidence boundaries.

> [!WARNING]
>
> An offline candidate is not a live compatibility result. Do not infer Desktop UI support, stock-client approval behavior, runner registration, or control-plane compatibility from a successful patch or structural receipt.

## Current target model

| Surface | Construction coverage | Ordinary selection | Live boundary |
| --- | --- | --- | --- |
| Standalone CLI | Latest official native release | `cli-full` is supported and selectable | Proven by `mise run verify:patches`, promotion, and runtime status. |
| Desktop-local | Receipt-bound inventory, artifact, SDK, permission-plan, preflight, and separate candidate workflows | Reserved | Stock and patched Read/Edit/tool approval, presentation, restart, and resume must be proven on each Desktop platform. |
| Remote Control | Eight official native host formats through a build-only profile, plus matching-host finalization and an explicit foreground launcher | Reserved | Every stock web, mobile, or Desktop client needs its own tool-input, approval, rendering, and reconnect evidence. |
| Self-hosted runner | Six Linux/macOS native formats, Linux x64 image construction, optional exec wrapper, and wrapper-image binding | Reserved | Organization eligibility, registration, runner-provided binary binding, child execution, deployment, and client qualification remain separate live gates. |

The surface catalog contains 45 classified entries: the 44 exact `cli-full` patches plus the profile-only `tools-off-desktop` variant. Desktop-local, Remote Control, and self-hosted each classify 30 entries as probe-required candidates and 15 as exclusions. None is silently promoted into the ordinary CLI registry.

## Evidence ladder

| Level | Evidence | What it proves | What it does not prove |
| --: | --- | --- | --- |
| 1 | Structural candidate | Official source identity, selected patch roster, fixed native layout, re-extraction, and co-located verifiers. | Matching-host execution, signing validity, or any client UI. |
| 2 | Matching-host receipt | The exact finalized candidate runs on the target OS/architecture and reports the exact runtime tags. | Desktop-managed integration, remote clients, or a live runner. |
| 3 | Stock-client probe | One named client correctly presents and approves Read, Edit, Write, and tool inventory behavior. | Another client, another platform, reconnect, or deployment. |
| 4 | Live control-plane receipt | One explicitly authorized Remote Control or self-hosted scenario completed within its declared boundaries. | General availability, all clients, or future upstream releases. |

Keep generated receipts under ignored `.cache/` paths or another explicit private location. They are per-run artifacts, not durable source fixtures and not a substitute for current verification.

## Desktop-local workflow

Desktop discovery has adapters for Windows, macOS, and Linux. Candidate construction is platform-neutral and binds to the exact platform, version, size, and SHA-256 carried by the validated receipt chain; Windows candidates additionally preserve the `.exe` suffix. No command accepts or discovers a Desktop-managed artifact as its mutation target.

### 1. Inspect without mutation

| Command | Purpose |
| --- | --- |
| `mise run desktop:status -- <args...>` | Produce a sanitized inventory of the selected Desktop installation and cached Code artifacts. |
| `mise run desktop:compare -- <args...>` | Compare two inventories and classify package, cache, selection, and replacement drift. |
| `mise run desktop:inspect -- <args...>` | Bind one cached artifact to inventory and official-release provenance without executing it. |
| `mise run profile:support -- --surface desktop-local --evidence` | Render the deterministic 30-candidate/15-exclusion support plan. |

### 2. Audit the public SDK and permission surface

```bash
mise run desktop:sdk-contract -- \
  --inventory .cache/desktop-target/inventory.json \
  --evidence

mise run desktop:permission-probe -- \
  --sdk-contract .cache/desktop-target/sdk-contract.json \
  --evidence
```

The SDK audit accepts only the exact inventory-declared package version, verifies registry integrity, and parses the public permission declarations structurally. The probe plan keeps permission input, Read/Edit/Write semantics, Desktop presentation, offered permission modes, restart, and resume as distinct facets.

### 3. Run the stock-only preflight

```bash
mise run desktop:permission-preflight -- \
  --inventory .cache/desktop-target/inventory.json \
  --artifact .cache/desktop-target/artifact.json \
  --sdk-contract .cache/desktop-target/sdk-contract.json \
  --probe-plan .cache/desktop-target/permission-plan.json \
  --profile-support .cache/desktop-target/profile-support.json \
  --evidence
```

The preflight recomputes canonical bindings, requires the artifact to equal the selected inventory row and official manifest bytes, distinguishes signature presence from matching-host validity, and keeps owner selection, consent, isolated fixtures, and cleanup preparation explicit. A blocked result is expected until those inputs exist.

### 4. Construct a separate candidate

```bash
mise run desktop:candidate -- \
  --inventory .cache/desktop-target/inventory.json \
  --artifact .cache/desktop-target/artifact.json \
  --sdk-contract .cache/desktop-target/sdk-contract.json \
  --probe-plan .cache/desktop-target/permission-plan.json \
  --profile-support .cache/desktop-target/profile-support.json \
  --stock-preflight .cache/desktop-target/stock-preflight.json \
  --stock-baseline .cache/desktop-target/stock-baseline.json \
  --candidate-root .cache/desktop-candidates \
  --evidence-output .cache/desktop-candidates/evidence/desktop-candidate.json
```

This lane creates clean and patched files as distinct ignored repository-local artifacts, verifies exact source and output identity, and emits a path-free receipt. It does not sign, execute, activate, launch Desktop, replace a managed cache entry, promote the profile, start Remote Control, or start a self-hosted runner.

## Remote Control workflow

Remote Control patches the standalone host binary, not a stock client application. Planning and diagnosis are read-only; construction and host finalization remain build-only; `remote:start` is the only command in this lane that starts the upstream foreground server.

### Plan and diagnose

```bash
mise run profile:support -- --surface remote-control --evidence
mise run remote:plan -- --evidence
mise run remote:doctor -- --json
```

The doctor reads no implicit settings path, exposes stable blocker IDs rather than values, and accepts bounded settings or host receipts only when supplied explicitly.

### Construct and finalize host candidates

```bash
mise run remote:artifacts -- \
  --version X.Y.Z \
  --cache-dir .cache/remote-control-native \
  --output .cache/remote-control-native/matrix.json

mise run remote:host -- \
  --matrix-receipt .cache/remote-control-native/matrix.json \
  --platform linux-x64 \
  --artifact .cache/remote-control-native/X.Y.Z/linux-x64/candidate \
  --staged-output .cache/remote-control-native/X.Y.Z/linux-x64/finalized \
  --receipt .cache/remote-control-native/X.Y.Z/linux-x64/host.json \
  --signing-policy not-required
```

The artifact matrix covers the official Linux glibc/musl x64/ARM64, macOS x64/ARM64, and Windows x64/ARM64 formats. Structural success on the current host does not execute foreign architectures or establish macOS/Windows signing validity; finalize each candidate on a matching host with the correct signing policy.

### Start one receipt-bound foreground host

```bash
mise run remote:start -- \
  --host-receipt .cache/remote-control-native/X.Y.Z/linux-x64/host.json \
  --binary .cache/remote-control-native/X.Y.Z/linux-x64/finalized \
  --workspace /absolute/path/to/trusted-workspace \
  --subscription-confirmed \
  --organization-not-required \
  --workspace-trusted \
  --workspace-kind git \
  --spawn worktree \
  --capacity 1 \
  --sandbox \
  --create-session-in-dir \
  --acknowledge-transcript-storage \
  --authorize-live-start
```

The launcher uses an argv array with `shell: false`, inherited stdio, and foreground waiting. It does not decode the upstream protocol, capture session output, persist a session URL, translate custom tool fields, or claim client compatibility.

## Self-hosted runner workflow

The self-hosted profile uses the same 30-candidate/15-exclusion stock-client policy but limits its structural native matrix to the six Linux and macOS runner formats. Windows deployment uses a Linux container rather than a native Windows runner artifact.

```bash
mise run profile:support -- --surface self-hosted-runner --evidence
mise run self-hosted:plan -- --evidence

mise run self-hosted:artifacts -- \
  --version X.Y.Z \
  --cache-dir .cache/self-hosted-native \
  --output .cache/self-hosted-native/matrix.json

mise run self-hosted:host -- \
  --matrix-receipt .cache/self-hosted-native/matrix.json \
  --platform linux-x64 \
  --artifact .cache/self-hosted-native/X.Y.Z/linux-x64/candidate \
  --staged-output .cache/self-hosted-native/X.Y.Z/linux-x64/finalized \
  --receipt .cache/self-hosted-native/X.Y.Z/linux-x64/host.json \
  --signing-policy not-required
```

### Optional Linux x64 image and wrapper lanes

```bash
mise run self-hosted:image -- \
  --matrix-receipt .cache/self-hosted-native/matrix.json \
  --host-receipt .cache/self-hosted-native/X.Y.Z/linux-x64/host.json \
  --artifact .cache/self-hosted-native/X.Y.Z/linux-x64/finalized \
  --context-dir .cache/self-hosted-image/X.Y.Z/linux-x64/context \
  --base-image ubuntu@sha256:REPLACE_WITH_LOCAL_IMMUTABLE_DIGEST \
  --receipt .cache/self-hosted-image/X.Y.Z/linux-x64/image.json

mise run self-hosted:wrapper -- \
  --wrapper-output .cache/self-hosted-wrapper/exec-claude-v1 \
  --receipt .cache/self-hosted-wrapper/wrapper.json

mise run self-hosted:wrapper-image -- \
  --parent-receipt .cache/self-hosted-image/X.Y.Z/linux-x64/image.json \
  --wrapper-receipt .cache/self-hosted-wrapper/wrapper.json \
  --wrapper .cache/self-hosted-wrapper/exec-claude-v1 \
  --context-dir .cache/self-hosted-wrapper-image/X.Y.Z/linux-x64/context \
  --receipt .cache/self-hosted-wrapper-image/X.Y.Z/linux-x64/image.json
```

The image lane requires a locally available digest-pinned base, builds without pulling or tagging, runs as numeric non-root, defaults to `--version`, and performs locked-down diagnostics with no network, a read-only root filesystem, dropped capabilities, and no-new-privileges. The wrapper performs only an absolute source-path guard and exact `exec` handoff; its synthetic probe checks argv, a minimal environment, stdin, file descriptor 3 activity, PID identity, signals, and exit status. Neither lane registers or starts a runner.

## Stock client compatibility and UI risk

A stock iOS, web, macOS, Windows, or Linux client can remain unmodified only when the upstream remote surface transports the patched host's tool calls and the client can present and approve the resulting payloads correctly. cc-enhanced currently has no protocol proxy or schema-translation layer between the patched host and a stock client.

| Patched behavior | Host responsibility | Stock-client risk | Required proof |
| --- | --- | --- | --- |
| Read `range` and `show_whitespace` | Validate the new input, execute the requested range, and return bounded content. | The client may omit the range, render a generic card, or reject an unknown approval payload. | Permission input, Read semantics, and Read presentation on each client. |
| Edit `edits[]` | Preserve the batch through validation, dispatch, approval, execution, diff rendering, and transcript cleanup. | The client may flatten the batch, approve only one edit, or render an incomplete diff. | Permission input, single Edit, batch Edit, Write, and reconnect/resume on each client. |
| `tools-off-desktop` | Advertise the reduced core inventory, retain every `NotebookEdit` registration, and preserve authenticated Artifact reads while WebFetch remains unavailable. | A host payload without the Artifact read action cannot reread owned or shared artifacts; cached or hardcoded client inventory may also show removed tools or hide retained ones. | Tool inventory, prompt surface, owned/shared Artifact read semantics, and reconnect/resume. |
| Prompt and harness changes | Run entirely on the patched host and preserve exact model/runtime routing. | Usually invisible, but reconnect or resumed sessions may restore stock host state or stale metadata. | Prompt surface plus restart/reconnect and resume evidence. |

This leads to three practical choices:

1. **Patch only the host CLI and use stock clients.** Lowest client upkeep, but every custom Read/Edit/tool payload must be qualified on every client and upstream client release.
2. **Add a compatibility adapter.** A future proxy could translate `range` and `edits[]` into stock-shaped display or approval records while preserving patched host execution. That would reduce client patching but introduces a protocol contract, versioning, security, and end-to-end test surface that does not exist today.
3. **Patch a Desktop client bundle.** This could deliver richer native cards, but packaging, code signing, notarization, application updates, and per-platform bundle drift make it the highest-maintenance route. It should be justified only after stock-client probes demonstrate a concrete UI blocker that a host-side adapter cannot solve.

For the original native Desktop app in local mode, the app must actually select and launch the separate patched Code candidate; this repository deliberately does not replace the Desktop-managed artifact or activate that integration automatically. A Desktop-local candidate may include `tools-off-desktop` only when its current upstream Artifact tool provides authenticated `action: "read"` semantics; payloads that still depend on WebFetch for artifact reads fail verification and are not backported. For Remote Control or self-hosted mode, the exact receipt-bound latest patched CLI runs on the host/runner and the native app remains a stock client, subject to the compatibility probes above.

## Platform complexity

| Platform | Native construction | Matching-host work | Primary upkeep risk |
| --- | --- | --- | --- |
| Linux | Built-in ELF extraction and repacking; glibc and musl artifact variants. | Execute the exact architecture; container lane is Linux x64 only today. | Distribution variants, architecture coverage, and container base drift. |
| macOS | Mach-O extraction and repacking through `node-lief`. | Re-extraction, runtime tags, and the selected ad-hoc or identity signing policy on macOS. | Code signing, notarization expectations, universal/app packaging, and host availability. |
| Windows | PE extraction and repacking through `node-lief`; `.exe` suffix is preserved. | Re-extraction, runtime tags, and embedded signature handling on Windows. | Authenticode policy, Desktop cache/update behavior, and ARM64 host availability. |
| iOS and web | No local native binary patch. | Connect only through an upstream-supported Remote Control or runner client path. | Approval cards, custom tool-field presentation, reconnect behavior, and upstream protocol changes. |

## Upkeep checklist

1. Update only to the latest upstream release and use the immediately previous clean bundle solely as a diff baseline.
2. Re-run surface classification tests; keep `cli-full` at the exact ordered 44-patch roster and reserved profiles at an ordered, duplicate-free 30/15 partition of all 45 catalog entries.
3. Build the relevant structural matrix and finalize each claimed platform on a matching host with its signing policy.
4. Re-run the exact Read, Edit, Write, tools, prompt, approval, restart, and reconnect probes for every claimed stock client.
5. Keep receipts private and ephemeral unless a sanitized artifact has a specific review purpose; never make a historical receipt a runtime baseline or test oracle.
6. Run `mise run verify:patches` independently before promoting or describing current compatibility.

The code structure intentionally makes client patching optional rather than foundational. Start with a patched host plus explicit stock-client probes, add translation only for observed incompatibilities, and patch a client bundle only when a platform-specific UI requirement cannot be met through either earlier layer.
