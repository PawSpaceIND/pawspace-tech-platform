#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
CONFIG="$ROOT/.gitleaks.toml"
GITLEAKS_BIN="${GITLEAKS_BIN:-$(command -v gitleaks || true)}"

fail() { printf '[secrets][FAIL] %s\n' "$*" >&2; exit 1; }
log() { printf '[secrets] %s\n' "$*"; }

[[ -n "$GITLEAKS_BIN" ]] || fail "gitleaks is required and was not found in PATH"
[[ -f "$CONFIG" ]] || fail "missing $CONFIG"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pawspace-staged-secrets.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

mapfile_compat() {
  while IFS= read -r line; do
    [[ -n "$line" ]] && printf '%s\0' "$line"
  done
}

COUNT=0
while IFS= read -r -d '' FILE; do
  case "$FILE" in
    /*|../*|*/../*) fail "unsafe staged path: $FILE" ;;
  esac
  mkdir -p "$TMP_DIR/$(dirname "$FILE")"
  git show ":$FILE" > "$TMP_DIR/$FILE"
  COUNT=$((COUNT + 1))
done < <(git diff --cached --name-only --diff-filter=ACMR | mapfile_compat)

if (( COUNT == 0 )); then
  log "no staged files; nothing to scan"
  exit 0
fi

log "scanning staged_files=$COUNT with gitleaks=$($GITLEAKS_BIN version)"
if ! "$GITLEAKS_BIN" detect --no-git --source "$TMP_DIR" --config "$CONFIG" --redact --exit-code 1 --no-banner; then
  fail "SECRET_SCAN_RESULT=BLOCKED staged secret detected"
fi

log "SECRET_SCAN_RESULT=PASS staged_files=$COUNT"
