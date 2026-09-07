#!/usr/bin/env bash
set -euo pipefail

REMOTE="${REMOTE:-origin}"
BASE="${BASE:-main}"
MODE="${1:---dry-run}"

if [ "$MODE" != "--dry-run" ] && [ "$MODE" != "--execute" ]; then
  echo "usage: $0 [--dry-run|--execute]" >&2
  exit 2
fi

# Refresh remote truth before deciding that anything is safely deletable.
git fetch "$REMOTE" --prune
BASE_REF="refs/remotes/$REMOTE/$BASE"
git show-ref --verify --quiet "$BASE_REF" || {
  echo "missing $BASE_REF" >&2
  exit 1
}

candidates=()
while IFS= read -r ref; do
  branch="${ref#refs/remotes/$REMOTE/}"
  [ "$branch" = "$BASE" ] && continue
  [ "$branch" = "HEAD" ] && continue

  # Only delete refs whose current remote tip is already an ancestor of current remote main. This is
  # stronger than relying on a stale local --merged list and intentionally preserves divergent work.
  if git merge-base --is-ancestor "$ref" "$BASE_REF"; then
    candidates+=("$branch")
  fi
done < <(git for-each-ref --format='%(refname)' "refs/remotes/$REMOTE/")

printf 'verified merged remote branches: %d\n' "${#candidates[@]}"
for branch in "${candidates[@]}"; do
  printf '  %s\n' "$branch"
done

if [ "$MODE" = "--dry-run" ]; then
  echo "dry-run only; re-run with --execute to delete exactly the branches listed above"
  exit 0
fi

# Delete in bounded batches to avoid command-line size limits and make partial failures obvious.
for ((i=0; i<${#candidates[@]}; i+=25)); do
  batch=("${candidates[@]:i:25}")
  [ "${#batch[@]}" -gt 0 ] || continue
  git push "$REMOTE" --delete "${batch[@]}"
done

git fetch "$REMOTE" --prune
printf 'deleted %d merged remote branches\n' "${#candidates[@]}"
