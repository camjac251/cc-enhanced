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
printf 'subagent-marker=%s\n' "${CC_ENHANCED_SUBAGENT_PROMPT_FILE-unset}"
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
	"$process_wrapper_template" >"$process_wrapper"
chmod 700 "$process_wrapper"

tee "$claude_bin" >/dev/null <<'SH'
#!/bin/sh
printf '%s\n' '0.0.0 (Claude Code)'
SH
chmod 700 "$claude_bin"

HOME="$test_home" CLAUDEX_SYSTEM_PROMPT_FILE="$system_prompt" \
	"$process_wrapper" "$claude_bin" --model sol >"$test_root/injected.args"
[ "$(grep -Fxc -- '--append-system-prompt-file' "$test_root/injected.args")" -eq 1 ] ||
	fail "the parent prompt file flag was not injected exactly once"
[ "$(grep -Fxc -- "$system_prompt" "$test_root/injected.args")" -eq 1 ] ||
	fail "the routed prompt path was not forwarded"
grep -Fx "subagent-marker=$system_prompt" "$test_root/injected.args" >/dev/null ||
	fail "the interactive prompt was not handed to the plugin"
if grep -Fx -- '--append-subagent-system-prompt-file' "$test_root/injected.args" >/dev/null; then
	fail "interactive launch used the headless-only subagent flag"
fi
grep -Fx -- '--model' "$test_root/injected.args" >/dev/null ||
	fail "the original Claude arguments were not retained"
grep -Fx 'sol' "$test_root/injected.args" >/dev/null ||
	fail "the original model argument was not retained"

HOME="$test_home" CLAUDEX_SYSTEM_PROMPT_FILE="$system_prompt" \
	CC_ENHANCED_SUBAGENT_PROMPT_FILE=/inherited.md \
	"$process_wrapper" "$claude_bin" -p hello >"$test_root/print.args"
grep -Fx 'subagent-marker=unset' "$test_root/print.args" >/dev/null ||
	fail "print mode retained an inherited interactive marker"
[ "$(grep -Fxc -- '--append-subagent-system-prompt-file' "$test_root/print.args")" -eq 1 ] ||
	fail "print mode did not append the subagent policy by file"

launcher_process_wrapper="$test_root/launcher-process-wrapper"
prompt_composer="$test_root/prompt-composer"
test_bin="$test_root/bin"
mkdir -p "$test_bin" "$test_home/.local/share/claudex-clodex"
tee "$launcher_process_wrapper" >/dev/null <<'SH'
#!/bin/sh
printf 'network-snapshot=%s\n' "${CLODEX_ORIGINAL_NETWORK_ENV-unset}"
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
node_bin=${NODE_BIN:-}
if [ -z "$node_bin" ]; then
	node_bin=$(command -v node) || fail "node is unavailable"
fi
[ -x "$node_bin" ] || fail "node is not executable"
sed \
	-e "s|@NODE_BIN@|$node_bin|g" \
	-e "s|@CLAUDE_BIN@|$claude_bin|g" \
	-e "s|@CLODEX_CLAUDE_BIN@|$clodex_wrapper|g" \
	-e "s|@CLAUDEX_PROCESS_WRAPPER@|$launcher_process_wrapper|g" \
	-e "s|@CLAUDEX_PROMPT_COMPOSER@|$prompt_composer|g" \
	-e "s|@CLODEX_BIN@|$clodex_cli|g" \
	-e "s|@CLODEX_CREDENTIAL_HELPER@|$credential_helper|g" \
	"$launcher_template" >"$launcher"
chmod 700 "$launcher"

env -u CLODEX_ORIGINAL_NETWORK_ENV -u HTTP_PROXY -u https_proxy -u http_proxy \
	-u no_proxy -u NODE_EXTRA_CA_CERTS \
	HOME="$test_home" PATH="$test_bin:$PATH" \
	HTTPS_PROXY='http://corp-proxy.example:8080' NO_PROXY='.internal.example' \
	CLAUDEX_SYSTEM_PROMPT_FILE="$system_prompt" \
	"$launcher" sol >"$test_root/launcher-sol.out"
grep -Fx 'arg=--model' "$test_root/launcher-sol.out" >/dev/null ||
	fail "the Sol shortcut dropped the model flag"
grep -Fx 'arg=sol' "$test_root/launcher-sol.out" >/dev/null ||
	fail "the Sol shortcut dropped the model value"
