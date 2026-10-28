#!/usr/bin/env bash
# cc-enhanced setup for macOS and Linux.
#
# Installs the cc-enhanced plugin through Claude Code's own plugin marketplace,
# and a small `claude` wrapper that appends your system prompt to the main
# session and to subagents. Claude Code itself stays the official install and
# keeps updating itself; the wrapper only finds it on PATH and adds flags.
#
#   ./install.sh                     install from this checkout
#   ./install.sh --source owner/repo install from a GitHub marketplace instead
#   ./install.sh --uninstall         remove the plugin, wrapper and shell blocks
set -euo pipefail

readonly MARKETPLACE="cc-enhanced"
readonly PLUGIN="cc-enhanced@cc-enhanced"
readonly MARKER_BEGIN="# >>> cc-enhanced >>>"
readonly MARKER_END="# <<< cc-enhanced <<<"

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
data_dir="${XDG_DATA_HOME:-$HOME/.local/share}/cc-enhanced"
bin_dir="$data_dir/bin"
wrapper="$bin_dir/claude"
config_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
settings_file="$config_dir/settings.json"
agent_dir="$config_dir/agents"
agent_copies="$data_dir/agents"

source_spec="$script_dir"
source_explicit=0
prompt_file="/etc/claude-code/system-prompt.md"
edit_shells=1
edit_settings=1
edit_agents=1
action=install

usage() {
	cat <<EOF
Usage: ./install.sh [options]

  --source <dir|owner/repo|git-url>  Marketplace to install from (default: this checkout)
  --prompt-file <path>               System prompt to append (default: $prompt_file)
  --no-shell                         Do not edit shell startup files
  --no-settings                      Do not add recommended keys to $settings_file
  --no-agents                        Do not install the Explore/Plan user-agent defaults
  --uninstall                        Remove plugin, wrapper, shell blocks and unchanged agent defaults
EOF
}

while (($# > 0)); do
	case "$1" in
	--source) source_spec="${2:?--source needs a value}"; source_explicit=1; shift 2 ;;
	--prompt-file) prompt_file="${2:?--prompt-file needs a value}"; shift 2 ;;
	--no-shell) edit_shells=0; shift ;;
	--no-settings) edit_settings=0; shift ;;
	--no-agents) edit_agents=0; shift ;;
	--uninstall) action=uninstall; shift ;;
	-h | --help) usage; exit 0 ;;
	*) usage >&2; exit 2 ;;
	esac
done

say() { printf 'cc-enhanced: %s\n' "$*"; }
fail() { printf 'cc-enhanced: %s\n' "$*" >&2; exit 1; }

# The real claude: first one on PATH outside the wrapper's own directory.
find_claude() {
	local dir resolved own
	own=$(cd "$bin_dir" 2>/dev/null && pwd -P || printf '%s' "$bin_dir")
	local -a path_dirs
	IFS=: read -r -a path_dirs <<<"$PATH"
	for dir in "${path_dirs[@]}"; do
		[[ -n "$dir" && -x "$dir/claude" && ! -d "$dir/claude" ]] || continue
		resolved=$(cd "$dir" 2>/dev/null && pwd -P) || continue
		[[ "$resolved" == "$own" ]] && continue
		printf '%s\n' "$dir/claude"
		return 0
	done
	return 1
}

# A local source must be absolute: Claude Code reads `name/name` as GitHub.
normalize_source() {
	if [[ -d "$source_spec" ]]; then
		source_spec=$(cd "$source_spec" && pwd -P)
	fi
}

