#!/bin/sh

set -eu

fail() {
	printf 'prompt-composition test failed: %s\n' "$1" >&2
	exit 1
}

setup_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
test_root=$(mktemp -d)
cleanup() {
	chmod 700 "$test_root/output" 2>/dev/null || :
	rm -rf "$test_root"
}
trap cleanup EXIT HUP INT TERM

managed_prompt="$test_root/managed.md"
routing_overlay="$test_root/routing.md"
output_dir="$test_root/output"
output_prompt="$output_dir/system-prompt.md"
expected_prompt="$test_root/expected.md"
composer="$setup_dir/templates/claudex-compose-system-prompt"

mkdir -p "$output_dir"
printf '%s\n' '# Managed policy' 'Keep the safety boundary.' >"$managed_prompt"
printf '%s\n' '# Routed policy' 'Use the selected alias.' >"$routing_overlay"

CLAUDEX_MANAGED_SYSTEM_PROMPT_FILE="$managed_prompt" \
	CLAUDEX_ROUTING_POLICY_FILE="$routing_overlay" \
	CLAUDEX_COMPOSED_SYSTEM_PROMPT_FILE="$output_prompt" \
	"$composer"

dd if="$managed_prompt" of="$expected_prompt" status=none
printf '\n' >>"$expected_prompt"
dd if="$routing_overlay" of="$expected_prompt" oflag=append conv=notrunc status=none
cmp -s "$expected_prompt" "$output_prompt" ||
	fail "the composed prompt does not exactly match base plus overlay"
[ "$(stat -c '%a' "$output_prompt")" = 600 ] ||
	fail "the composed prompt mode is not 600"

before=$(stat -c '%Y:%i:%s' "$output_prompt")
chmod 500 "$output_dir"
CLAUDEX_MANAGED_SYSTEM_PROMPT_FILE="$managed_prompt" \
	CLAUDEX_ROUTING_POLICY_FILE="$routing_overlay" \
	CLAUDEX_COMPOSED_SYSTEM_PROMPT_FILE="$output_prompt" \
	"$composer"
chmod 700 "$output_dir"
after=$(stat -c '%Y:%i:%s' "$output_prompt")
[ "$before" = "$after" ] ||
	fail "an unchanged prompt was rewritten in a read-only directory"

printf '%s\n' 'Updated managed policy.' >>"$managed_prompt"
CLAUDEX_MANAGED_SYSTEM_PROMPT_FILE="$managed_prompt" \
	CLAUDEX_ROUTING_POLICY_FILE="$routing_overlay" \
	CLAUDEX_COMPOSED_SYSTEM_PROMPT_FILE="$output_prompt" \
	"$composer"
rg -Fx 'Updated managed policy.' "$output_prompt" >/dev/null ||
	fail "a managed prompt update did not reach the composed output"

if CLAUDEX_MANAGED_SYSTEM_PROMPT_FILE="$test_root/missing.md" \
	CLAUDEX_ROUTING_POLICY_FILE="$routing_overlay" \
	CLAUDEX_COMPOSED_SYSTEM_PROMPT_FILE="$output_prompt" \
	"$composer" >"$test_root/missing.out" 2>"$test_root/missing.err"; then
	fail "the composer accepted a missing managed prompt"
fi
rg -F 'prompt input is not readable' "$test_root/missing.err" >/dev/null ||
	fail "the missing-input error was not specific"

printf '%s\n' 'prompt-composition tests passed'
