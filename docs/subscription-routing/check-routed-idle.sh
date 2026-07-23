#!/bin/sh

set -eu

wrapper="$HOME/.local/share/claudex-clodex/runtime/current/dist/claude-wrapper.js"

if command -v pgrep >/dev/null 2>&1 && pgrep -f -- "$wrapper" >/dev/null 2>&1; then
	printf '%s\n' \
		'routed client processes are still active; do not restart the service' >&2
	exit 1
fi

printf '%s\n' 'no routed client process is active'
