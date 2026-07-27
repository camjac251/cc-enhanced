#!/bin/sh

set -eu

fail() {
	printf 'service-control test failed: %s\n' "$1" >&2
	exit 1
}

setup_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' 0 HUP INT TERM

fake_bin="$test_root/fake-bin"
test_home="$test_root/home"
clodex_home="$test_home/.local/share/claudex-clodex"
session_lock="$clodex_home/routed-sessions.lock"
process_wrapper="$test_root/clodex-claude"
clodex_bin="$test_root/clodex-cli.js"
launcher_process_wrapper="$test_root/claudex-process-wrapper"
prompt_composer="$test_root/claudex-compose-system-prompt"
credential_helper="$test_root/credential-helper"
claude_bin="$test_root/claude"
system_prompt="$test_home/.config/claudex-clodex/system-prompt.md"
mkdir -p "$fake_bin" "$clodex_home" "$(dirname "$system_prompt")"

tee "$process_wrapper" >/dev/null <<'SH'
#!/bin/sh
exit 88
SH
tee "$clodex_bin" >/dev/null <<'SH'
#!/bin/sh
exit 0
SH
tee "$launcher_process_wrapper" >/dev/null <<'SH'
#!/bin/sh
[ "$CLAUDE_CODE_PROCESS_WRAPPER" = "$TEST_LAUNCHER_WRAPPER" ] || {
	printf '%s\n' 'portable process wrapper was not propagated' >&2
	exit 8
}
exec 7>"$TEST_SESSION_LOCK"
if flock -n -x 7; then
	printf '%s\n' 'routed session lock was not inherited' >&2
	exit 9
fi
printf '%s\n' 'routed session lock is held'
SH
tee "$credential_helper" >/dev/null <<'SH'
#!/bin/sh
exit 0
SH
tee "$claude_bin" >/dev/null <<'SH'
#!/bin/sh
exit 0
SH
tee "$prompt_composer" >/dev/null <<'SH'
#!/bin/sh
printf '%s\n' 'prompt composer invoked' >>"$CONTROL_LOG"
SH
: >"$system_prompt"
chmod 700 \
	"$process_wrapper" \
	"$clodex_bin" \
	"$launcher_process_wrapper" \
	"$prompt_composer" \
	"$credential_helper" \
	"$claude_bin"

tee "$fake_bin/node" >/dev/null <<'SH'
#!/bin/sh
target=$1
shift
printf 'node %s' "$target" >>"$CONTROL_LOG"
if [ "$#" -gt 0 ]; then
	printf ' %s' "$*" >>"$CONTROL_LOG"
fi
printf '\n' >>"$CONTROL_LOG"
if [ "$target" = "$TEST_CLODEX_BIN" ] && [ "${1:-}" = '--version' ]; then
	printf '%s\n' "${CLODEX_VERSION:-2.1.2}"
	exit 0
fi
exit "${READY_EXIT:-0}"
SH
tee "$fake_bin/systemctl" >/dev/null <<'SH'
#!/bin/sh
if [ "${1:-}" = '--user' ]; then
	shift
fi
command_name=${1:-}
shift || :
printf 'systemctl %s' "$command_name" >>"$CONTROL_LOG"
if [ "$#" -gt 0 ]; then
	printf ' %s' "$*" >>"$CONTROL_LOG"
fi
printf '\n' >>"$CONTROL_LOG"
case "$command_name" in
start) exit 0 ;;
restart) exit "${RESTART_EXIT:-0}" ;;
is-active) exit "${ACTIVE_EXIT:-0}" ;;
is-failed) exit "${FAILED_EXIT:-1}" ;;
show)
	printf '%s\n' "${MAIN_PID:-0}"
	;;
status)
	printf '%s\n' 'test service status' >&2
	;;
*) exit 1 ;;
esac
SH
tee "$fake_bin/sleep" >/dev/null <<'SH'
#!/bin/sh
printf 'sleep %s\n' "$*" >>"$CONTROL_LOG"
SH
chmod 700 "$fake_bin/node" "$fake_bin/systemctl" "$fake_bin/sleep"

