#!/usr/bin/env bash
set -euo pipefail

REMOTE="${REMOTE:-origin}"
BASE="${BASE:-main}"
MODE="${1:---dry-run}"

if [ "$MODE" != "--dry-run" ] && [ "$MODE" != "--execute" ]; then
  echo "usage: $0 [--dry-run|--execute]" >&2
  exit 2
fi

is_protected_branch() {
  [ "$1" = "$BASE" ] && return 0
  case "$1" in
    main|master|develop|development|staging|production|release|release/*|hotfix|hotfix/*|uat|uat/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# Refresh remote truth before deciding that anything is safely deletable.
git fetch "$REMOTE" --prune
BASE_REF="refs/remotes/$REMOTE/$BASE"
git show-ref --verify --quiet "$BASE_REF" || {
  echo "missing $BASE_REF" >&2
  exit 1
}

# Active PR heads are never deletion candidates. In execute mode inability to obtain
# this list is a hard stop; branch cleanup must fail closed rather than guess.
active_pr_file="$(mktemp)"
trap 'rm -f "$active_pr_file"' EXIT
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  gh pr list --state open --limit 1000 --json headRefName --jq '.[].headRefName' | sort -u > "$active_pr_file"
elif [ "$MODE" = "--execute" ]; then
  echo "refusing branch deletion: cannot verify active PR heads with authenticated gh" >&2
  exit 1
else
  echo "warning: active PR heads could not be verified; dry-run will list no deletion candidates" >&2
  exit 0
fi

candidates=()
while IFS= read -r ref; do
  branch="${ref#refs/remotes/$REMOTE/}"
  [ "$branch" = "HEAD" ] && continue
  is_protected_branch "$branch" && continue
  grep -Fxq "$branch" "$active_pr_file" && continue

  # Only delete refs whose current remote tip is already an ancestor of current remote main.
  # This preserves divergent/unmerged work even when branch names look stale.
  if git merge-base --is-ancestor "$ref" "$BASE_REF"; then
    tip="$(git rev-parse "$ref")"
    candidates+=("$branch:$tip")
  fi
done < <(git for-each-ref --format='%(refname)' "refs/remotes/$REMOTE/")

printf 'verified safely deletable merged remote branches: %d\n' "${#candidates[@]}"
for entry in "${candidates[@]}"; do
  branch="${entry%%:*}"; tip="${entry#*:}"
  printf '  %s @ %s\n' "$branch" "$tip"
done

if [ "$MODE" = "--dry-run" ]; then
  echo "dry-run only; protected branches and active PR heads were excluded"
  echo "re-run with --execute to delete exactly the verified candidates"
  exit 0
fi

# Recheck open PR heads immediately before the explicit manual deletion pass.
gh pr list --state open --limit 1000 --json headRefName --jq '.[].headRefName' | sort -u > "$active_pr_file"

# Delete one ref at a time with an exact-tip lease. If a branch moves after candidate discovery,
# the remote rejects the stale deletion instead of removing newly pushed/unmerged work.
for entry in "${candidates[@]}"; do
  branch="${entry%%:*}"; tip="${entry#*:}"
  is_protected_branch "$branch" && { echo "skip protected branch at delete time: $branch"; continue; }
  grep -Fxq "$branch" "$active_pr_file" && { echo "skip newly active PR head: $branch"; continue; }
  git push --force-with-lease="refs/heads/$branch:$tip" "$REMOTE" ":refs/heads/$branch"
done

git fetch "$REMOTE" --prune
printf 'deleted %d merged remote branches\n' "${#candidates[@]}"