write_wrapper() {
	mkdir -p "$bin_dir"
	local temporary="$wrapper.$$"
	cat >"$temporary" <<'WRAPPER'
#!/usr/bin/env bash
# cc-enhanced wrapper, installed by cc-enhanced's install.sh.
# Runs the real claude found later on PATH, appending the system prompt to the
# main session and subagents. CC_ENHANCED_DISABLE=1 runs claude unchanged.
set -euo pipefail

own=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
real=""
IFS=: read -r -a path_dirs <<<"$PATH"
for dir in "${path_dirs[@]}"; do
	[[ -n "$dir" && -x "$dir/claude" && ! -d "$dir/claude" ]] || continue
	resolved=$(cd "$dir" 2>/dev/null && pwd -P) || continue
	[[ "$resolved" == "$own" ]] && continue
	real="$dir/claude"
	break
done
if [[ -z "$real" ]]; then
	echo "cc-enhanced: Claude Code is not installed. Install it with: curl -fsSL https://claude.ai/install.sh | bash" >&2
	exit 127
fi
# This marker belongs to this invocation, not a parent Claude Bash environment.
unset CC_ENHANCED_SUBAGENT_PROMPT_FILE
if [[ "${CC_ENHANCED_DISABLE:-}" == "1" ]]; then
	exec "$real" "$@"
fi

user_has() {
	local arg flag
	for arg in "${user_args[@]+"${user_args[@]}"}"; do
		[[ "$arg" == "--" ]] && return 1
		for flag in "$@"; do
			[[ "$arg" == "$flag" || "$arg" == "$flag="* ]] && return 0
		done
	done
	return 1
}

user_args=("$@")
injected=()
prompt_file="${CC_ENHANCED_PROMPT_FILE:-@PROMPT_FILE@}"
if [[ -n "$prompt_file" && -r "$prompt_file" ]]; then
	if ! user_has --append-system-prompt --append-system-prompt-file; then
		injected+=(--append-system-prompt-file "$prompt_file")
	fi
	if ! user_has --append-subagent-system-prompt --append-subagent-system-prompt-file; then
		# The subagent flag reaches subagents only in print mode. Interactive
		# sessions accept it and drop it, so the plugin adds the file instead.
		if user_has -p --print; then
			injected+=(--append-subagent-system-prompt-file "$prompt_file")
			export CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT="${CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT:-1}"
		else
			export CC_ENHANCED_SUBAGENT_PROMPT_FILE="$prompt_file"
		fi
	fi
fi

exec "$real" "${injected[@]+"${injected[@]}"}" "$@"
WRAPPER
	# Bake the chosen prompt path in; the escape keeps `&`, `|` and `\` literal.
	local escaped
	escaped=$(printf '%s' "$prompt_file" | sed -e 's/[&|\\]/\\&/g')
	sed -e "s|@PROMPT_FILE@|$escaped|" "$temporary" >"$temporary.out"
	rm -f "$temporary"
	chmod 755 "$temporary.out"
	mv "$temporary.out" "$wrapper"
}

# Agent identity is its frontmatter name, not its filename. Preserve definitions
# anywhere in the user's recursively scanned agents directory.
agent_name_exists() {
	local name="$1" file
	[[ -d "$agent_dir" ]] || return 1
	while IFS= read -r -d '' file; do
		if awk -v name="$name" '
			NR == 1 { if ($0 != "---") exit; next }
			$0 == "---" { exit }
			/^name:[[:space:]]*/ {
				value = $0
				sub(/^name:[[:space:]]*/, "", value)
				sub(/[[:space:]]+#.*$/, "", value)
				gsub(/^[[:space:]"\047]+|[[:space:]"\047]+$/, "", value)
				if (value == name) found = 1
			}
			END { exit !found }
		' "$file"; then return 0; fi
	done < <(find "$agent_dir" \( -type f -o -type l \) -name '*.md' -print0)
	return 1
}

install_agents() {
	local name target saved
	for name in Explore Plan; do
		target="$agent_dir/$name.md"
		saved="$agent_copies/$name.md"
		if [[ -f "$saved" && -f "$target" && ! -L "$target" ]] && cmp -s "$saved" "$target"; then
			: # An unchanged default belongs to this installer and may be refreshed.
		elif [[ -e "$target" || -L "$target" ]] || agent_name_exists "$name"; then
			say "preserved existing $name user agent"
			continue
		fi
		mkdir -p "$agent_dir" "$agent_copies"
		cp "$script_dir/templates/agents/$name.md" "$target"
		cp "$target" "$saved"
		say "installed $name user agent at $target"
	done
}

remove_agents() {
	local name target saved
	for name in Explore Plan; do
		target="$agent_dir/$name.md"
		saved="$agent_copies/$name.md"
		[[ -f "$saved" ]] || continue
		if [[ -f "$target" && ! -L "$target" ]] && cmp -s "$saved" "$target"; then
			rm -f "$target"
		else
			say "preserved modified $name user agent"
		fi
		rm -f "$saved"
	done
	rmdir "$agent_copies" 2>/dev/null || true
}

shell_block() {
	cat <<EOF
$MARKER_BEGIN
# Runs claude through the cc-enhanced wrapper. Undo: $script_dir/install.sh --uninstall
case ":\$PATH:" in
*":$bin_dir:"*) ;;
*) export PATH="$bin_dir:\$PATH" ;;
esac
$MARKER_END
EOF
}

