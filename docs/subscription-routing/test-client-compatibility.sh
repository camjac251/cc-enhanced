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
if [ "${1:-}" = 'models' ]; then
	case " $* " in
	*' --help '*)
		if [ "${CLODEX_MODELS_METADATA_SUPPORT:-1}" -eq 1 ]; then
			printf '%s\n' 'Usage: clodex models [--json] [--context model=stop]'
		else
			printf '%s\n' 'Usage: clodex models --list'
		fi
		exit 0
		;;
	*' --json '*)
		if [ "${CLODEX_MODELS_METADATA_SUPPORT:-1}" -ne 1 ]; then
			printf '%s\n' 'Unknown models option: --json' >&2
			exit 2
		fi
		if [ "${CLODEX_MODELS_METADATA_MODE:-valid}" = 'invalid' ]; then
			printf '%s\n' '[{"id":"clodex:openai-oauth:gpt-5.6-sol","displayName":{}}]'
		elif [ "${CLODEX_MODELS_METADATA_MODE:-valid}" = 'multiple' ]; then
			printf '%s\n' '[{"id":"clodex:openai-oauth:gpt-5.6-sol","displayName":"GPT-5.6 Sol","context":{"stop":"standard","effective":258400},"maxOutputTokens":128000,"effort":{"levels":["low","medium","high"],"default":"medium"}},{"id":"clodex:example:extra-model","displayName":"Extra Model","context":{"stop":"standard","effective":200000},"maxOutputTokens":64000,"effort":{"levels":["low","medium","high"],"default":"medium"}}]'
		elif [ "${CLODEX_MODELS_METADATA_MODE:-valid}" = 'incomplete-max' ]; then
			printf '%s\n' '[{"id":"clodex:openai-oauth:gpt-5.6-sol","displayName":"GPT-5.6 Sol","context":{"stop":"max"},"maxOutputTokens":128000,"effort":{"levels":["low","medium","high"],"default":"medium"}}]'
		elif case " $* " in *' clodex:openai-oauth:gpt-5.6-sol=max '*) true ;; *) false ;; esac; then
			printf '%s\n' '[{"id":"clodex:openai-oauth:gpt-5.6-luna","displayName":"GPT-5.6 Luna","context":{"stop":"standard","raw":272000,"effective":258400,"effectivePercent":95},"maxOutputTokens":128000,"effort":{"levels":["none","low","medium","high","xhigh","max","high"],"default":"medium"}},{"id":"clodex:openai-oauth:gpt-5.6-sol","displayName":"GPT-5.6 Sol","context":{"stop":"max","raw":1000000,"effective":950000,"effectivePercent":95,"max":1000000},"maxOutputTokens":128000,"pricingBoundary":272000,"effort":{"levels":["none","low","medium","high","xhigh","max","high"],"default":"medium"}},{"id":"clodex:openai-oauth:gpt-5.6-terra","displayName":"GPT-5.6 Terra","context":{"stop":"standard","raw":272000,"effective":258400,"effectivePercent":95},"maxOutputTokens":128000,"effort":{"levels":["none","low","medium","high","xhigh","max","high"],"default":"medium"}}]'
		elif case " $* " in *' clodex:openai-oauth:gpt-5.6-terra=max '*) true ;; *) false ;; esac; then
			printf '%s\n' '[{"id":"clodex:openai-oauth:gpt-5.6-luna","displayName":"GPT-5.6 Luna","context":{"stop":"standard","raw":272000,"effective":258400,"effectivePercent":95},"maxOutputTokens":128000,"effort":{"levels":["none","low","medium","high","xhigh","max","high"],"default":"medium"}},{"id":"clodex:openai-oauth:gpt-5.6-sol","displayName":"GPT-5.6 Sol","context":{"stop":"standard","raw":272000,"effective":258400,"effectivePercent":95},"maxOutputTokens":128000,"effort":{"levels":["none","low","medium","high","xhigh","max","high"],"default":"medium"}},{"id":"clodex:openai-oauth:gpt-5.6-terra","displayName":"GPT-5.6 Terra","context":{"stop":"max","raw":1000000,"effective":950000,"effectivePercent":95,"max":1000000},"maxOutputTokens":128000,"pricingBoundary":272000,"effort":{"levels":["none","low","medium","high","xhigh","max","high"],"default":"medium"}}]'
		elif case " $* " in *' clodex:openai-oauth:gpt-5.6-luna=max '*) true ;; *) false ;; esac; then
			printf '%s\n' '[{"id":"clodex:openai-oauth:gpt-5.6-luna","displayName":"GPT-5.6 Luna","context":{"stop":"max","raw":1000000,"effective":950000,"effectivePercent":95,"max":1000000},"maxOutputTokens":128000,"pricingBoundary":272000,"effort":{"levels":["none","low","medium","high","xhigh","max","high"],"default":"medium"}},{"id":"clodex:openai-oauth:gpt-5.6-sol","displayName":"GPT-5.6 Sol","context":{"stop":"standard","raw":272000,"effective":258400,"effectivePercent":95},"maxOutputTokens":128000,"effort":{"levels":["none","low","medium","high","xhigh","max","high"],"default":"medium"}},{"id":"clodex:openai-oauth:gpt-5.6-terra","displayName":"GPT-5.6 Terra","context":{"stop":"standard","raw":272000,"effective":258400,"effectivePercent":95},"maxOutputTokens":128000,"effort":{"levels":["none","low","medium","high","xhigh","max","high"],"default":"medium"}}]'
		else
			printf '%s\n' '[{"id":"clodex:openai-oauth:gpt-5.6-luna","displayName":"GPT-5.6 Luna","context":{"stop":"standard","raw":272000,"effective":258400,"effectivePercent":95},"maxOutputTokens":128000,"effort":{"levels":["none","low","medium","high","xhigh","max","high"],"default":"medium"}},{"id":"clodex:openai-oauth:gpt-5.6-sol","displayName":"GPT-5.6 Sol","context":{"stop":"standard","raw":272000,"effective":258400,"effectivePercent":95},"maxOutputTokens":128000,"effort":{"levels":["none","low","medium","high","xhigh","max","high"],"default":"medium"}},{"id":"clodex:openai-oauth:gpt-5.6-terra","displayName":"GPT-5.6 Terra","context":{"stop":"standard","raw":272000,"effective":258400,"effectivePercent":95},"maxOutputTokens":128000,"effort":{"levels":["none","low","medium","high","xhigh","max","high"],"default":"medium"}}]'
		fi
		exit 0
		;;
	esac
