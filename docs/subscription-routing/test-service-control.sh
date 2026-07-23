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
proc_root="$test_root/proc"
mkdir -p "$fake_bin" "$test_home" "$proc_root/self" "$proc_root/101"
printf 'test-shell\000' >"$proc_root/self/cmdline"

if PATH="/usr/bin:/bin" HOME="$test_home" \
	CLAUDEX_PROC_ROOT="$test_root/missing-proc" \
	"$setup_dir/check-routed-idle.sh" \
	>"$test_root/missing-proc.out" 2>"$test_root/missing-proc.err"; then
	fail "the idle guard accepted an unreadable process table"
fi
grep -F 'cannot inspect routed client state' "$test_root/missing-proc.err" >/dev/null ||
	fail "the unreadable-process-table error was not specific"

expected_wrapper="$test_home/.local/share/claudex-clodex/runtime/current/dist/claude-wrapper.js"
printf 'node\000%s\000' "$expected_wrapper" >"$proc_root/101/cmdline"

if PATH="/usr/bin:/bin" HOME="$test_home" \
	CLAUDEX_PROC_ROOT="$proc_root" \
	"$setup_dir/check-routed-idle.sh" \
	>"$test_root/active.out" 2>"$test_root/active.err"; then
	fail "the idle guard accepted an active routed client"
fi
grep -F 'routed client processes are still active' "$test_root/active.err" >/dev/null ||
	fail "the active-client error was not specific"

rm "$proc_root/101/cmdline"
PATH="/usr/bin:/bin" HOME="$test_home" \
	CLAUDEX_PROC_ROOT="$proc_root" \
	"$setup_dir/check-routed-idle.sh" >"$test_root/idle.out"
grep -Fx 'no routed client process is active' "$test_root/idle.out" >/dev/null ||
	fail "the idle guard did not report a clean state"

controller_template="$setup_dir/templates/clodex-service"
[ -r "$controller_template" ] || fail "the service controller template is missing"

runtime_parent="$test_home/.local/share/claudex-clodex/runtime"
runtime_id='test-runtime'
runtime_root="$runtime_parent/$runtime_id"
process_wrapper="$runtime_root/dist/claude-wrapper.js"
session_lock="$runtime_parent/routed-sessions.lock"
installed_guard="$test_home/.local/libexec/claudex-check-routed-idle"
mkdir -p "$runtime_root/dist" "$test_home/.local/libexec"
ln -s "$runtime_id" "$runtime_parent/current"
cat >"$process_wrapper" <<'SH'
#!/bin/sh
if [ "${1:-}" = '--check' ]; then
	exit 0
fi
exec 7>"$TEST_SESSION_LOCK"
if flock -n -x 7; then
	printf '%s\n' 'routed session lock was not inherited' >&2
	exit 9
fi
printf '%s\n' 'routed session lock is held'
SH
chmod 700 "$process_wrapper"
cp "$setup_dir/check-routed-idle.sh" "$installed_guard"
chmod 700 "$installed_guard"

cat >"$fake_bin/node" <<'SH'
#!/bin/sh
printf 'node %s\n' "$*" >>"$CONTROL_LOG"
exit "${READY_EXIT:-0}"
SH
cat >"$fake_bin/systemctl" <<'SH'
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
cat >"$fake_bin/sleep" <<'SH'
#!/bin/sh
printf 'sleep %s\n' "$*" >>"$CONTROL_LOG"
SH
chmod 700 "$fake_bin/node" "$fake_bin/systemctl" "$fake_bin/sleep"

controller="$test_root/clodex-service"
sed "s|@NODE_BIN@|$fake_bin/node|g" "$controller_template" >"$controller"
chmod 700 "$controller"

control_log="$test_root/control.log"
: >"$control_log"
credential_helper="$test_root/credential-helper"
claude_bin="$test_root/claude"
system_prompt="$test_home/.config/claudex-clodex/system-prompt.md"
mkdir -p "$(dirname "$system_prompt")"
: >"$credential_helper"
: >"$claude_bin"
: >"$system_prompt"
chmod 700 "$credential_helper" "$claude_bin"
launcher="$test_root/claudex"
sed \
	-e "s|@CLAUDE_BIN@|$claude_bin|g" \
	-e "s|@CLODEX_CREDENTIAL_HELPER@|$credential_helper|g" \
	-e 's|@CLODEX_PROVIDER_ID@|provider|g' \
	-e 's|@CLODEX_MODEL_ID@|model|g' \
	-e 's|@CLODEX_MODEL_ALIAS@|route|g' \
	-e 's|@CLODEX_MODEL_DISPLAY_NAME@|Routed Model|g' \
	-e 's|@CLODEX_MODEL_DESCRIPTION@|Test route|g' \
	-e 's|@CLODEX_BILLING_LABEL@|Subscription route|g' \
	-e 's|@CLODEX_MODEL_MAX_INPUT_TOKENS@|100000|g' \
	-e 's|@CLODEX_MODEL_MAX_OUTPUT_TOKENS@|10000|g' \
	"$setup_dir/templates/claudex" >"$launcher"
