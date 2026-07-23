#!/bin/sh

set -eu

wrapper="$HOME/.local/share/claudex-clodex/runtime/current/dist/claude-wrapper.js"
proc_root=${CLAUDEX_PROC_ROOT:-/proc}

for command_name in grep tr; do
	command -v "$command_name" >/dev/null 2>&1 || {
		printf 'cannot verify routed client state because %s is unavailable\n' \
			"$command_name" >&2
		exit 1
	}
done
[ -r "$proc_root/self/cmdline" ] || {
	printf 'cannot inspect routed client state under %s\n' "$proc_root" >&2
	exit 1
}

for cmdline in "$proc_root"/[0-9]*/cmdline; do
	[ -r "$cmdline" ] || continue
	if tr '\000' '\n' <"$cmdline" 2>/dev/null |
		grep -Fx -- "$wrapper" >/dev/null 2>&1; then
		printf '%s\n' \
			'routed client processes are still active; do not restart the service' >&2
		exit 1
	fi
done

printf '%s\n' 'no routed client process is active'
