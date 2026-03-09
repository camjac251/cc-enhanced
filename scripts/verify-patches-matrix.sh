#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSIONS_DIR="${ROOT_DIR}/versions_clean"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/claude-patcher-matrix.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

for dep in jq fd; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    echo "$dep is required but not found" >&2
    exit 1
  fi
done

detect_selected_version() {
  if [[ -n "${SELECTED_VERSION:-}" ]]; then
    echo "$SELECTED_VERSION"
    return 0
  fi

  local current_link="${HOME}/.local/share/claude/versions/current"
  if [[ -e "$current_link" || -L "$current_link" ]]; then
    local current_target
    current_target="$(readlink -f "$current_link" 2>/dev/null || true)"
    if [[ "$current_target" =~ /native-cache/([0-9]+\.[0-9]+\.[0-9]+)/ ]]; then
      echo "${BASH_REMATCH[1]}"
      return 0
    fi
  fi

  mapfile -t versions < <(
    fd -t d '^[0-9]+\.[0-9]+\.[0-9]+$' "$VERSIONS_DIR" -d 1 \
      | xargs -I{} basename "{}" \
      | sort -V
  )
  if [[ ${#versions[@]} -gt 0 ]]; then
    echo "${versions[-1]}"
    return 0
  fi

  return 1
}

selected_version="$(detect_selected_version || true)"
if [[ -z "$selected_version" ]]; then
  echo "No selected version found." >&2
  echo "Set SELECTED_VERSION=<X.Y.Z> or ensure versions_clean/<X.Y.Z>/cli.js exists." >&2
  exit 1
fi

target="${VERSIONS_DIR}/${selected_version}/cli.js"
if [[ ! -f "$target" ]]; then
  echo "Selected target not found: $target" >&2
  echo "Available clean targets:" >&2
  fd -p 'cli\.js' "$VERSIONS_DIR" -t f | sort >&2 || true
  exit 1
fi

summary_path="${TMP_DIR}/summary-${selected_version}.json"
log_path="${TMP_DIR}/run-${selected_version}.log"

echo "==> Verifying selected version ${selected_version}: ${target}"
if ! env -u CLAUDE_PATCHER_INCLUDE_TAGS -u CLAUDE_PATCHER_EXCLUDE_TAGS \
  pnpm cli --target "$target" --dry-run --summary-path "$summary_path" >"$log_path" 2>&1; then
  echo "  FAIL: patch run command failed (see $log_path)"
  exit 1
fi

if ! jq -e '.result and (.result.failedTags | type == "array") and (.result.appliedTags | type == "array")' "$summary_path" >/dev/null; then
  echo "  FAIL: summary schema invalid"
  jq -r . "$summary_path" >&2 || true
  exit 1
fi

if ! jq -e '.error == null' "$summary_path" >/dev/null; then
  echo "  FAIL: summary has top-level error"
  jq -r '.error' "$summary_path" >&2
  exit 1
fi

failed_count="$(jq -r '.result.failedTags | length' "$summary_path")"
applied_count="$(jq -r '.result.appliedTags | length' "$summary_path")"

if [[ "$failed_count" != "0" ]]; then
  echo "  FAIL: ${failed_count} failed tag(s), ${applied_count} applied"
  jq -r '.result.verifications[] | select(.passed == false) | "    - \(.tag): \(.reason // "unknown")"' "$summary_path"
  exit 1
fi

echo "  PASS: 0 failed tags, ${applied_count} applied"