controller_template="$setup_dir/templates/clodex-service"
[ -r "$controller_template" ] || fail "the service controller template is missing"
controller="$test_root/clodex-service"
sed \
	-e "s|@NODE_BIN@|$fake_bin/node|g" \
	-e "s|@CLODEX_BIN@|$clodex_bin|g" \
	-e "s|@CLODEX_CLAUDE_BIN@|$process_wrapper|g" \
	"$controller_template" >"$controller"
chmod 700 "$controller"

launcher="$test_root/claudex"
sed \
	-e "s|@NODE_BIN@|$fake_bin/node|g" \
	-e "s|@CLAUDE_BIN@|$claude_bin|g" \
	-e "s|@CLODEX_CLAUDE_BIN@|$process_wrapper|g" \
	-e "s|@CLAUDEX_PROCESS_WRAPPER@|$launcher_process_wrapper|g" \
	-e "s|@CLAUDEX_PROMPT_COMPOSER@|$prompt_composer|g" \
	-e "s|@CLODEX_CREDENTIAL_HELPER@|$credential_helper|g" \
	"$setup_dir/templates/claudex" >"$launcher"
chmod 700 "$launcher"

control_log="$test_root/control.log"
: >"$control_log"
PATH="$fake_bin:/usr/bin:/bin" HOME="$test_home" \
	CONTROL_LOG="$control_log" TEST_SESSION_LOCK="$session_lock" \
	TEST_LAUNCHER_WRAPPER="$launcher_process_wrapper" \
	"$launcher" >"$test_root/launcher.out"
grep -Fx 'routed session lock is held' "$test_root/launcher.out" >/dev/null ||
	fail "the routed launcher did not retain its shared lock for the client lifetime"
grep -Fx 'prompt composer invoked' "$control_log" >/dev/null ||
	fail "the routed launcher did not refresh the default prompt"
grep -Fx "node $process_wrapper --check" "$control_log" >/dev/null ||
	fail "the routed launcher did not use the configured Node.js executable for readiness"

: >"$control_log"
if PATH="$fake_bin:/usr/bin:/bin" HOME="$test_home" \
	CONTROL_LOG="$control_log" "$launcher" \
	--append-system-prompt 'unreviewed override' \
	>"$test_root/prompt-override.out" 2>"$test_root/prompt-override.err"; then
	fail "the routed launcher accepted a competing append prompt"
else
	prompt_override_exit=$?
fi
[ "$prompt_override_exit" -eq 2 ] ||
	fail "the competing append prompt did not exit 2"
grep -F 'CLAUDEX_SYSTEM_PROMPT_FILE' "$test_root/prompt-override.err" >/dev/null ||
	fail "the competing append prompt error did not name the supported override"
[ ! -s "$control_log" ] ||
	fail "the rejected append prompt reached service startup"

: >"$control_log"
if PATH="$fake_bin:/usr/bin:/bin" HOME="$test_home" \
	CONTROL_LOG="$control_log" "$controller" \
	>"$test_root/usage.out" 2>"$test_root/usage.err"; then
	fail "the service controller accepted a missing operation"
else
	controller_exit=$?
fi
[ "$controller_exit" -eq 2 ] ||
	fail "invalid service-controller arguments did not exit 2"
grep -F 'usage: clodex-service restart' "$test_root/usage.err" >/dev/null ||
	fail "the service controller did not print usage"
[ ! -s "$control_log" ] ||
	fail "invalid arguments reached the service-control boundary"

exec 8>"$session_lock"
flock -s 8
: >"$control_log"
if PATH="$fake_bin:/usr/bin:/bin" HOME="$test_home" \
	CONTROL_LOG="$control_log" TEST_CLODEX_BIN="$clodex_bin" \
	"$controller" restart \
	>"$test_root/locked-controller.out" 2>"$test_root/locked-controller.err"; then
	fail "the service controller restarted while a routed-session lock was held"
fi
grep -F 'routed client processes are still active' \
	"$test_root/locked-controller.err" >/dev/null ||
	fail "the routed-session lock error was not specific"
if grep -F 'systemctl restart' "$control_log" >/dev/null; then
	fail "the routed-session lock was acquired after the restart request"
fi
flock -u 8
exec 8>&-