remove_block() {
	local file="$1"
	[[ -f "$file" ]] || return 0
	grep -qFx -e "$MARKER_BEGIN" -e "$MARKER_END" "$file" || return 0
	local temporary="$file.cc-enhanced.$$"
	# Also drop the one blank line add_block put before the block.
	if ! awk -v begin="$MARKER_BEGIN" -v end="$MARKER_END" '
		$0 == begin { if (skipping) invalid = 1; skipping = 1; pending = 0; next }
		$0 == end { if (!skipping) invalid = 1; skipping = 0; next }
		skipping { next }
		$0 == "" { if (pending) print ""; pending = 1; next }
		{ if (pending) print ""; pending = 0; print }
		END { if (skipping || invalid) exit 1; if (pending) print "" }
	' "$file" >"$temporary"; then
		rm -f "$temporary"
		fail "malformed cc-enhanced PATH block in $file; fix its markers before rerunning setup"
	fi
	cat "$temporary" >"$file"
	rm -f "$temporary"
}

# Appended last so the wrapper stays ahead of directories added earlier.
add_block() {
	local file="$1"
	remove_block "$file"
	mkdir -p "$(dirname "$file")"
	local separator=""
	[[ -s "$file" ]] && separator=$'\n'
	printf '%s%s\n' "$separator" "$(shell_block)" >>"$file"
	say "updated $file"
}

shell_files() {
	printf '%s\n' "$HOME/.bashrc"
	if [[ "$(uname -s)" == "Darwin" ]]; then
		printf '%s\n' "$HOME/.bash_profile"
	fi
	if command -v zsh >/dev/null 2>&1 || [[ -f "${ZDOTDIR:-$HOME}/.zshrc" ]]; then
		printf '%s\n' "${ZDOTDIR:-$HOME}/.zshrc"
	fi
}

fish_file="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/cc-enhanced.fish"

write_fish() {
	command -v fish >/dev/null 2>&1 || [[ -d "$(dirname "$fish_file")" ]] || return 0
	mkdir -p "$(dirname "$fish_file")"
	cat >"$fish_file" <<EOF
# Runs claude through the cc-enhanced wrapper. Undo: $script_dir/install.sh --uninstall
if not contains -- "$bin_dir" \$PATH
    set -gx PATH "$bin_dir" \$PATH
end
EOF
	say "updated $fish_file"
}

recommended_settings='{
	"ultracode": true,
	"promptCacheTtl": "1h",
	"subagentPromptCacheTtl": "1h",
	"env": { "CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS": "50000" }
}'

# Preserve unchanged bytes, symlinks, and permissions. Regular files stay atomic.
write_settings() (
	local merged="$1" temporary
	if [[ -s "$settings_file" ]] &&
		jq -e --argjson merged "$merged" '. == $merged' "$settings_file" >/dev/null; then
		return 0
	fi
	temporary=$(mktemp "$settings_file.cc-enhanced.XXXXXX")
	trap 'rm -f -- "$temporary"' EXIT
	if [[ -f "$settings_file" && ! -L "$settings_file" ]]; then
		cp -p "$settings_file" "$temporary"
	fi
	printf '%s\n' "$merged" >"$temporary"
	if [[ -L "$settings_file" ]]; then
		cat "$temporary" >"$settings_file"
	else
		mv "$temporary" "$settings_file"
	fi
)

