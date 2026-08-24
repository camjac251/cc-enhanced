#!/bin/sh

set -eu

fail() {
	printf 'live verification failed: %s\n' "$1" >&2
	exit 1
}

setup_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
provider_id=openai-oauth
model_alias=sol
clodex_port=3457

run_smoke=0
verification_mode=enhanced
stock_selected=0
for argument in "$@"; do
	case "$argument" in
	--smoke)
		run_smoke=1
		;;
	--stock)
		if [ "$stock_selected" -eq 1 ]; then
			printf '%s\n' 'usage: verify-live.sh [--smoke] [--stock] [--model=sol|terra|luna]' >&2
			exit 2
		fi
		verification_mode=stock
		stock_selected=1
		;;
	--model=sol | --model=terra | --model=luna)
		model_alias=${argument#--model=}
		;;
	*)
		printf '%s\n' 'usage: verify-live.sh [--smoke] [--stock] [--model=sol|terra|luna]' >&2
		exit 2
		;;
	esac
done

case "$verification_mode" in
enhanced)
	"$setup_dir/verify-static.sh"
	;;
stock)
	"$setup_dir/verify-static.sh" --stock
	;;
esac

for command_name in grep mise systemctl tr; do
	command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is unavailable"
done

claude_bin=${CLAUDE_BIN:-"$HOME/.local/bin/claude"}
claudex_bin=${CLAUDEX_BIN:-"$HOME/.local/bin/claudex"}
clodex_admin_bin=${CLODEX_BIN:-"$HOME/.local/bin/clodex"}
clodex_home="$HOME/.local/share/claudex-clodex"
mise_data_dir=${MISE_DATA_DIR:-"$HOME/.local/share/mise"}
process_wrapper="$mise_data_dir/shims/clodex-claude"

systemctl --user start claudex-clodex.service

ready=0
attempt=0
while [ "$attempt" -lt 50 ]; do
	if CLODEX_HOME="$clodex_home" "$process_wrapper" --check; then
		ready=1
		break
	fi
	if systemctl --user is-failed --quiet claudex-clodex.service; then
		break
	fi
	attempt=$((attempt + 1))
	sleep 0.2
done
[ "$ready" -eq 1 ] || fail "routing service did not become ready within 10 seconds"

provider_output=$("$clodex_admin_bin" providers list)
provider_line=$(printf '%s\n' "$provider_output" | grep -F "($provider_id)" || :)
[ -n "$provider_line" ] || fail "the expected provider is unavailable"
printf '%s\n' "$provider_line" | grep -F 'auth: helper (OAuth)' >/dev/null ||
	fail "the expected provider is not using the external OAuth helper"
printf 'provider %s: external OAuth configured\n' "$provider_id"

main_pid=$(systemctl --user show --property MainPID --value claudex-clodex.service)
case "$main_pid" in
'' | 0 | *[!0-9]*) fail "service has no valid main process" ;;
esac
[ -r "/proc/$main_pid/cmdline" ] || fail "service command line is unavailable"
service_arguments=$(tr '\000' '\n' <"/proc/$main_pid/cmdline")
printf '%s\n' "$service_arguments" | grep -Fx 'server' >/dev/null ||
	fail "running service is not in server mode"
printf '%s\n' "$service_arguments" | grep -Fx -- '--proxy' >/dev/null ||
	fail "running service is not in proxy mode"
printf '%s\n' "$service_arguments" | grep -Fx -- "$clodex_port" >/dev/null ||
	fail "running service does not use the configured port"

if [ "$run_smoke" -eq 1 ]; then
	direct_output=$("$claude_bin" --model 'fable[1m]' --print 'Return only: direct-ok')
	[ "$direct_output" = 'direct-ok' ] || fail "direct subscription smoke test failed"
	passthrough_output=$("$claudex_bin" fable --print 'Return only: passthrough-ok')
	[ "$passthrough_output" = 'passthrough-ok' ] ||
		fail "passthrough subscription smoke test failed"
	translated_output=$("$claudex_bin" "$model_alias" --print 'Return only: translated-ok')
	[ "$translated_output" = 'translated-ok' ] ||
		fail "translated subscription smoke test failed"
	printf '%s\n' 'direct, passthrough, and translated smoke tests passed'
else
	printf '%s\n' 'service verification passed; rerun with --smoke for inference checks'
fi

printf '%s\n' 'live setup verification passed'