grep -Fx 'network-snapshot={"HTTPS_PROXY":"http://corp-proxy.example:8080","NO_PROXY":".internal.example"}' \
	"$test_root/launcher-sol.out" >/dev/null ||
	fail "the routed launcher did not preserve the original network environment"

for routed_model in terra luna; do
	HOME="$test_home" PATH="$test_bin:$PATH" \
		CLAUDEX_SYSTEM_PROMPT_FILE="$system_prompt" \
		"$launcher" "$routed_model" >"$test_root/launcher-$routed_model.out"
	grep -Fx 'arg=--model' "$test_root/launcher-$routed_model.out" >/dev/null ||
		fail "the $routed_model shortcut dropped the model flag"
	grep -Fx "arg=$routed_model" "$test_root/launcher-$routed_model.out" >/dev/null ||
		fail "the $routed_model shortcut dropped the model value"
done

for context_option in --max-context --1m; do
	for model in sol terra luna fable opus; do
		if HOME="$test_home" PATH="$test_bin:$PATH" \
			CLAUDEX_SYSTEM_PROMPT_FILE="$system_prompt" \
			"$launcher" "$model" "$context_option" \
			>"$test_root/unsupported-context.out" \
			2>"$test_root/unsupported-context.err"; then
			fail "the removed context override reached Claude Code"
		else
			context_exit=$?
		fi
		[ "$context_exit" -eq 2 ] ||
			fail "the removed context override did not exit 2"
		grep -Fx \
			'claudex: context overrides require native client patches and are no longer supported; configure the routed model in Clodex' \
			"$test_root/unsupported-context.err" >/dev/null ||
			fail "the removed context override did not explain stock routing"
	done
done

original_snapshot='{"HTTPS_PROXY":"http://corp-proxy.example:8080"}'
HOME="$test_home" PATH="$test_bin:$PATH" \
	CLAUDEX_SYSTEM_PROMPT_FILE="$system_prompt" \
	CLODEX_ORIGINAL_NETWORK_ENV="$original_snapshot" \
	HTTPS_PROXY='http://127.0.0.1:3457' \
	"$launcher" opus >"$test_root/launcher-opus.out"
grep -Fx "network-snapshot=$original_snapshot" \
	"$test_root/launcher-opus.out" >/dev/null ||
	fail "a nested routed launch replaced the original network environment"

HOME="$test_home" CLAUDEX_SYSTEM_PROMPT_FILE="$system_prompt" \
	"$process_wrapper" "$claude_bin" -- \
	--append-system-prompt --append-subagent-system-prompt \
	>"$test_root/separator.args"
[ "$(grep -Fxc -- '--append-system-prompt-file' "$test_root/separator.args")" -eq 1 ] ||
	fail "a positional prompt flag suppressed the managed parent prompt"
[ "$(grep -Fxc -- '--append-subagent-system-prompt' "$test_root/separator.args")" -eq 1 ] ||
	fail "a positional prompt was changed"
grep -Fx "subagent-marker=$system_prompt" "$test_root/separator.args" >/dev/null ||
	fail "a positional prompt flag suppressed the interactive policy"

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
grep -Fx 'subagent-marker=unset' "$test_root/existing.args" >/dev/null ||
	fail "a caller's subagent append gained an interactive policy marker"

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
HOME="$test_home" ADMIN_LOG="$admin_log" \
	"$admin_wrapper" upstream-proxy status
grep -Fx "$clodex_cli upstream-proxy status" "$admin_log" >/dev/null ||
	fail "the upstream proxy command did not reach Clodex"
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
		fail "the live verifier forwarded unexpected static arguments"
}

assert_live_static_forwarding 0
assert_live_static_forwarding 0 --model=luna
assert_live_static_forwarding 0 --smoke
assert_live_static_forwarding 0 --model=terra --smoke

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
		'usage: verify-live.sh [--smoke] [--model=sol|terra|luna]' \
		"$verifier_test_dir/live.err" >/dev/null ||
		fail "the live verifier did not print its usage"
}

assert_live_usage --unknown
assert_live_usage --development
assert_live_usage --model=other
assert_live_usage --stock

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
	grep -Fx 'usage: verify-static.sh' \
		"$verifier_test_dir/static.err" >/dev/null ||
		fail "the static verifier did not print its usage"
}

assert_static_usage --unknown
assert_static_usage --development
assert_static_usage --stock
assert_static_usage extra-positional

printf '%s\n' 'client-compatibility tests passed'