fi
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
printf 'model-aliases=%s\n' "${CLAUDE_CODE_MODEL_ALIASES-unset}"
printf 'network-snapshot=%s\n' "${CLODEX_ORIGINAL_NETWORK_ENV-unset}"
printf 'catalog=%s\n' "${CLAUDE_CODE_CONFIGURED_MODEL_CATALOG-unset}"
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
node_bin=$(mise --cd "$test_root" which node)
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
	CLAUDE_CODE_AUTO_MODE_MODEL=inherited \
	"$launcher" sol >"$test_root/launcher-sol.out"
grep -Fx 'auto-model=sol' "$test_root/launcher-sol.out" >/dev/null ||
	fail "the Sol shortcut did not select Sol for later auto-mode classification"
grep -Fx 'model-aliases={"sol":"clodex:openai-oauth:gpt-5.6-sol","terra":"clodex:openai-oauth:gpt-5.6-terra","luna":"clodex:openai-oauth:gpt-5.6-luna"}' \
	"$test_root/launcher-sol.out" >/dev/null ||
	fail "the routed launcher did not expose every GPT-5.6 alias"
grep -Fx 'arg=--model' "$test_root/launcher-sol.out" >/dev/null ||
	fail "the Sol shortcut dropped the model flag"
grep -Fx 'arg=sol' "$test_root/launcher-sol.out" >/dev/null ||
	fail "the Sol shortcut dropped the model value"
grep -Fx 'network-snapshot={"HTTPS_PROXY":"http://corp-proxy.example:8080","NO_PROXY":".internal.example"}' \
	"$test_root/launcher-sol.out" >/dev/null ||
	fail "the routed launcher did not preserve the original network environment"
