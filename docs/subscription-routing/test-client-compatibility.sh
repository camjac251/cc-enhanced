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
runtime_root="$test_home/.local/share/claudex-clodex/runtime/current"
clodex_wrapper="$runtime_root/dist/claude-wrapper.js"
runtime_cli="$runtime_root/dist/cli.js"
system_prompt="$test_home/.config/claudex-clodex/system-prompt.md"
credential_helper="$test_root/credential-helper"
claude_bin="$test_root/claude"
node_bin="$test_root/node"
mkdir -p "$(dirname "$clodex_wrapper")" "$(dirname "$system_prompt")"
printf '%s\n%s\n' 'Route translated model requests through Clodex.' \
	'Keep native model requests on the normal subscription.' >"$system_prompt"

tee "$clodex_wrapper" >/dev/null <<'SH'
#!/bin/sh
for arg; do
	printf '%s\n' "$arg"
done
SH
cp "$clodex_wrapper" "$runtime_cli"
tee "$credential_helper" >/dev/null <<'SH'
#!/bin/sh
exit 0
SH
tee "$node_bin" >/dev/null <<'SH'
#!/bin/sh
printf '%s\n' "$*" >>"$ADMIN_LOG"
SH
chmod 700 "$clodex_wrapper" "$runtime_cli" "$credential_helper" "$node_bin"

process_wrapper_template="$setup_dir/templates/claudex-process-wrapper"
[ -r "$process_wrapper_template" ] ||
	fail "the portable process-wrapper template is missing"
process_wrapper="$test_root/claudex-process-wrapper"
cp "$process_wrapper_template" "$process_wrapper"
chmod 700 "$process_wrapper"

tee "$claude_bin" >/dev/null <<'SH'
#!/bin/sh
printf '%s\n' '2.1.216 (Claude Code; patched: configured-model-catalog)'
SH
chmod 700 "$claude_bin"

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
	-e "s|@NODE_BIN@|$node_bin|g" \
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
	fail "the rejected patch command reached the routing runtime"

tee "$claude_bin" >/dev/null <<'SH'
#!/bin/sh
printf '%s\n' '2.1.216 (Claude Code)'
SH
chmod 700 "$claude_bin"
: >"$admin_log"
HOME="$test_home" ADMIN_LOG="$admin_log" "$admin_wrapper" patch
grep -Fx "$runtime_cli patch" "$admin_log" >/dev/null ||
	fail "the stock-client patch command did not reach Clodex"

printf '%s\n' 'client-compatibility tests passed'
