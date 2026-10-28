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
for argument in "$@"; do
	case "$argument" in
	--smoke)
		run_smoke=1
		;;
	--model=sol | --model=terra | --model=luna)
		model_alias=${argument#--model=}
		;;
	*)
		printf '%s\n' 'usage: verify-live.sh [--smoke] [--model=sol|terra|luna]' >&2
		exit 2
		;;
	esac
done

"$setup_dir/verify-static.sh"

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
	command -v timeout >/dev/null 2>&1 || fail "timeout is required for bounded inference checks"
	# Resolve overrides before leaving the caller's directory.
	claude_bin=$(command -v "$claude_bin") || fail "Claude Code is unavailable"
	claudex_bin=$(command -v "$claudex_bin") || fail "claudex is unavailable"
	case "$claude_bin" in
	/*) ;;
	*) claude_bin="$PWD/$claude_bin" ;;
	esac
	case "$claudex_bin" in
	/*) ;;
	*) claudex_bin="$PWD/$claudex_bin" ;;
	esac

	smoke_root=$(mktemp -d /tmp/claudex-smoke.XXXXXX)
	smoke_pid=''
	cleanup_smoke() {
		if [ -n "$smoke_pid" ]; then
			kill "$smoke_pid" 2>/dev/null || :
			wait "$smoke_pid" 2>/dev/null || :
		fi
		rm -rf -- "$smoke_root"
	}
	trap cleanup_smoke 0
	trap 'exit 129' HUP
	trap 'exit 130' INT
	trap 'exit 143' TERM
	mkdir "$smoke_root/workspace"
	printf '%s\n' 'Return only the requested verification text.' >"$smoke_root/prompt"

	# Safe mode omits user/project instructions, plugins, hooks, and memory
	# without changing HOME or OAuth configuration. Managed policy still applies.
	# The routed launcher uses only this append, not its normal composed prompt.
	run_smoke_prompt() {
		smoke_phase=$1
		shift
		printf 'checking %s inference...\n' "$smoke_phase"
		(
			CDPATH='' cd -- "$smoke_root/workspace"
			export CC_ENHANCED_DISABLE=1
			export CLAUDEX_SYSTEM_PROMPT_FILE="$smoke_root/prompt"
			exec timeout --kill-after=5s 90s "$@" \
				--safe-mode \
				--system-prompt 'Return exactly the requested text and nothing else.' \
				--tools '' --disallowedTools '*' \
				--strict-mcp-config --mcp-config '{"mcpServers":{}}' \
				--no-session-persistence --max-turns 1 \
				--settings '{"env":{"API_TIMEOUT_MS":"60000","CLAUDE_CODE_MAX_RETRIES":"0","CLAUDE_CODE_RETRY_WATCHDOG":"0","CLAUDE_ENABLE_STREAM_WATCHDOG":"0"}}' \
				--output-format text </dev/null
		) >"$smoke_root/output" &
		smoke_pid=$!
		# Waiting on a background child lets signal traps stop it before cleanup.
		if wait "$smoke_pid"; then
			smoke_status=0
		else
			smoke_status=$?
		fi
		smoke_pid=''
		if [ "$smoke_status" -ne 0 ]; then
			cat "$smoke_root/output" >&2
			case "$smoke_status" in
			124 | 137) fail "$smoke_phase inference timed out after 90 seconds" ;;
			*) fail "$smoke_phase inference failed (exit $smoke_status)" ;;
			esac
		fi
		smoke_output=$(cat "$smoke_root/output")
	}

	# Test the actual routed request first: saved model metadata can outlive OAuth.
	run_smoke_prompt translated "$claudex_bin" "$model_alias" --print 'Return only: translated-ok'
	[ "$smoke_output" = 'translated-ok' ] ||
		fail "translated subscription smoke test failed"
	run_smoke_prompt direct "$claude_bin" --model 'fable[1m]' --print 'Return only: direct-ok'
	[ "$smoke_output" = 'direct-ok' ] || fail "direct subscription smoke test failed"
	run_smoke_prompt passthrough "$claudex_bin" fable --print 'Return only: passthrough-ok'
	[ "$smoke_output" = 'passthrough-ok' ] ||
		fail "passthrough subscription smoke test failed"
	printf '%s\n' 'direct, passthrough, and translated smoke tests passed'
else
	printf '%s\n' 'service verification passed; rerun with --smoke for inference checks'
fi

printf '%s\n' 'live setup verification passed'
