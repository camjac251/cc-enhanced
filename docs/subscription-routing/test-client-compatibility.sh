#!/bin/sh

set -eu

fail() {
	printf 'client-compatibility test failed: %s\n' "$1" >&2
	exit 1
}

setup_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' 0 HUP INT TERM

test_home="$test_root/home"
clodex_wrapper="$test_root/clodex-claude"
clodex_cli="$test_root/clodex-cli.js"
system_prompt="$test_home/.config/claudex-clodex/system-prompt.md"
credential_helper="$test_root/credential-helper"
claude_bin="$test_root/claude"
mkdir -p "$(dirname "$system_prompt")"
printf '%s\n%s\n' 'Route translated model requests through Clodex.' \
	'Keep native model requests on the normal subscription.' >"$system_prompt"

tee "$clodex_wrapper" >/dev/null <<'SH'
#!/bin/sh
for arg; do
	printf '%s\n' "$arg"
done
SH
tee "$clodex_cli" >/dev/null <<'SH'
#!/bin/sh
printf '%s' "$0" >>"$ADMIN_LOG"
for arg; do
	printf ' %s' "$arg" >>"$ADMIN_LOG"
done
printf '\n' >>"$ADMIN_LOG"
SH
tee "$credential_helper" >/dev/null <<'SH'
#!/bin/sh
exit 0
SH
chmod 700 "$clodex_wrapper" "$clodex_cli" "$credential_helper"

process_wrapper_template="$setup_dir/templates/claudex-process-wrapper"
[ -r "$process_wrapper_template" ] ||
	fail "the portable process-wrapper template is missing"
process_wrapper="$test_root/claudex-process-wrapper-stock"
sed \
	-e "s|@CLODEX_CLAUDE_BIN@|$clodex_wrapper|g" \
	-e "s|@CLAUDEX_CLIENT_PROFILE@|stock|g" \
	"$process_wrapper_template" >"$process_wrapper"
chmod 700 "$process_wrapper"

enhanced_process_wrapper="$test_root/claudex-process-wrapper-enhanced"
sed \
	-e "s|@CLODEX_CLAUDE_BIN@|$clodex_wrapper|g" \
	-e "s|@CLAUDEX_CLIENT_PROFILE@|enhanced|g" \
	"$process_wrapper_template" >"$enhanced_process_wrapper"
chmod 700 "$enhanced_process_wrapper"

tee "$claude_bin" >/dev/null <<'SH'
#!/bin/sh
printf '%s\n' '0.0.0 (Claude Code; patched: configured-model-catalog)'
SH
chmod 700 "$claude_bin"

HOME="$test_home" CLAUDEX_SYSTEM_PROMPT_FILE="$system_prompt" \
	"$enhanced_process_wrapper" "$claude_bin" --model sol \
	>"$test_root/enhanced.args"
if grep -E '^--append-(system|subagent-system)-prompt' \
	"$test_root/enhanced.args" >/dev/null; then
	fail "the enhanced profile duplicated native prompt propagation"
fi
grep -Fx -- '--model' "$test_root/enhanced.args" >/dev/null ||
	fail "the enhanced profile dropped the original model argument"
grep -Fx 'sol' "$test_root/enhanced.args" >/dev/null ||
	fail "the enhanced profile dropped the original model value"

HOME="$test_home" CLAUDEX_SYSTEM_PROMPT_FILE="$system_prompt" \
	"$process_wrapper" "$claude_bin" --model sol >"$test_root/injected.args"
[ "$(grep -Fxc -- '--append-system-prompt-file' "$test_root/injected.args")" -eq 1 ] ||
	fail "the parent prompt file flag was not injected exactly once"
[ "$(grep -Fxc -- "$system_prompt" "$test_root/injected.args")" -eq 1 ] ||
	fail "the routed prompt path was not forwarded"
[ "$(grep -Fxc -- '--append-subagent-system-prompt' "$test_root/injected.args")" -eq 1 ] ||
	fail "the subagent prompt flag was not injected exactly once"
grep -Fx 'Route translated model requests through Clodex.
Keep native model requests on the normal subscription.' \
	"$test_root/injected.args" >/dev/null ||
	fail "the routed subagent prompt was not forwarded as one argument"
grep -Fx -- '--model' "$test_root/injected.args" >/dev/null ||
	fail "the original Claude arguments were not retained"
grep -Fx 'sol' "$test_root/injected.args" >/dev/null ||
	fail "the original model argument was not retained"