grep -Fx 'catalog=[{"id":"clodex:openai-oauth:gpt-5.6-sol","displayName":"GPT-5.6 Sol","description":"ChatGPT Pro subscription route","maxInputTokens":258400,"maxOutputTokens":128000,"effortLevels":["low","medium","high","xhigh","max"],"defaultEffort":"medium"},{"id":"clodex:openai-oauth:gpt-5.6-terra","displayName":"GPT-5.6 Terra","description":"ChatGPT Pro subscription route","maxInputTokens":258400,"maxOutputTokens":128000,"effortLevels":["low","medium","high","xhigh","max"],"defaultEffort":"medium"},{"id":"clodex:openai-oauth:gpt-5.6-luna","displayName":"GPT-5.6 Luna","description":"ChatGPT Pro subscription route","maxInputTokens":258400,"maxOutputTokens":128000,"effortLevels":["low","medium","high","xhigh","max"],"defaultEffort":"medium"}]' \
	"$test_root/launcher-sol.out" >/dev/null ||
	fail "the routed launcher did not map the ordered GPT-5.6 catalog"

for routed_model in terra luna; do
	HOME="$test_home" PATH="$test_bin:$PATH" \
		CLAUDEX_SYSTEM_PROMPT_FILE="$system_prompt" \
		"$launcher" "$routed_model" >"$test_root/launcher-$routed_model.out"
	grep -Fx "auto-model=$routed_model" \
		"$test_root/launcher-$routed_model.out" >/dev/null ||
		fail "the $routed_model shortcut did not select its auto-mode model"
	grep -Fx 'arg=--model' "$test_root/launcher-$routed_model.out" >/dev/null ||
		fail "the $routed_model shortcut dropped the model flag"
	grep -Fx "arg=$routed_model" "$test_root/launcher-$routed_model.out" >/dev/null ||
		fail "the $routed_model shortcut dropped the model value"
done

for routed_model in sol terra luna; do
	case "$routed_model" in
	sol)
		expected_catalog='[{"id":"clodex:openai-oauth:gpt-5.6-sol","displayName":"GPT-5.6 Sol","description":"ChatGPT Pro subscription route","maxInputTokens":950000,"maxOutputTokens":128000,"autoCompactWindow":855000,"effortLevels":["low","medium","high","xhigh","max"],"defaultEffort":"medium"},{"id":"clodex:openai-oauth:gpt-5.6-terra","displayName":"GPT-5.6 Terra","description":"ChatGPT Pro subscription route","maxInputTokens":258400,"maxOutputTokens":128000,"effortLevels":["low","medium","high","xhigh","max"],"defaultEffort":"medium"},{"id":"clodex:openai-oauth:gpt-5.6-luna","displayName":"GPT-5.6 Luna","description":"ChatGPT Pro subscription route","maxInputTokens":258400,"maxOutputTokens":128000,"effortLevels":["low","medium","high","xhigh","max"],"defaultEffort":"medium"}]'
		;;
	terra)
		expected_catalog='[{"id":"clodex:openai-oauth:gpt-5.6-sol","displayName":"GPT-5.6 Sol","description":"ChatGPT Pro subscription route","maxInputTokens":258400,"maxOutputTokens":128000,"effortLevels":["low","medium","high","xhigh","max"],"defaultEffort":"medium"},{"id":"clodex:openai-oauth:gpt-5.6-terra","displayName":"GPT-5.6 Terra","description":"ChatGPT Pro subscription route","maxInputTokens":950000,"maxOutputTokens":128000,"autoCompactWindow":855000,"effortLevels":["low","medium","high","xhigh","max"],"defaultEffort":"medium"},{"id":"clodex:openai-oauth:gpt-5.6-luna","displayName":"GPT-5.6 Luna","description":"ChatGPT Pro subscription route","maxInputTokens":258400,"maxOutputTokens":128000,"effortLevels":["low","medium","high","xhigh","max"],"defaultEffort":"medium"}]'
		;;
	luna)
		expected_catalog='[{"id":"clodex:openai-oauth:gpt-5.6-sol","displayName":"GPT-5.6 Sol","description":"ChatGPT Pro subscription route","maxInputTokens":258400,"maxOutputTokens":128000,"effortLevels":["low","medium","high","xhigh","max"],"defaultEffort":"medium"},{"id":"clodex:openai-oauth:gpt-5.6-terra","displayName":"GPT-5.6 Terra","description":"ChatGPT Pro subscription route","maxInputTokens":258400,"maxOutputTokens":128000,"effortLevels":["low","medium","high","xhigh","max"],"defaultEffort":"medium"},{"id":"clodex:openai-oauth:gpt-5.6-luna","displayName":"GPT-5.6 Luna","description":"ChatGPT Pro subscription route","maxInputTokens":950000,"maxOutputTokens":128000,"autoCompactWindow":855000,"effortLevels":["low","medium","high","xhigh","max"],"defaultEffort":"medium"}]'
		;;
	esac
	HOME="$test_home" PATH="$test_bin:$PATH" \
		CLAUDEX_SYSTEM_PROMPT_FILE="$system_prompt" \
		"$launcher" "$routed_model" --max-context \
		>"$test_root/launcher-$routed_model-max-context.out"
	grep -Fx "catalog=$expected_catalog" \
		"$test_root/launcher-$routed_model-max-context.out" >/dev/null ||
		fail "the $routed_model max-context shortcut did not isolate its maximum and compaction target"
