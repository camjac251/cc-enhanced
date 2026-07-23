#!/bin/sh

set -eu

fail() {
	printf 'static verification failed: %s\n' "$1" >&2
	exit 1
}

setup_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=versions.env
. "$setup_dir/versions.env"
artifact_helper="$setup_dir/runtime-artifact-sha256.sh"
[ -r "$artifact_helper" ] || fail "artifact hash helper is unreadable: $artifact_helper"
# shellcheck source=runtime-artifact-sha256.sh
. "$artifact_helper"

for command_name in cmp cut grep mise mktemp readlink sed sha256sum stat tar; do
	command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is unavailable"
done

claude_bin=${CLAUDE_BIN:-"$HOME/.local/bin/claude"}
claudex_bin=${CLAUDEX_BIN:-"$HOME/.local/bin/claudex"}
clodex_bin=${CLODEX_BIN:-"$HOME/.local/bin/clodex"}
default_credential_helper="$HOME/.local/libexec/claudex-credential-helper"
credential_helper=${CLODEX_CREDENTIAL_HELPER_PATH:-$default_credential_helper}
case "$credential_helper" in
/*) ;;
*) fail "CLODEX_CREDENTIAL_HELPER_PATH must be absolute" ;;
esac

runtime_parent="$HOME/.local/share/claudex-clodex/runtime"
[ -d "$runtime_parent" ] || fail "runtime directory is missing: $runtime_parent"
runtime_parent=$(CDPATH='' cd -- "$runtime_parent" && pwd -P) ||
	fail "runtime directory cannot be resolved: $runtime_parent"
runtime_link="$runtime_parent/current"
[ -L "$runtime_link" ] || fail "current runtime selector is not a symlink: $runtime_link"
current_target=$(readlink "$runtime_link")
case "$current_target" in
'' | /* | */* | . | ..) fail "current runtime selector is not a relative runtime id" ;;
esac
runtime_root=$(CDPATH='' cd -- "$runtime_parent/$current_target" && pwd -P) ||
	fail "selected runtime cannot be resolved: $current_target"
runtime="$runtime_link/dist/cli.js"
system_prompt="$HOME/.config/claudex-clodex/system-prompt.md"
service_unit="$HOME/.config/systemd/user/claudex-clodex.service"
config_file="$HOME/.local/share/claudex-clodex/config.json"

for executable in "$claude_bin" "$claudex_bin" "$clodex_bin" "$runtime" "$credential_helper"; do
	[ -x "$executable" ] || fail "required executable is missing: $executable"
done
[ -r "$system_prompt" ] || fail "system prompt is unreadable: $system_prompt"
[ -r "$service_unit" ] || fail "service unit is unreadable: $service_unit"
[ -r "$config_file" ] || fail "model configuration is unreadable: $config_file"

node_root=$(mise where "node@$CLODEX_NODE_VERSION")
node_bin="$node_root/bin/node"
[ -x "$node_bin" ] || fail "pinned Node.js executable is missing: $node_bin"
node_version=$("$node_bin" -p 'process.versions.node')
[ "$node_version" = "$CLODEX_NODE_VERSION" ] ||
	fail "installed Node.js does not match versions.env"
corepack_bin="$node_root/bin/corepack"
[ -x "$corepack_bin" ] || fail "Corepack is missing from the pinned Node.js install"
pnpm_version=$(
	CDPATH='' cd -- "${TMPDIR:-/tmp}"
	"$corepack_bin" "pnpm@$CLODEX_PNPM_VERSION" --version
)
[ "$pnpm_version" = "$CLODEX_PNPM_VERSION" ] ||
	fail "installed package manager does not match versions.env"

if [ -n "${CC_ENHANCED_SOURCE_DIR:-}" ]; then
	command -v git >/dev/null 2>&1 || fail "git is unavailable"
	if [ "$(git -C "$CC_ENHANCED_SOURCE_DIR" rev-parse HEAD)" != "$CC_ENHANCED_REVISION" ]; then
		git -C "$CC_ENHANCED_SOURCE_DIR" merge-base --is-ancestor \
			"$CC_ENHANCED_REVISION" HEAD ||
			fail "client source checkout does not contain the pinned revision"
		git -C "$CC_ENHANCED_SOURCE_DIR" diff --quiet "$CC_ENHANCED_REVISION" -- \
			. \
			':(exclude)README.md' \
			':(exclude)docs/subscription-routing/**' ||
			fail "client runtime source differs from the pinned revision"
	fi
fi
if [ -n "${CLODEX_SOURCE_DIR:-}" ]; then
	command -v git >/dev/null 2>&1 || fail "git is unavailable"
	[ "$(git -C "$CLODEX_SOURCE_DIR" rev-parse HEAD)" = "$CLODEX_REVISION" ] ||
		fail "routing source checkout does not match versions.env"
fi

case "$(uname -s):$(uname -m)" in
Linux:x86_64)
	client_digest=$(sha256sum "$claude_bin" | cut -d ' ' -f1)
	[ "$client_digest" = "$CC_ENHANCED_LINUX_X64_SHA256" ] ||
		fail "promoted client binary does not match its Linux x86_64 digest"
	;;
*)
	printf '%s\n' \
		'warning: no promoted client binary digest is pinned for this platform' >&2
	;;
esac

revision_file="$runtime_root/CLODEX_REVISION"
[ -r "$revision_file" ] || fail "deployed revision metadata is missing: $revision_file"
IFS= read -r deployed_revision <"$revision_file"
[ "$deployed_revision" = "$CLODEX_REVISION" ] ||
	fail "deployed revision does not match versions.env"
deployed_versions="$runtime_root/SETUP_VERSIONS.env"
[ -r "$deployed_versions" ] || fail "deployed setup pins are missing: $deployed_versions"
cmp -s "$setup_dir/versions.env" "$deployed_versions" ||
	fail "deployed setup pins do not match versions.env"