launcher_process_wrapper="$test_root/launcher-process-wrapper"
prompt_composer="$test_root/prompt-composer"
test_bin="$test_root/bin"
mkdir -p "$test_bin" "$test_home/.local/share/claudex-clodex"
tee "$launcher_process_wrapper" >/dev/null <<'SH'
#!/bin/sh
printf 'auto-model=%s\n' "${CLAUDE_CODE_AUTO_MODE_MODEL-unset}"
shift
for arg; do
	printf 'arg=%s\n' "$arg"
done
SH
tee "$prompt_composer" >/dev/null <<'SH'
#!/bin/sh
exit 0
SH
tee "$test_bin/systemctl" >/dev/null <<'SH'
#!/bin/sh
exit 0
SH
chmod 700 "$launcher_process_wrapper" "$prompt_composer" "$test_bin/systemctl"

launcher_template="$setup_dir/templates/claudex"
launcher="$test_root/claudex"
sed \
	-e "s|@CLAUDE_BIN@|$claude_bin|g" \
	-e "s|@CLODEX_CLAUDE_BIN@|$clodex_wrapper|g" \
	-e "s|@CLAUDEX_PROCESS_WRAPPER@|$launcher_process_wrapper|g" \
	-e "s|@CLAUDEX_PROMPT_COMPOSER@|$prompt_composer|g" \
	-e "s|@CLODEX_CREDENTIAL_HELPER@|$credential_helper|g" \
	"$launcher_template" >"$launcher"
chmod 700 "$launcher"

HOME="$test_home" PATH="$test_bin:$PATH" \
	CLAUDEX_SYSTEM_PROMPT_FILE="$system_prompt" \
	CLAUDE_CODE_AUTO_MODE_MODEL=inherited \
	"$launcher" sol >"$test_root/launcher-sol.out"
grep -Fx 'auto-model=sol' "$test_root/launcher-sol.out" >/dev/null ||
	fail "the Sol shortcut did not select Sol for later auto-mode classification"
grep -Fx 'arg=--model' "$test_root/launcher-sol.out" >/dev/null ||
	fail "the Sol shortcut dropped the model flag"
grep -Fx 'arg=sol' "$test_root/launcher-sol.out" >/dev/null ||
	fail "the Sol shortcut dropped the model value"

HOME="$test_home" PATH="$test_bin:$PATH" \
	CLAUDEX_SYSTEM_PROMPT_FILE="$system_prompt" \
	CLAUDE_CODE_AUTO_MODE_MODEL=inherited \
	"$launcher" opus >"$test_root/launcher-opus.out"
grep -Fx 'auto-model=unset' "$test_root/launcher-opus.out" >/dev/null ||
	fail "a non-Sol shortcut retained an unreviewed auto-mode model override"

HOME="$test_home" CLAUDEX_SYSTEM_PROMPT_FILE="$system_prompt" \
	"$process_wrapper" "$claude_bin" -- \
	--append-system-prompt --append-subagent-system-prompt \
	>"$test_root/separator.args"
[ "$(grep -Fxc -- '--append-system-prompt-file' "$test_root/separator.args")" -eq 1 ] ||
	fail "a positional prompt flag suppressed the managed parent prompt"
[ "$(grep -Fxc -- '--append-subagent-system-prompt' "$test_root/separator.args")" -eq 2 ] ||
	fail "a positional prompt flag suppressed the managed subagent prompt"
grep -Fx 'Route translated model requests through Clodex.
Keep native model requests on the normal subscription.' \
	"$test_root/separator.args" >/dev/null ||
	fail "the managed subagent prompt was not forwarded after the argument separator"

HOME="$test_home" CLAUDEX_SYSTEM_PROMPT_FILE="$system_prompt" \
	"$process_wrapper" "$claude_bin" \
	--append-system-prompt 'existing parent prompt' \
	--append-subagent-system-prompt 'existing child prompt' \
	>"$test_root/existing.args"
[ "$(grep -Fxc -- '--append-system-prompt' "$test_root/existing.args")" -eq 1 ] ||
	fail "an existing parent prompt flag was duplicated"
[ "$(grep -Fxc -- '--append-subagent-system-prompt' "$test_root/existing.args")" -eq 1 ] ||
	fail "an existing subagent prompt flag was duplicated"
if grep -Fx -- '--append-system-prompt-file' "$test_root/existing.args" >/dev/null; then
	fail "the prompt file flag was injected over an existing parent prompt"
fi

admin_template="$setup_dir/templates/clodex"
admin_wrapper="$test_root/clodex"
sed \
	-e "s|@CLODEX_BIN@|$clodex_cli|g" \
	-e "s|@CLAUDE_BIN@|$claude_bin|g" \
	-e "s|@CLODEX_CREDENTIAL_HELPER@|$credential_helper|g" \
	"$admin_template" >"$admin_wrapper"