done

HOME="$test_home" PATH="$test_bin:$PATH" \
	CLAUDEX_SYSTEM_PROMPT_FILE="$system_prompt" \
	CLODEX_MODELS_METADATA_MODE=multiple \
	"$launcher" sol >"$test_root/launcher-multiple.out"
grep -Fx 'catalog=[{"id":"clodex:openai-oauth:gpt-5.6-sol","displayName":"GPT-5.6 Sol","description":"ChatGPT Pro subscription route","maxInputTokens":258400,"maxOutputTokens":128000,"effortLevels":["low","medium","high"],"defaultEffort":"medium"}]' \
	"$test_root/launcher-multiple.out" >/dev/null ||
	fail "the routed catalog exposed unrelated saved favorites"

for invalid_max_context_shortcut in fable opus; do
	if HOME="$test_home" PATH="$test_bin:$PATH" \
		CLAUDEX_SYSTEM_PROMPT_FILE="$system_prompt" \
		"$launcher" "$invalid_max_context_shortcut" --max-context \
		>"$test_root/launcher-$invalid_max_context_shortcut-max-context.out" \
		2>"$test_root/launcher-$invalid_max_context_shortcut-max-context.err"; then
		fail "the max-context option accepted $invalid_max_context_shortcut"
	fi
	grep -Fx 'claudex: --max-context is only valid after a sol, terra, or luna shortcut' \
		"$test_root/launcher-$invalid_max_context_shortcut-max-context.err" >/dev/null ||
		fail "the rejected $invalid_max_context_shortcut max-context launch lacked its usage error"
done
if HOME="$test_home" PATH="$test_bin:$PATH" \
	CLAUDEX_SYSTEM_PROMPT_FILE="$system_prompt" \
	"$launcher" --max-context >"$test_root/launcher-bare-max-context.out" \
	2>"$test_root/launcher-bare-max-context.err"; then
	fail "the max-context option accepted a model-less launch"
fi
grep -Fx 'claudex: --max-context is only valid after a sol, terra, or luna shortcut' \
	"$test_root/launcher-bare-max-context.err" >/dev/null ||
	fail "the rejected model-less max-context launch lacked its usage error"

if HOME="$test_home" PATH="$test_bin:$PATH" \
	CLAUDEX_SYSTEM_PROMPT_FILE="$system_prompt" \
	"$launcher" sol --1m >"$test_root/launcher-retired-1m.out" \
	2>"$test_root/launcher-retired-1m.err"; then
	fail "the retired 1m spelling reached Claude Code"
fi
grep -Fx 'claudex: use --max-context after a sol, terra, or luna shortcut' \
	"$test_root/launcher-retired-1m.err" >/dev/null ||
	fail "the retired 1m spelling did not name the supported option"

if HOME="$test_home" PATH="$test_bin:$PATH" \
	CLAUDEX_SYSTEM_PROMPT_FILE="$system_prompt" \
	CLODEX_MODELS_METADATA_SUPPORT=0 \
	"$launcher" sol >"$test_root/launcher-unsupported-metadata.out" \
	2>"$test_root/launcher-unsupported-metadata.err"; then
	fail "a Clodex build without resolved metadata reached Claude Code"
else
	unsupported_metadata_exit=$?
fi
[ "$unsupported_metadata_exit" -eq 1 ] ||
	fail "the unsupported metadata contract did not exit 1"
grep -Fx \
	'claudex: Clodex models --json and --context support is required' \
	"$test_root/launcher-unsupported-metadata.err" >/dev/null ||
	fail "the unsupported metadata contract did not explain its requirement"
if grep -F 'Unknown models option' \
	"$test_root/launcher-unsupported-metadata.err" >/dev/null; then
	fail "the capability probe invoked an unsupported metadata option"