: >"$control_log"
PATH="$fake_bin:/usr/bin:/bin" HOME="$test_home" \
	CONTROL_LOG="$control_log" TEST_CLODEX_BIN="$clodex_bin" \
	MAIN_PID=$$ RESTART_EXIT=0 ACTIVE_EXIT=0 READY_EXIT=0 FAILED_EXIT=1 \
	"$controller" restart >"$test_root/success.out"
grep -F "routing service ready: pid=$$ clodex=2.1.2" \
	"$test_root/success.out" >/dev/null ||
	fail "the service controller did not report the loaded process and Clodex version"
[ "$(sed -n '1p' "$control_log")" = 'systemctl restart claudex-clodex.service' ] ||
	fail "the service controller did not begin with the guarded restart"
[ "$(sed -n '2p' "$control_log")" = 'systemctl is-active --quiet claudex-clodex.service' ] ||
	fail "readiness did not verify the active unit"
[ "$(sed -n '3p' "$control_log")" = "node $process_wrapper --check" ] ||
	fail "readiness did not use the globally activated Clodex wrapper"
[ "$(sed -n '4p' "$control_log")" = \
	'systemctl show --property MainPID --value claudex-clodex.service' ] ||
	fail "readiness did not inspect the loaded service process"
[ "$(sed -n '5p' "$control_log")" = "node $clodex_bin --version" ] ||
	fail "readiness did not report the globally activated Clodex version"

: >"$control_log"
if PATH="$fake_bin:/usr/bin:/bin" HOME="$test_home" \
	CONTROL_LOG="$control_log" TEST_CLODEX_BIN="$clodex_bin" \
	MAIN_PID=$$ RESTART_EXIT=1 \
	"$controller" restart \
	>"$test_root/restart-failure.out" 2>"$test_root/restart-failure.err"; then
	fail "the service controller accepted a failed restart"
fi
grep -F 'systemctl status claudex-clodex.service --no-pager' "$control_log" >/dev/null ||
	fail "a failed restart did not capture service status"
if grep -F 'node ' "$control_log" >/dev/null; then
	fail "readiness ran after a failed restart"
fi

: >"$control_log"
if PATH="$fake_bin:/usr/bin:/bin" HOME="$test_home" \
	CONTROL_LOG="$control_log" TEST_CLODEX_BIN="$clodex_bin" \
	MAIN_PID=0 RESTART_EXIT=0 ACTIVE_EXIT=0 READY_EXIT=0 FAILED_EXIT=1 \
	"$controller" restart \
	>"$test_root/invalid-pid.out" 2>"$test_root/invalid-pid.err"; then
	fail "the service controller accepted an invalid main process"
fi
grep -F 'service has no valid main process' "$test_root/invalid-pid.err" >/dev/null ||
	fail "the invalid-main-process error was not specific"

: >"$control_log"
if PATH="$fake_bin:/usr/bin:/bin" HOME="$test_home" \
	CONTROL_LOG="$control_log" TEST_CLODEX_BIN="$clodex_bin" \
	MAIN_PID=$$ RESTART_EXIT=0 ACTIVE_EXIT=1 READY_EXIT=1 FAILED_EXIT=0 \
	"$controller" restart \
	>"$test_root/failed-unit.out" 2>"$test_root/failed-unit.err"; then
	fail "the service controller accepted a failed unit"
fi
grep -F 'systemctl status claudex-clodex.service --no-pager' "$control_log" >/dev/null ||
	fail "a failed unit did not capture service status"
if grep -F 'sleep ' "$control_log" >/dev/null; then
	fail "readiness polling continued after the unit failed"
fi

: >"$control_log"
if PATH="$fake_bin:/usr/bin:/bin" HOME="$test_home" \
	CONTROL_LOG="$control_log" TEST_CLODEX_BIN="$clodex_bin" \
	MAIN_PID=$$ RESTART_EXIT=0 ACTIVE_EXIT=0 READY_EXIT=1 FAILED_EXIT=1 \
	"$controller" restart \
	>"$test_root/readiness-timeout.out" 2>"$test_root/readiness-timeout.err"; then
	fail "the service controller accepted a readiness timeout"
fi
[ "$(grep -c '^sleep 0.2$' "$control_log")" -eq 50 ] ||
	fail "readiness polling did not use the bounded attempt budget"

printf '%s\n' 'service-control tests passed'
