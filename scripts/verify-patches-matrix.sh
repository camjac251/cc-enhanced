#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSIONS_DIR="${ROOT_DIR}/versions_clean"
TMP_DIR="${TMPDIR:-/tmp}/claude-patcher-matrix"

for dep in jq fd; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    echo "$dep is required but not found" >&2
    exit 1
  fi
done

# Clean up stale results from previous runs
rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"

mapfile -t TARGETS < <(fd -p 'cli\.js' "$VERSIONS_DIR" -t f | sort)
if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "No clean cli.js targets found under $VERSIONS_DIR" >&2
  exit 1
fi

overall_failed=0

for target in "${TARGETS[@]}"; do
  version="$(basename "$(dirname "$target")")"
  summary_path="${TMP_DIR}/summary-${version}.json"
  log_path="${TMP_DIR}/run-${version}.log"

  echo "==> Verifying ${version}: ${target}"
  if ! pnpm cli --target "$target" --dry-run --no-format --summary-path "$summary_path" >"$log_path" 2>&1; then
    echo "  FAIL: patch run command failed (see $log_path)"
    overall_failed=1
    continue
  fi

  failed_count="$(jq -r '.result.failedTags | length' "$summary_path")"
  applied_count="$(jq -r '.result.appliedTags | length' "$summary_path")"

  if [[ "$failed_count" != "0" ]]; then
    echo "  FAIL: ${failed_count} failed tag(s), ${applied_count} applied"
    jq -r '.result.verifications[] | select(.passed == false) | "    - \(.tag): \(.reason // "unknown")"' "$summary_path"
    overall_failed=1
  else
    echo "  PASS: 0 failed tags, ${applied_count} applied"
  fi
done

if [[ "$overall_failed" -ne 0 ]]; then
  exit 1
fi

echo "All version targets passed."