# Add recommended keys where unset; never replace a value the user chose.
merge_settings() {
	if ! command -v jq >/dev/null 2>&1; then
		say "jq not found; add these to $settings_file yourself if you want them:"
		printf '%s\n' "$recommended_settings"
		return 0
	fi
	mkdir -p "$(dirname "$settings_file")"
	local current='{}'
	[[ -s "$settings_file" ]] && current=$(cat "$settings_file")
	local merged
	merged=$(jq --argjson defaults "$recommended_settings" '
		def fill($d): reduce ($d | keys_unsorted[]) as $k (.;
			if ($d[$k] | type) == "object" and ((.[$k] // {}) | type) == "object"
			then .[$k] = ((.[$k] // {}) | fill($d[$k]))
			elif has($k) then . else .[$k] = $d[$k] end);
		fill($defaults)
		# Auto-update the cc-enhanced marketplace, but only on the entry Claude
		# Code wrote when it added the marketplace: an entry needs its source.
		| (.extraKnownMarketplaces // {})["cc-enhanced"] as $entry
		| if ($entry | type) == "object" and ($entry | has("autoUpdate") | not)
		then .extraKnownMarketplaces["cc-enhanced"].autoUpdate = true else . end' <<<"$current") || fail "$settings_file is not valid JSON; left unchanged"
	write_settings "$merged"
	say "checked recommended settings in $settings_file"
}

# The wrapper relies on Claude Code updating itself; say so if that is off.
warn_if_updates_disabled() {
	local name
	for name in DISABLE_AUTOUPDATER DISABLE_UPDATES; do
		if [[ "${!name:-}" == "1" ]]; then
			say "warning: $name=1 in your environment stops Claude Code from updating itself"
		fi
		if command -v jq >/dev/null 2>&1 && [[ -s "$settings_file" ]] &&
			[[ "$(jq -r --arg k "$name" '.env[$k] // empty' "$settings_file" 2>/dev/null)" == "1" ]]; then
			say "warning: $name=1 in $settings_file stops Claude Code from updating itself"
		fi
	done
}

# True when dotted version $1 is older than $2.
version_lt() {
	local -a a b
	IFS=. read -r -a a <<<"$1"
	IFS=. read -r -a b <<<"$2"
	local i
	for i in 0 1 2; do
		((10#${a[i]:-0} < 10#${b[i]:-0})) && return 0
		((10#${a[i]:-0} > 10#${b[i]:-0})) && return 1
	done
	return 1
}

# The plugin's manifest records the oldest Claude Code that loads it. Only
# this checkout's manifest is at hand, so the check applies when installing
# from this checkout; another --source may be a different revision.
require_minimum_version() {
	local claude="$1" minimum have
	[[ "$source_spec" == "$script_dir" ]] || return 0
	minimum=$(sed -n 's/.*"minimumClaudeCodeVersion": *"\([0-9.]*\)".*/\1/p' \
		"$script_dir/plugin/.claude-plugin/plugin.json")
	[[ -n "$minimum" ]] || return 0
	have=$("$claude" --version 2>/dev/null | awk 'NR == 1 { print $1 }')
	if [[ "$have" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && version_lt "$have" "$minimum"; then
		fail "Claude Code $have is older than $minimum, the oldest that loads cc-enhanced. Run: claude update"
	fi
}

install() {
	local claude previous_auto_update="" restored
	claude=$(find_claude) || fail "Claude Code is not installed. Install it first: curl -fsSL https://claude.ai/install.sh | bash"
	normalize_source
	require_minimum_version "$claude"

	if ((source_explicit)) && [[ -s "$settings_file" ]]; then
		command -v jq >/dev/null 2>&1 ||
			fail "jq is required to change marketplace sources while preserving existing settings"
		previous_auto_update=$(jq -c --arg name "$MARKETPLACE" '
			(.extraKnownMarketplaces // {})[$name]
			| if type == "object" and has("autoUpdate") then .autoUpdate else empty end
		' "$settings_file") || fail "$settings_file is not valid JSON; left unchanged"
	fi

	if ((source_explicit)) || ! "$claude" plugin marketplace list 2>/dev/null | grep -qw "$MARKETPLACE"; then
		"$claude" plugin marketplace add "$source_spec"
	else
		"$claude" plugin marketplace update "$MARKETPLACE" >/dev/null
	fi
	if [[ -n "$previous_auto_update" ]]; then
		restored=$(jq --arg name "$MARKETPLACE" --argjson value "$previous_auto_update" '
			.extraKnownMarketplaces[$name].autoUpdate = $value
		' "$settings_file")
		write_settings "$restored"
	fi
	"$claude" plugin install "$PLUGIN"
	"$claude" plugin update "$PLUGIN" >/dev/null 2>&1 || true

	write_wrapper
	say "installed the wrapper at $wrapper"
	if [[ ! -r "$prompt_file" ]]; then
		say "note: $prompt_file is not readable, so nothing is appended until it exists"
	fi

	if ((edit_settings)); then merge_settings; fi
	if ((edit_agents)); then install_agents; fi
	warn_if_updates_disabled
	if ((edit_shells)); then
		local file
		while IFS= read -r file; do add_block "$file"; done < <(shell_files)
		write_fish
		say "open a new shell (or run: export PATH=\"$bin_dir:\$PATH\") so claude uses the wrapper"
	else
		say "add $bin_dir to the front of PATH so claude uses the wrapper"
	fi
}

uninstall() {
	local claude
	if claude=$(find_claude); then
		"$claude" plugin uninstall "$PLUGIN" >/dev/null 2>&1 || true
		"$claude" plugin marketplace remove "$MARKETPLACE" >/dev/null 2>&1 || true
	fi
	local file
	while IFS= read -r file; do remove_block "$file"; done < <(shell_files)
	remove_agents
	rm -f "$fish_file"
	rm -rf "$bin_dir"
	rmdir "$data_dir" 2>/dev/null || true
	say "removed plugin, wrapper, shell blocks and unchanged agent defaults; settings and custom agents were left in place"
}

"$action"