case "$CLODEX_ARTIFACT_SHA256" in
*[!0-9a-f]*) fail "runtime digest pin is not lowercase hexadecimal" ;;
esac
[ "${#CLODEX_ARTIFACT_SHA256}" -eq 64 ] ||
	fail "runtime digest pin is not a full SHA-256 value"
artifact_file="$runtime_root/CLODEX_ARTIFACT_SHA256"
[ -r "$artifact_file" ] || fail "deployed runtime digest is missing: $artifact_file"
IFS= read -r deployed_artifact <"$artifact_file"
[ "$deployed_artifact" = "$CLODEX_ARTIFACT_SHA256" ] ||
	fail "deployed runtime metadata does not match versions.env"
revision_short=$(printf '%s' "$CLODEX_REVISION" | cut -c1-12)
artifact_short=$(printf '%s' "$CLODEX_ARTIFACT_SHA256" | cut -c1-12)
[ "$current_target" = "$revision_short-$artifact_short" ] ||
	fail "current runtime id does not match its revision and digest"
computed_artifact=$(runtime_artifact_sha256 "$runtime_root")
[ "$computed_artifact" = "$CLODEX_ARTIFACT_SHA256" ] ||
	fail "deployed runtime payload does not match its digest"

sed \
	-e "s|@HOME@|$HOME|g" \
	-e "s|@NODE_BIN@|$node_bin|g" \
	-e "s|@CLODEX_PORT@|$CLODEX_PORT|g" \
	-e "s|@CLODEX_CREDENTIAL_HELPER@|$credential_helper|g" \
	"$setup_dir/templates/claudex-clodex.service" | cmp -s - "$service_unit" ||
	fail "installed service unit does not match the reviewed template"
sed \
	-e "s|@NODE_BIN@|$node_bin|g" \
	-e "s|@CLODEX_CREDENTIAL_HELPER@|$credential_helper|g" \
	"$setup_dir/templates/clodex" | cmp -s - "$clodex_bin" ||
	fail "installed administration wrapper does not match the reviewed template"
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
	"$setup_dir/templates/claudex" | cmp -s - "$claudex_bin" ||
	fail "installed routed launcher does not match the reviewed template"

if grep -E '@(CLODEX_[A-Z_]+|CLAUDE_BIN|HOME|NODE_BIN)@' \
	"$claudex_bin" "$clodex_bin" "$service_unit" "$system_prompt" >/dev/null; then
	fail "an installed rendered file contains unresolved placeholders"
fi

if [ "$credential_helper" = "$default_credential_helper" ]; then
	cmp -s "$setup_dir/templates/claudex-credential-helper" "$credential_helper" ||
		fail "installed WSL credential helper does not match the reviewed template"
	credential_helper_ps1="$HOME/.local/libexec/claudex-credential-helper.ps1"
	[ -r "$credential_helper_ps1" ] ||
		fail "PasswordVault helper is unreadable: $credential_helper_ps1"
	cmp -s "$setup_dir/templates/claudex-credential-helper.ps1" "$credential_helper_ps1" ||
		fail "installed PasswordVault helper does not match the reviewed template"
fi

expected_prompt=$(mktemp)
trap 'rm -f "$expected_prompt"' 0 HUP INT TERM
if [ -r /etc/claude-code/system-prompt.md ]; then
	cp /etc/claude-code/system-prompt.md "$expected_prompt"
else
	: >"$expected_prompt"
fi
printf '\n' >>"$expected_prompt"
sed \
	-e "s|@CLODEX_MODEL_NAME@|$CLODEX_MODEL_NAME|g" \
	-e "s|@CLODEX_MODEL_DISPLAY_NAME@|$CLODEX_MODEL_DISPLAY_NAME|g" \
	-e "s|@CLODEX_MODEL_ALIAS@|$CLODEX_MODEL_ALIAS|g" \
	-e "s|@CLODEX_MODEL_MAX_INPUT_TOKENS_DISPLAY@|$CLODEX_MODEL_MAX_INPUT_TOKENS_DISPLAY|g" \
	"$setup_dir/templates/system-prompt-routing.md" >>"$expected_prompt"
cmp -s "$expected_prompt" "$system_prompt" ||
	fail "installed routed prompt is stale or differs from the reviewed template"

claude_version=$("$claude_bin" --version)
case "$claude_version" in
"$CC_ENHANCED_NATIVE_VERSION "*) ;;
*) fail "promoted client version does not match versions.env" ;;
esac
for patch_tag in \
	billing-label \
	configured-model-catalog \
	model-aliases \
	model-context-metadata \
	model-picker-session-only \
	subagent-model-tag \
	sys-prompt-file \
	workflow-safety; do
	case "$claude_version" in
	*"$patch_tag"*) ;;
	*) fail "required client patch is missing: $patch_tag" ;;
	esac
done

"$node_bin" "$runtime" --version >/dev/null

"$node_bin" - "$config_file" "$CLODEX_PROVIDER_ID" "$CLODEX_MODEL_ID" "$CLODEX_MODEL_ALIAS" <<'NODE'
const fs = require('node:fs');

const [configPath, providerId, modelId, aliasName] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const hasFavorite = config.favoriteModels?.some(
  entry => entry.providerId === providerId && entry.modelId === modelId,
);
const hasAlias = config.modelAliases?.some(
  entry => entry.name === aliasName
    && entry.providerId === providerId
    && entry.modelId === modelId,
);
if (!hasFavorite || !hasAlias) {
  process.stderr.write('expected routed favorite or alias is missing\n');
  process.exit(1);
}
NODE

printf '%s\n' 'static setup verification passed'