chmod 700 "$admin_wrapper"

admin_log="$test_root/admin.log"
: >"$admin_log"
if HOME="$test_home" ADMIN_LOG="$admin_log" "$admin_wrapper" patch \
	>"$test_root/patched.out" 2>"$test_root/patched.err"; then
	fail "the administration wrapper patched an enhanced client"
else
	patched_exit=$?
fi
[ "$patched_exit" -eq 2 ] ||
	fail "the enhanced-client patch refusal did not exit 2"
grep -F 'already owns the client binary' "$test_root/patched.err" >/dev/null ||
	fail "the enhanced-client patch refusal was not specific"
[ ! -s "$admin_log" ] ||
	fail "the rejected patch command reached Clodex"

tee "$claude_bin" >/dev/null <<'SH'
#!/bin/sh
printf '%s\n' '0.0.0 (Claude Code)'
SH
chmod 700 "$claude_bin"
: >"$admin_log"
HOME="$test_home" ADMIN_LOG="$admin_log" "$admin_wrapper" patch
grep -Fx "$clodex_cli patch" "$admin_log" >/dev/null ||
	fail "the stock-client patch command did not reach Clodex"

verifier_test_dir="$test_root/verifier"
mkdir -p "$verifier_test_dir"
cp "$setup_dir/verify-live.sh" "$verifier_test_dir/verify-live.sh"
cp "$setup_dir/verify-static.sh" "$verifier_test_dir/verify-static-real.sh"
static_call_log="$verifier_test_dir/static-call.log"
tee "$verifier_test_dir/verify-static.sh" >/dev/null <<'SH'
#!/bin/sh
printf '%s' "$#" >"$VERIFY_STATIC_LOG"
for arg; do
	printf ':%s' "$arg" >>"$VERIFY_STATIC_LOG"
done
printf '\n' >>"$VERIFY_STATIC_LOG"
exit 73
SH
chmod 700 \
	"$verifier_test_dir/verify-live.sh" \
	"$verifier_test_dir/verify-static.sh" \
	"$verifier_test_dir/verify-static-real.sh"

assert_live_static_forwarding() {
	expected_call=$1
	shift
	rm -f "$static_call_log"
	if VERIFY_STATIC_LOG="$static_call_log" \
		"$verifier_test_dir/verify-live.sh" "$@" \
		>"$verifier_test_dir/live.out" 2>"$verifier_test_dir/live.err"; then
		fail "the live verifier continued past the static sentinel"
	else
		live_exit=$?
	fi
	[ "$live_exit" -eq 73 ] ||
		fail "the live verifier did not preserve the static verifier exit"
	[ "$(sed -n '1p' "$static_call_log")" = "$expected_call" ] ||
		fail "the live verifier forwarded the wrong static profile"
}

assert_live_static_forwarding 0
assert_live_static_forwarding '1:--stock' --stock
assert_live_static_forwarding '1:--stock' --smoke --stock
assert_live_static_forwarding '1:--stock' --stock --smoke

assert_live_usage() {
	rm -f "$static_call_log"
	if VERIFY_STATIC_LOG="$static_call_log" \
		"$verifier_test_dir/verify-live.sh" "$@" \
		>"$verifier_test_dir/live.out" 2>"$verifier_test_dir/live.err"; then
		fail "the live verifier accepted an invalid mode combination"
	else
		live_exit=$?
	fi
	[ "$live_exit" -eq 2 ] ||
		fail "invalid live verifier arguments did not exit 2"
	[ ! -e "$static_call_log" ] ||
		fail "invalid live verifier arguments reached static verification"
	grep -Fx \
		'usage: verify-live.sh [--smoke] [--stock]' \
		"$verifier_test_dir/live.err" >/dev/null ||
		fail "the live verifier did not print its profile usage"
}

assert_live_usage --unknown
assert_live_usage --development
assert_live_usage --stock --stock

assert_static_usage() {
	if "$verifier_test_dir/verify-static-real.sh" "$@" \
		>"$verifier_test_dir/static.out" \
		2>"$verifier_test_dir/static.err"; then
		fail "the static verifier accepted invalid arguments"
	else
		static_exit=$?
	fi
	[ "$static_exit" -eq 2 ] ||
		fail "invalid static verifier arguments did not exit 2"
	grep -Fx 'usage: verify-static.sh [--stock]' \
		"$verifier_test_dir/static.err" >/dev/null ||
		fail "the static verifier did not print its profile usage"
}

assert_static_usage --unknown
assert_static_usage --development
assert_static_usage --stock --smoke
assert_static_usage --stock --stock
assert_static_usage extra-positional

printf '%s\n' 'client-compatibility tests passed'
