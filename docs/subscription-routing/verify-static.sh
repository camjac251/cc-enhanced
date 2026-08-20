#!/bin/sh

set -eu

fail() {
	printf 'static verification failed: %s\n' "$1" >&2
	exit 1
}

profile=enhanced
case "$#" in
0) ;;
1)
	if [ "$1" = '--stock' ]; then
		profile=stock
	else
		printf '%s\n' 'usage: verify-static.sh [--stock]' >&2
		exit 2
	fi
	;;
*)
	printf '%s\n' 'usage: verify-static.sh [--stock]' >&2
	exit 2
	;;
esac

setup_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
provider_id=openai-oauth
model_id=gpt-5.6-sol
model_alias=sol

for command_name in cmp dd grep mise mktemp od rg sed stat wc; do
	command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is unavailable"
done
grep -F "install -d -m 700 \"\$HOME/.local/share/claudex-clodex\"" \
	"$setup_dir/README.md" >/dev/null ||
	fail "installation guide does not create the Clodex home"
"$setup_dir/test-service-control.sh"
"$setup_dir/test-client-compatibility.sh"
"$setup_dir/test-prompt-composition.sh"

claude_bin=${CLAUDE_BIN:-"$HOME/.local/bin/claude"}
claudex_bin=${CLAUDEX_BIN:-"$HOME/.local/bin/claudex"}
clodex_admin_bin=${CLODEX_BIN:-"$HOME/.local/bin/clodex"}
clodex_service_bin="$HOME/.local/bin/clodex-service"
default_credential_helper="$HOME/.local/libexec/claudex-credential-helper"
credential_helper=${CLODEX_CREDENTIAL_HELPER_PATH:-$default_credential_helper}
launcher_process_wrapper="$HOME/.local/libexec/claudex-process-wrapper"
prompt_composer="$HOME/.local/libexec/claudex-compose-system-prompt"
node_bin=$(mise which node)
mise_data_dir=${MISE_DATA_DIR:-"$HOME/.local/share/mise"}
mise_shims_dir="$mise_data_dir/shims"
clodex_bin=${CLODEX_BIN_PATH:-"$mise_shims_dir/clodex"}
clodex_wrapper="$mise_shims_dir/clodex-claude"
case "$credential_helper" in
/*) ;;
*) fail "CLODEX_CREDENTIAL_HELPER_PATH must be absolute" ;;
esac

system_prompt="$HOME/.config/claudex-clodex/system-prompt.md"
routing_overlay="$HOME/.config/claudex-clodex/routed-model-policy.md"
service_unit="$HOME/.config/systemd/user/claudex-clodex.service"
config_file="$HOME/.local/share/claudex-clodex/config.json"

for executable in \
	"$claude_bin" \
	"$claudex_bin" \
	"$clodex_bin" \
	"$clodex_wrapper" \
	"$clodex_admin_bin" \
	"$clodex_service_bin" \
	"$credential_helper" \
	"$node_bin" \
	"$launcher_process_wrapper" \
	"$prompt_composer"; do
	[ -x "$executable" ] || fail "required executable is missing: $executable"
done
[ -r "$system_prompt" ] || fail "system prompt is unreadable: $system_prompt"
[ -r "$routing_overlay" ] || fail "routing policy is unreadable: $routing_overlay"
[ -r "$service_unit" ] || fail "service unit is unreadable: $service_unit"
[ -r "$config_file" ] || fail "model configuration is unreadable: $config_file"

clodex_version=$("$clodex_bin" --version)
[ -n "$clodex_version" ] || fail "Clodex version is empty"

sed \
	-e "s|@HOME@|$HOME|g" \
	-e "s|@CLODEX_BIN@|$clodex_bin|g" \
	-e "s|@CLODEX_CREDENTIAL_HELPER@|$credential_helper|g" \
	"$setup_dir/templates/claudex-clodex.service" | cmp -s - "$service_unit" ||
	fail "installed service unit does not match the reviewed template"
sed \
	-e "s|@CLODEX_BIN@|$clodex_bin|g" \
	-e "s|@CLAUDE_BIN@|$claude_bin|g" \
	-e "s|@CLODEX_CREDENTIAL_HELPER@|$credential_helper|g" \
	"$setup_dir/templates/clodex" | cmp -s - "$clodex_admin_bin" ||
	fail "installed administration wrapper does not match the reviewed template"
sed \
	-e "s|@CLODEX_BIN@|$clodex_bin|g" \
	-e "s|@CLODEX_CLAUDE_BIN@|$clodex_wrapper|g" \
	"$setup_dir/templates/clodex-service" | cmp -s - "$clodex_service_bin" ||
	fail "installed service controller does not match the reviewed template"
sed \
	-e "s|@CLODEX_CLAUDE_BIN@|$clodex_wrapper|g" \
	-e "s|@CLAUDEX_CLIENT_PROFILE@|$profile|g" \
	"$setup_dir/templates/claudex-process-wrapper" |
	cmp -s - "$launcher_process_wrapper" ||
	fail "installed portable process wrapper does not match the reviewed template"
sed \
	-e "s|@NODE_BIN@|$node_bin|g" \
	-e "s|@CLAUDE_BIN@|$claude_bin|g" \
	-e "s|@CLODEX_CLAUDE_BIN@|$clodex_wrapper|g" \
	-e "s|@CLAUDEX_PROCESS_WRAPPER@|$launcher_process_wrapper|g" \
	-e "s|@CLAUDEX_PROMPT_COMPOSER@|$prompt_composer|g" \
	-e "s|@CLODEX_BIN@|$clodex_bin|g" \
	-e "s|@CLODEX_CREDENTIAL_HELPER@|$credential_helper|g" \
	"$setup_dir/templates/claudex" | cmp -s - "$claudex_bin" ||
	fail "installed routed launcher does not match the reviewed template"
cmp -s "$setup_dir/templates/claudex-compose-system-prompt" "$prompt_composer" ||
	fail "installed prompt composer does not match the reviewed template"

if grep -E '@(CLODEX_[A-Z_]+|CLAUDEX_[A-Z_]+|CLAUDE_BIN|NODE_BIN|HOME)@' \
	"$claudex_bin" \
	"$clodex_admin_bin" \
	"$clodex_service_bin" \
	"$launcher_process_wrapper" \
	"$prompt_composer" \
	"$service_unit" \
	"$system_prompt" >/dev/null; then
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
cmp -s "$setup_dir/templates/system-prompt-routing.md" "$routing_overlay" ||
	fail "installed routing policy does not match the reviewed template"

expected_prompt=$(mktemp)
trap 'rm -f "$expected_prompt"' 0 HUP INT TERM
if [ -r /etc/claude-code/system-prompt.md ]; then
	cp /etc/claude-code/system-prompt.md "$expected_prompt"
else
	: >"$expected_prompt"
fi
printf '\n' >>"$expected_prompt"
dd if="$setup_dir/templates/system-prompt-routing.md" \
	of="$expected_prompt" oflag=append conv=notrunc status=none
cmp -s "$expected_prompt" "$system_prompt" ||
	fail "installed routed prompt is stale or differs from the reviewed template"

claude_version=$("$claude_bin" --version)
if [ "$profile" = enhanced ]; then
	for patch_tag in \
		billing-label \
		claude-api-scope \
		configured-model-catalog \
		model-aliases \
		model-context-metadata \
		model-picker-session-only \
		skill-listing-ui \
		subagent-model-tag \
		subagent-system-prompt \
		sys-prompt-file \
		workflow-safety; do
		case "$claude_version" in
		*"$patch_tag"*) ;;
		*) fail "required client patch is missing: $patch_tag" ;;
		esac
	done
else
	case "$claude_version" in
	*'(Claude Code; patched:'*)
		fail "stock verification cannot target a cc-enhanced client"
		;;
	esac
fi

"$node_bin" - "$config_file" "$provider_id" "$model_id" "$model_alias" <<'NODE'
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

if [ "$profile" = enhanced ]; then
	printf '%s\n' 'static setup verification passed'
else
	printf '%s\n' 'stock static setup verification passed'
fi