chmod 700 "$launcher"
PATH="$fake_bin:/usr/bin:/bin" HOME="$test_home" \
	CONTROL_LOG="$control_log" TEST_SESSION_LOCK="$session_lock" \
	"$launcher" >"$test_root/launcher.out"
grep -Fx 'routed session lock is held' "$test_root/launcher.out" >/dev/null ||
	fail "the routed launcher did not retain its shared lock for the client lifetime"

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

printf 'node\000%s\000' "$expected_wrapper" >"$proc_root/101/cmdline"
: >"$control_log"
if PATH="$fake_bin:/usr/bin:/bin" HOME="$test_home" \
	CONTROL_LOG="$control_log" CLAUDEX_PROC_ROOT="$proc_root" \
	"$controller" restart \
	>"$test_root/active-controller.out" 2>"$test_root/active-controller.err"; then
	fail "the service controller restarted with an active routed client"
fi
if grep -F 'systemctl restart' "$control_log" >/dev/null; then
	fail "the active-client guard ran after the restart request"
fi
rm "$proc_root/101/cmdline"

exec 8>"$session_lock"
flock -s 8
: >"$control_log"
if PATH="$fake_bin:/usr/bin:/bin" HOME="$test_home" \
	CONTROL_LOG="$control_log" CLAUDEX_PROC_ROOT="$proc_root" \
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

cd "$runtime_root"
: >"$control_log"
PATH="$fake_bin:/usr/bin:/bin" HOME="$test_home" \
	CONTROL_LOG="$control_log" CLAUDEX_PROC_ROOT="$proc_root" \
	MAIN_PID=$$ RESTART_EXIT=0 ACTIVE_EXIT=0 READY_EXIT=0 FAILED_EXIT=1 \
	"$controller" restart >"$test_root/success.out"
grep -F "routing service ready: pid=$$ runtime=$runtime_root" \
	"$test_root/success.out" >/dev/null ||
	fail "the service controller did not report the loaded process and runtime"
[ "$(sed -n '1p' "$control_log")" = 'systemctl restart claudex-clodex.service' ] ||
	fail "the restart did not follow the idle guard"
[ "$(sed -n '2p' "$control_log")" = 'systemctl is-active --quiet claudex-clodex.service' ] ||
	fail "readiness did not verify the active unit"
[ "$(sed -n '3p' "$control_log")" = "node $expected_wrapper --check" ] ||
	fail "readiness did not use the pinned runtime wrapper"

: >"$control_log"
if PATH="$fake_bin:/usr/bin:/bin" HOME="$test_home" \
	CONTROL_LOG="$control_log" CLAUDEX_PROC_ROOT="$proc_root" \
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
	CONTROL_LOG="$control_log" CLAUDEX_PROC_ROOT="$proc_root" \
	MAIN_PID=0 RESTART_EXIT=0 ACTIVE_EXIT=0 READY_EXIT=0 FAILED_EXIT=1 \
	"$controller" restart \
	>"$test_root/invalid-pid.out" 2>"$test_root/invalid-pid.err"; then
	fail "the service controller accepted an invalid main process"
fi
grep -F 'service has no valid main process' "$test_root/invalid-pid.err" >/dev/null ||
	fail "the invalid-main-process error was not specific"

: >"$control_log"
if PATH="$fake_bin:/usr/bin:/bin" HOME="$test_home" \
	CONTROL_LOG="$control_log" CLAUDEX_PROC_ROOT="$proc_root" \
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
	CONTROL_LOG="$control_log" CLAUDEX_PROC_ROOT="$proc_root" \
	MAIN_PID=$$ RESTART_EXIT=0 ACTIVE_EXIT=0 READY_EXIT=1 FAILED_EXIT=1 \
	"$controller" restart \
	>"$test_root/readiness-timeout.out" 2>"$test_root/readiness-timeout.err"; then
	fail "the service controller accepted a readiness timeout"
fi
[ "$(grep -c '^sleep 0.2$' "$control_log")" -eq 50 ] ||
	fail "readiness polling did not use the bounded attempt budget"

other_runtime_id='other-runtime'
other_runtime_root="$runtime_parent/$other_runtime_id"
mkdir -p "$other_runtime_root/dist"
: >"$other_runtime_root/dist/claude-wrapper.js"
rm "$runtime_parent/current"
ln -s "$other_runtime_id" "$runtime_parent/current"
: >"$control_log"
if PATH="$fake_bin:/usr/bin:/bin" HOME="$test_home" \
	CONTROL_LOG="$control_log" CLAUDEX_PROC_ROOT="$proc_root" \
	MAIN_PID=$$ RESTART_EXIT=0 ACTIVE_EXIT=0 READY_EXIT=0 FAILED_EXIT=1 \
	"$controller" restart \
	>"$test_root/runtime-mismatch.out" 2>"$test_root/runtime-mismatch.err"; then
	fail "the service controller accepted a different loaded runtime"
fi
grep -F 'running service has not loaded the selected runtime' \
	"$test_root/runtime-mismatch.err" >/dev/null ||
	fail "the loaded-runtime mismatch was not specific"

printf '%s\n' 'service-control tests passed'
