# Subscription routing setup

This package reproduces a two-subscription setup without placing provider API
keys in the client configuration:

```text
claude
  -> promoted cc-enhanced binary
  -> Anthropic directly
  -> Claude Max subscription

claudex
  -> the same promoted cc-enhanced binary and the same ~/.claude configuration
  -> local selective routing service
     |- native models -> Anthropic passthrough -> Claude Max subscription
     `- sol           -> protocol translation -> ChatGPT Pro OAuth
```

The direct and routed launchers intentionally coexist. `claude` remains the
baseline. `claudex` adds routing only for that process tree, including fresh
agents and workflow workers. It does not replace the normal login, settings,
status line, plugins, skills, agents, session history, or project configuration.

The package targets WSL or Linux x86_64 with a systemd user session. The routing
runtime is portable to other platforms, but the supplied service and
PasswordVault bridge are platform-specific.

## What is pinned

[`versions.env`](./versions.env) is the only source of reviewed version data:

- immutable client source revision;
- upstream native client version;
- Linux x86_64 promoted-binary digest;
- immutable routing source revision;
- normalized production-runtime digest;
- runtime toolchain;
- provider, model, alias, context, and port values.

The branch names are update channels. The full revisions and digests are the
installation anchors. Do not replace a pinned revision with the current branch
tip without reviewing the complete old-to-new diff and regenerating the
matching artifact digest.

The current translated-model pin is a 258,400-token effective input window with
a 32,000-token output allowance. This package does not enable the separate
372K-context experiment or claim a one-million-token translated-model window.

## File map

| Path | Purpose |
| --- | --- |
| `README.md` | Installation, operation, update, rollback, and removal guide |
| `versions.env` | Public source, artifact, toolchain, route, model, and context pins |
| `runtime-artifact-sha256.sh` | Normalized routing-runtime digest |
| `check-routed-idle.sh` | Refuses a service restart while routed clients are active |
| `verify-static.sh` | Read-only file, source, digest, template, prompt, and patch verification |
| `verify-live.sh` | Explicit service and authentication verification; optional inference smoke tests |
| `templates/claudex` | Routed session launcher |
| `templates/clodex` | Isolated provider-administration wrapper |
| `templates/claudex-clodex.service` | Hardened on-demand systemd user service |
| `templates/claudex-credential-helper` | WSL-to-Windows secure-store bridge |
| `templates/claudex-credential-helper.ps1` | Windows PasswordVault implementation |
| `templates/system-prompt-routing.md` | Routed model, workflow, and delegation policy |

Do not add generated checkouts, deployed runtimes, configuration databases,
logs, certificates, account identifiers, credential payloads, home paths, or
host-specific network settings to this directory.

## Ownership boundaries

The client patcher owns the native binary, patch signature, model catalog,
aliases, context metadata, model-picker behavior, agent model tags, prompt
policy, and workflow lifecycle guards.

The routing runtime owns selective transport, provider authentication, protocol
translation, model discovery, credential refresh, and lifecycle logging.

Never run `clodex patch` in this setup. The supplied administration wrapper
rejects that command. Two patch managers targeting the same native binary can
overwrite or restore one another's build.

## Required client capabilities

The promoted client must report all of these tags:

- `configured-model-catalog`
- `billing-label`
- `model-aliases`
- `model-context-metadata`
- `model-picker-session-only`
- `subagent-model-tag`
- `sys-prompt-file`
- `workflow-safety`

`workflow-safety` is required. It prevents ordinary agent messaging from
resuming workflow-owned workers, persists workflow ownership before launch,
fails closed when ownership metadata cannot be read, and supplies a targeted
correction when structured output fields are embedded in one string.

## Prerequisites

Install:

- Git;
- [mise](https://mise.jdx.dev/);
- a systemd user session;
- common POSIX utilities;
- GNU `tar`, `sha256sum`, `readlink`, `sed`, `grep`, `cmp`, `cut`, and `stat`;
- `pgrep` from procps for the idle-session gate;
- Windows PowerShell and `wslpath` only when using the supplied WSL
  PasswordVault helper.

The client source pins its own Bun toolchain. The routing source uses the exact
Node.js and package-manager versions in `versions.env`.

## 1. Install the pinned client

Start from the parent directory where you want the source checkout:

```sh
(
set -eu

setup_dir=/absolute/path/to/docs/subscription-routing
. "$setup_dir/versions.env"

git clone \
  --branch "$CC_ENHANCED_BRANCH" \
  --single-branch \
  "$CC_ENHANCED_REPOSITORY" \
  cc-enhanced
git -C cc-enhanced checkout --detach "$CC_ENHANCED_REVISION"
test "$(git -C cc-enhanced rev-parse HEAD)" = "$CC_ENHANCED_REVISION"

cd cc-enhanced
mise install
mise run native:update -- "$CC_ENHANCED_NATIVE_VERSION"

claude --version
promoted_binary=$(readlink -f "$HOME/.local/share/claude/versions/current")
test "$(sha256sum "$promoted_binary" | cut -d ' ' -f1)" = \
  "$CC_ENHANCED_LINUX_X64_SHA256"
)
```

The update performs the real-bundle patch verification, promotes by atomic
symlink replacement, exports the promoted prompts, and checks both curated
prompt surfaces and prompt drift. A failed patch verification does not write or
promote the candidate.

The binary digest above is for Linux x86_64 only. On another platform, verify
the immutable source revision, native version, patch signature, and platform
build independently before adding a platform-specific digest.

## 2. Build the pinned routing runtime

From this setup directory:

```sh
(
set -eu

. ./versions.env
. ./runtime-artifact-sha256.sh

git clone \
  --branch "$CLODEX_BRANCH" \
  --single-branch \
  "$CLODEX_REPOSITORY" \
  clodex
git -C clodex checkout --detach "$CLODEX_REVISION"
test "$(git -C clodex rev-parse HEAD)" = "$CLODEX_REVISION"

cd clodex
mise install "node@$CLODEX_NODE_VERSION"
node_root=$(mise where "node@$CLODEX_NODE_VERSION")
corepack_bin="$node_root/bin/corepack"
test -x "$corepack_bin"
test "$("$corepack_bin" "pnpm@$CLODEX_PNPM_VERSION" --version)" = \
  "$CLODEX_PNPM_VERSION"

"$corepack_bin" "pnpm@$CLODEX_PNPM_VERSION" install --frozen-lockfile
"$corepack_bin" "pnpm@$CLODEX_PNPM_VERSION" typecheck
"$corepack_bin" "pnpm@$CLODEX_PNPM_VERSION" test
"$corepack_bin" "pnpm@$CLODEX_PNPM_VERSION" build

runtime_parent="$HOME/.local/share/claudex-clodex/runtime"
install -d -m 700 "$runtime_parent"
candidate_runtime=$(mktemp -d "$runtime_parent/.candidate.XXXXXX")
trap 'rm -rf "$candidate_runtime"' 0 HUP INT TERM

"$corepack_bin" "pnpm@$CLODEX_PNPM_VERSION" \
  --filter . deploy --prod --legacy "$candidate_runtime"
candidate_artifact=$(runtime_artifact_sha256 "$candidate_runtime")
test "$candidate_artifact" = "$CLODEX_ARTIFACT_SHA256"

revision_short=$(printf '%s' "$CLODEX_REVISION" | cut -c1-12)
artifact_short=$(printf '%s' "$CLODEX_ARTIFACT_SHA256" | cut -c1-12)
runtime_id="$revision_short-$artifact_short"
runtime_root="$runtime_parent/$runtime_id"

if [ -d "$runtime_root" ]; then
  test "$(runtime_artifact_sha256 "$runtime_root")" = \
    "$CLODEX_ARTIFACT_SHA256"
else
  "$corepack_bin" "pnpm@$CLODEX_PNPM_VERSION" \
    --filter . deploy --prod --legacy "$runtime_root"
fi
test "$(runtime_artifact_sha256 "$runtime_root")" = \
  "$CLODEX_ARTIFACT_SHA256"
printf '%s\n' "$CLODEX_REVISION" >"$runtime_root/CLODEX_REVISION"
printf '%s\n' "$CLODEX_ARTIFACT_SHA256" \
  >"$runtime_root/CLODEX_ARTIFACT_SHA256"
install -m 600 ../versions.env "$runtime_root/SETUP_VERSIONS.env"

previous_target=''
if [ -L "$runtime_parent/current" ]; then
  previous_target=$(readlink "$runtime_parent/current")
fi
printf '%s\n' "$previous_target" >"$runtime_parent/PREVIOUS"

switch_directory=$(mktemp -d "$runtime_parent/.switch.XXXXXX")
ln -s "$runtime_id" "$switch_directory/current"
mv -Tf "$switch_directory/current" "$runtime_parent/current"
rmdir "$switch_directory"
)
```

This switches only the immutable `current` symlink. It does not restart the
service. Existing routed sessions continue using the process and executable
they already opened.

The normalized runtime digest excludes provenance files, path-bound generated
launchers, and time/order metadata that are not supported runtime entrypoints.
The service and wrapper execute `dist/cli.js` directly.

## 3. Select and install a credential helper

The helper contract is:

```text
helper get <service> <account>
helper set <service> <account>    # value arrives on stdin
helper delete <service> <account>
```

`get` writes the exact stored value to stdout. A missing item exits 2. Other
failures exit nonzero without writing a credential.

For WSL with Windows PasswordVault:

```sh
(
set -eu

install -d -m 700 "$HOME/.local/libexec"
install -m 700 templates/claudex-credential-helper \
  "$HOME/.local/libexec/claudex-credential-helper"
install -m 600 templates/claudex-credential-helper.ps1 \
  "$HOME/.local/libexec/claudex-credential-helper.ps1"
)
```

The helper chunks values that exceed PasswordVault's per-record limit,
publishes a generation only after every chunk is written, validates a digest
when reading, and removes superseded generations after a successful commit.

For native Linux or macOS, provide an equivalent executable backed by Secret
Service, KWallet, Keychain, `pass`, or another secure store:

```sh
export CLODEX_CREDENTIAL_HELPER_PATH=/absolute/path/to/secure-helper
```

Use the same absolute value during template rendering and every verification
run. Do not use a plaintext token file.

## 4. Render the service and launchers

This example defaults to the supplied WSL helper but accepts the absolute
`CLODEX_CREDENTIAL_HELPER_PATH` override:

```sh
(
set -eu

. ./versions.env
mise install "node@$CLODEX_NODE_VERSION"
node_bin="$(mise where "node@$CLODEX_NODE_VERSION")/bin/node"
claude_bin=$(command -v claude)
credential_helper=${CLODEX_CREDENTIAL_HELPER_PATH:-"$HOME/.local/libexec/claudex-credential-helper"}

case "$credential_helper" in
  /*) ;;
  *) printf '%s\n' 'credential helper path must be absolute' >&2; exit 1 ;;
esac
test -x "$node_bin"
test -x "$claude_bin"
test -x "$credential_helper"
test "$("$node_bin" -p 'process.versions.node')" = "$CLODEX_NODE_VERSION"

if ! systemctl --user is-active --quiet claudex-clodex.service; then
  "$node_bin" - "$CLODEX_PORT" <<'NODE'
const net = require('node:net');
const port = Number(process.argv[2]);
const server = net.createServer();
server.once('error', error => {
  process.stderr.write(`port ${port} is unavailable: ${error.message}\n`);
  process.exitCode = 1;
});
server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close());
NODE
fi

rendered_dir=$(mktemp -d)
trap 'rm -rf "$rendered_dir"' 0 HUP INT TERM

sed \
  -e "s|@HOME@|$HOME|g" \
  -e "s|@NODE_BIN@|$node_bin|g" \
  -e "s|@CLODEX_PORT@|$CLODEX_PORT|g" \
  -e "s|@CLODEX_CREDENTIAL_HELPER@|$credential_helper|g" \
  templates/claudex-clodex.service >"$rendered_dir/claudex-clodex.service"
sed \
  -e "s|@NODE_BIN@|$node_bin|g" \
  -e "s|@CLODEX_CREDENTIAL_HELPER@|$credential_helper|g" \
  templates/clodex >"$rendered_dir/clodex"
sed \
  -e "s|@CLAUDE_BIN@|$claude_bin|g" \
  -e "s|@CLODEX_CREDENTIAL_HELPER@|$credential_helper|g" \
  -e "s|@CLODEX_PROVIDER_ID@|$CLODEX_PROVIDER_ID|g" \
  -e "s|@CLODEX_MODEL_ID@|$CLODEX_MODEL_ID|g" \
  -e "s|@CLODEX_MODEL_ALIAS@|$CLODEX_MODEL_ALIAS|g" \
  -e "s|@CLODEX_MODEL_DISPLAY_NAME@|$CLODEX_MODEL_DISPLAY_NAME|g" \
  -e "s|@CLODEX_MODEL_DESCRIPTION@|$CLODEX_MODEL_DESCRIPTION|g" \
  -e "s|@CLODEX_BILLING_LABEL@|$CLODEX_BILLING_LABEL|g" \
  -e "s|@CLODEX_MODEL_MAX_INPUT_TOKENS@|$CLODEX_MODEL_MAX_INPUT_TOKENS|g" \
  -e "s|@CLODEX_MODEL_MAX_OUTPUT_TOKENS@|$CLODEX_MODEL_MAX_OUTPUT_TOKENS|g" \
  templates/claudex >"$rendered_dir/claudex"

install -d -m 700 "$HOME/.config/systemd/user" "$HOME/.local/bin"
install -m 600 "$rendered_dir/claudex-clodex.service" \
  "$HOME/.config/systemd/user/claudex-clodex.service"
install -m 700 "$rendered_dir/claudex" "$HOME/.local/bin/claudex"
install -m 700 "$rendered_dir/clodex" "$HOME/.local/bin/clodex"

systemctl --user daemon-reload
)
```

The unit stays disabled. `claudex` starts it on demand and waits up to ten
seconds for the strict process-wrapper readiness check. `claude` does not start
or depend on the service.

The service clears provider API keys, alternate provider base URLs, and routing
overrides. Optional proxy or private-CA settings belong in:

```text
~/.config/claudex-clodex/network.env
```

The file is service-only, mode 600, and may contain values such as
`HTTPS_PROXY`, `NO_PROXY`, or `NODE_EXTRA_CA_CERTS`. Do not put provider API
keys in it.

## 5. Render the routed prompt

The routed prompt is the managed `/etc/claude-code/system-prompt.md`, when
present, plus the routing-specific policy:

```sh
(
set -eu

. ./versions.env
prompt_directory="$HOME/.config/claudex-clodex"
install -d -m 700 "$prompt_directory"
temporary_prompt=$(mktemp "$prompt_directory/.system-prompt.XXXXXX")
trap 'rm -f "$temporary_prompt"' 0 HUP INT TERM

if [ -r /etc/claude-code/system-prompt.md ]; then
  cp /etc/claude-code/system-prompt.md "$temporary_prompt"
else
  : >"$temporary_prompt"
fi
printf '\n' >>"$temporary_prompt"
sed \
  -e "s|@CLODEX_MODEL_NAME@|$CLODEX_MODEL_NAME|g" \
  -e "s|@CLODEX_MODEL_DISPLAY_NAME@|$CLODEX_MODEL_DISPLAY_NAME|g" \
  -e "s|@CLODEX_MODEL_ALIAS@|$CLODEX_MODEL_ALIAS|g" \
  -e "s|@CLODEX_MODEL_MAX_INPUT_TOKENS_DISPLAY@|$CLODEX_MODEL_MAX_INPUT_TOKENS_DISPLAY|g" \
  templates/system-prompt-routing.md >>"$temporary_prompt"
chmod 600 "$temporary_prompt"
mv -f "$temporary_prompt" "$prompt_directory/system-prompt.md"
)
```

Rerun this block whenever the managed system prompt or routing template
changes. The static verifier reconstructs the expected file byte-for-byte.

The routed policy does not force all children to `sol`. It teaches the parent
that explicit requests such as “use Sol agents” mean per-call
`model: "sol"`, preserves specialist agent types, and keeps each worker within
its own context budget. Required workflow results become hard gates with one
recovery attempt; downstream phases do not continue after a second missing
result.

## 6. Start, authenticate, and select the model

Start the service after the immutable runtime and rendered unit are installed:

```sh
systemctl --user start claudex-clodex.service
clodex providers auth openai
clodex providers list
clodex models
```

In the model manager:

1. Favorite `gpt-5.6-sol` from provider `openai-oauth`.
2. Save the lowercase alias `sol`.

The OAuth credential is stored through the selected secure helper. Native model
requests continue to use the existing Claude Max login because the selective
proxy passes those requests through without replacing the client's
authentication.

Do not put the route, alias, base URL, or credentials in
`~/.claude/settings.json`. The launcher injects these values only into routed
processes.

## 7. Verify

Static verification does not start a service, access a credential, or send an
inference request:

```sh
./verify-static.sh
```

Optional source-checkout verification:

```sh
CC_ENHANCED_SOURCE_DIR=/path/to/cc-enhanced \
CLODEX_SOURCE_DIR=/path/to/clodex \
./verify-static.sh
```

The client source check accepts an exact pinned checkout or a descendant whose
only tracked differences are this handoff package and the root README link. Any
runtime source, patch, dependency, toolchain, or baseline difference fails.

Live service and authentication verification:

```sh
./verify-live.sh
```

Opt-in direct, passthrough, and translated inference smoke tests:

```sh
./verify-live.sh --smoke
```

The smoke flag consumes subscription usage. It is not part of static
installation validation.

Manual behavior gates after an update:

1. Start `claudex fable`; confirm the parent remains Fable.
2. Start `claudex opus`; confirm the parent remains Opus.
3. Start `claudex sol`; confirm the parent is Sol.
4. From a native parent, create a fresh specialist Agent with `model: "sol"`.
5. Run a Workflow whose selected workers use `model: "sol"`.
6. Confirm the Workflow refuses to continue when a required worker result is
   missing after one recovery attempt.
7. Have a Sol worker discover and invoke one deferred tool.
8. Open `/model`; confirm the readable Sol entry appears and selection is
   session-only.
9. Open a normal `claude` session; confirm Sol is absent and native
   authentication remains unchanged.

Response lifecycle records carry only validated UUID-shaped session
identifiers. A `response_client_disconnected` record includes
`disconnectSource: "downstream_client"` so downstream cancellation is not
mistaken for an upstream failure.

## Usage

```sh
claude                 # direct client, Claude Max, no routing environment
claudex                # routed session, preserve the saved native parent
claudex fable          # Fable parent through native passthrough
claudex opus           # Opus parent through native passthrough
claudex sol            # Sol parent through ChatGPT Pro OAuth
clodex providers list  # isolated provider administration
clodex models          # isolated favorites and aliases
```

Inside a native parent, request a Sol specialist by selecting the normal agent
type and setting `model: "sol"`. In a Workflow, set `model: "sol"` on each
selected `agent(...)` call. Do not encode the provider model ID in prompts or
workflow source.

The model picker entry and aliases exist only under `claudex`; their absence
under `claude` is intentional.

An unpatched upstream client is not a supported substitute for this package.
The routing service can proxy requests independently, but readable configured
models, per-model context metadata, session-only picker behavior, aliases,
agent model tags, prompt-file overrides, and workflow lifecycle enforcement
depend on the listed client patches.

## Safe updates and restarts

Deploying a new immutable runtime and switching `runtime/current` does not
restart an existing service. Before any restart:

```sh
./check-routed-idle.sh
systemctl --user restart claudex-clodex.service
./verify-live.sh
```

If the idle check fails, wait for routed parents, agents, and workflows to
finish. Do not restart around them. Restarting the service closes active
streams.

For a client update:

1. Pull one new native version.
2. Review one release diff at a time.
3. Update patch anchors only for the latest upstream form.
4. Run the full real-bundle verifier.
5. Promote.
6. Record the new source revision, native version, and platform digest.
7. Refresh this package and run both verification layers.

For a routing update:

1. Review the complete pinned-revision diff.
2. Run type checking, all tests, and the production build.
3. Deploy a candidate and calculate its normalized digest.
4. Update the source revision and artifact digest together.
5. Publish a new immutable runtime.
6. Wait for routed sessions to become idle before restarting the service.

## Rollback

Rollback uses the retained runtime named in `runtime/PREVIOUS`:

```sh
(
set -eu

./check-routed-idle.sh
runtime_parent="$HOME/.local/share/claudex-clodex/runtime"
IFS= read -r previous_target <"$runtime_parent/PREVIOUS"
test -n "$previous_target"
test -x "$runtime_parent/$previous_target/dist/cli.js"

switch_directory=$(mktemp -d "$runtime_parent/.rollback.XXXXXX")
trap 'rm -rf "$switch_directory"' 0 HUP INT TERM
ln -s "$previous_target" "$switch_directory/current"
mv -Tf "$switch_directory/current" "$runtime_parent/current"
rmdir "$switch_directory"

systemctl --user restart claudex-clodex.service
)
```

Restore the matching `SETUP_VERSIONS.env`, rerender the service, wrappers, and
prompt, then rerun static and live verification.

The client patcher has its own symmetric rollback:

```sh
mise run native:rollback
claude --version
mise run status
```

## Troubleshooting

### Sol is missing from `/model`

Confirm the session was launched with `claudex`, not `claude`, then run static
verification. The model catalog and alias are session-local by design.

### The routed launcher is blank or slow

Check:

```sh
systemctl --user status claudex-clodex.service --no-pager
journalctl --user-unit claudex-clodex.service --since today --no-pager
```

Do not print credential helper output. The launcher has a bounded ten-second
readiness wait and reports unit status on failure.

### Authentication reports a reused or rejected refresh token

The pinned runtime re-reads external credentials, suppresses a rejected
environment override until it changes, and performs one safe refresh/retry. If
authentication remains invalid, run the provider authentication command again.
Do not work around it by setting provider API-key variables.

### An apparent upstream reset follows a stopped worker

Match lifecycle records by `claudeSessionId` and `requestId`. If the terminal
record says `response_client_disconnected` with
`disconnectSource: "downstream_client"`, the client or worker closed the stream;
it is not evidence that the upstream provider timed out.

### A workflow worker edits successfully but produces no accepted result

Confirm the client signature contains `workflow-safety` and the routed prompt
matches this package. Required structured fields must be separate top-level
arguments. The workflow should make one recovery attempt against the existing
work, then stop dependent phases if the result remains missing.

## Billing display

The routed launcher sets the fallback billing label to the pinned
`CLODEX_BILLING_LABEL` value. The label is display-only. It does not select a
credential, change an authentication route, or change how either provider
accounts for usage. The client may still display a local estimated dollar
amount for translated requests. Verify the provider authentication mode with
`./verify-live.sh`; it must report external OAuth.

## Removal

Remove the provider first so the runtime can delete its OAuth credential through
the configured helper:

```sh
(
set -eu

clodex providers remove openai-oauth
systemctl --user stop claudex-clodex.service
rm -f \
  "$HOME/.config/systemd/user/claudex-clodex.service" \
  "$HOME/.local/bin/claudex" \
  "$HOME/.local/bin/clodex"
rm -rf \
  "$HOME/.config/claudex-clodex" \
  "$HOME/.local/share/claudex-clodex"
systemctl --user daemon-reload
)
```

Delete the supplied helper files only after provider removal confirms credential
deletion. Removing the routed setup does not alter the promoted client, the
normal Claude configuration, or the Claude Max login.