fi

if HOME="$test_home" PATH="$test_bin:$PATH" \
	CLAUDEX_SYSTEM_PROMPT_FILE="$system_prompt" \
	CLODEX_MODELS_METADATA_SUPPORT=0 \
	"$launcher" sol --max-context >"$test_root/launcher-unsupported-max-context.out" \
	2>"$test_root/launcher-unsupported-max-context.err"; then
	fail "the max-context option silently fell back on an unsupported Clodex build"
else
	unsupported_max_context_exit=$?
fi
[ "$unsupported_max_context_exit" -eq 1 ] ||
	fail "the unsupported max-context option did not exit 1"
grep -Fx \
	'claudex: --max-context requires a Clodex build with models --json and --context support' \
	"$test_root/launcher-unsupported-max-context.err" >/dev/null ||
	fail "the unsupported max-context option did not explain its required contract"

if HOME="$test_home" PATH="$test_bin:$PATH" \
	CLAUDEX_SYSTEM_PROMPT_FILE="$system_prompt" \
	CLODEX_MODELS_METADATA_MODE=incomplete-max \
	"$launcher" sol --max-context >"$test_root/launcher-incomplete-max-context.out" \
	2>"$test_root/launcher-incomplete-max-context.err"; then
	fail "the max-context option accepted metadata without an effective context bound"
else
	incomplete_max_context_exit=$?
fi
[ "$incomplete_max_context_exit" -eq 1 ] ||
	fail "the incomplete max-context response did not exit 1"
grep -Fx 'claudex: --max-context could not resolve bounded Clodex model metadata' \
	"$test_root/launcher-incomplete-max-context.err" >/dev/null ||
	fail "the incomplete max-context response did not explain its missing bound"

if HOME="$test_home" PATH="$test_bin:$PATH" \
	CLAUDEX_SYSTEM_PROMPT_FILE="$system_prompt" \
	CLODEX_MODELS_METADATA_MODE=invalid \
	"$launcher" sol >"$test_root/launcher-invalid-metadata.out" \
	2>"$test_root/launcher-invalid-metadata.err"; then
	fail "invalid model metadata reached Claude Code"
else
	invalid_metadata_exit=$?
fi
[ "$invalid_metadata_exit" -eq 1 ] ||
	fail "invalid model metadata did not exit 1"
grep -Fx 'claudex: could not resolve routed GPT-5.6 model metadata' \
	"$test_root/launcher-invalid-metadata.err" >/dev/null ||
	fail "invalid model metadata did not report the routing boundary"

original_snapshot='{"HTTPS_PROXY":"http://corp-proxy.example:8080"}'
HOME="$test_home" PATH="$test_bin:$PATH" \
	CLAUDEX_SYSTEM_PROMPT_FILE="$system_prompt" \
	CLODEX_ORIGINAL_NETWORK_ENV="$original_snapshot" \
	HTTPS_PROXY='http://127.0.0.1:3457' \
	CLAUDE_CODE_AUTO_MODE_MODEL=inherited \
	"$launcher" opus >"$test_root/launcher-opus.out"
grep -Fx 'auto-model=unset' "$test_root/launcher-opus.out" >/dev/null ||
	fail "a native shortcut retained an unreviewed auto-mode model override"
grep -Fx "network-snapshot=$original_snapshot" \
	"$test_root/launcher-opus.out" >/dev/null ||
	fail "a nested routed launch replaced the original network environment"

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
HOME="$test_home" ADMIN_LOG="$admin_log" \
	"$admin_wrapper" upstream-proxy status
grep -Fx "$clodex_cli upstream-proxy status" "$admin_log" >/dev/null ||
	fail "the upstream proxy command did not reach Clodex"
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
assert_live_static_forwarding 0 --model=luna
assert_live_static_forwarding '1:--stock' --stock
assert_live_static_forwarding '1:--stock' --smoke --stock
assert_live_static_forwarding '1:--stock' --stock --smoke
assert_live_static_forwarding '1:--stock' --model=terra --stock --smoke

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
		'usage: verify-live.sh [--smoke] [--stock] [--model=sol|terra|luna]' \
		"$verifier_test_dir/live.err" >/dev/null ||
		fail "the live verifier did not print its profile usage"
}

assert_live_usage --unknown
assert_live_usage --development
assert_live_usage --model=other
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
