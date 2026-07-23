#!/bin/sh

set -eu

fail() {
	printf 'live verification failed: %s\n' "$1" >&2
	exit 1
}

setup_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=versions.env
. "$setup_dir/versions.env"

run_smoke=0
case "${1:-}" in
'') ;;
--smoke)
	run_smoke=1
	;;
*)
	printf '%s\n' 'usage: verify-live.sh [--smoke]' >&2
	exit 2
	;;
esac

"$setup_dir/verify-static.sh"

for command_name in grep mise stat systemctl tr; do
	command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is unavailable"
done

claude_bin=${CLAUDE_BIN:-"$HOME/.local/bin/claude"}
claudex_bin=${CLAUDEX_BIN:-"$HOME/.local/bin/claudex"}
clodex_bin=${CLODEX_BIN:-"$HOME/.local/bin/clodex"}
node_bin="$(mise where "node@$CLODEX_NODE_VERSION")/bin/node"
clodex_home="$HOME/.local/share/claudex-clodex"
runtime="$clodex_home/runtime/current/dist/cli.js"
process_wrapper="$clodex_home/runtime/current/dist/claude-wrapper.js"

systemctl --user start claudex-clodex.service

ready=0
attempt=0
while [ "$attempt" -lt 50 ]; do
	if CLODEX_HOME="$clodex_home" "$node_bin" "$process_wrapper" --check; then
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

provider_output=$("$clodex_bin" providers list)
provider_line=$(printf '%s\n' "$provider_output" | grep -F "($CLODEX_PROVIDER_ID)" || :)
[ -n "$provider_line" ] || fail "the expected provider is unavailable"
printf '%s\n' "$provider_line" | grep -F 'auth: helper (OAuth)' >/dev/null ||
	fail "the expected provider is not using the external OAuth helper"
printf 'provider %s: external OAuth configured\n' "$CLODEX_PROVIDER_ID"

main_pid=$(systemctl --user show --property MainPID --value claudex-clodex.service)
case "$main_pid" in
'' | 0 | *[!0-9]*) fail "service has no valid main process" ;;
esac
[ -r "/proc/$main_pid/cmdline" ] || fail "service command line is unavailable"
[ -e "/proc/$main_pid/cwd" ] || fail "service working directory is unavailable"
runtime_root=$(CDPATH='' cd -- "$HOME/.local/share/claudex-clodex/runtime/current" && pwd -P)
service_cwd_identity=$(stat -Lc '%d:%i' "/proc/$main_pid/cwd")
runtime_identity=$(stat -Lc '%d:%i' "$runtime_root")
[ "$service_cwd_identity" = "$runtime_identity" ] ||
	fail "running service has not loaded the selected runtime"
service_arguments=$(tr '\000' '\n' <"/proc/$main_pid/cmdline")
printf '%s\n' "$service_arguments" | grep -Fx "$node_bin" >/dev/null ||
	fail "running service does not use the pinned Node.js executable"
printf '%s\n' "$service_arguments" | grep -Fx "$runtime" >/dev/null ||
	fail "running service does not use the selected runtime"
printf '%s\n' "$service_arguments" | grep -Fx -- "$CLODEX_PORT" >/dev/null ||
	fail "running service does not use the configured port"

if [ "$run_smoke" -eq 1 ]; then
	direct_output=$("$claude_bin" --model 'fable[1m]' --print 'Return only: direct-ok')
	[ "$direct_output" = 'direct-ok' ] || fail "direct subscription smoke test failed"
	passthrough_output=$("$claudex_bin" fable --print 'Return only: passthrough-ok')
	[ "$passthrough_output" = 'passthrough-ok' ] ||
		fail "passthrough subscription smoke test failed"
	translated_output=$("$claudex_bin" "$CLODEX_MODEL_ALIAS" --print 'Return only: translated-ok')
	[ "$translated_output" = 'translated-ok' ] ||
		fail "translated subscription smoke test failed"
	printf '%s\n' 'direct, passthrough, and translated smoke tests passed'
else
	printf '%s\n' 'service verification passed; rerun with --smoke for inference checks'
fi

printf '%s\n' 'live setup verification passed'
