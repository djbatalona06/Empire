#!/usr/bin/env bash
# Pushes a folder of screenshots to the orphan `ci-shots` branch so they can be read without an artifact token.
# Usage: ci/publish-shots.sh SRC_DIR LANE   (LANE: ios | admin-desktop | admin-phone ...)
# Lands in ci-shots:<pr-N|branch>/<LANE>/, replacing the previous run's files for that lane.
set -euo pipefail
src=$(cd "$1" && pwd); lane=$2
scope=${PR_NUMBER:+pr-$PR_NUMBER}; scope=${scope:-${GITHUB_REF_NAME//\//-}}
work=$(mktemp -d)

git config --global user.name "github-actions[bot]"
git config --global user.email "41898282+github-actions[bot]@users.noreply.github.com"
if git fetch --depth=1 origin ci-shots 2>/dev/null; then
  git worktree add --detach "$work" FETCH_HEAD
else
  git worktree add --detach "$work"
  git -C "$work" checkout --orphan ci-shots-new
  git -C "$work" rm -rfq --ignore-unmatch .
fi

dest="$work/$scope/$lane"
rm -rf "$dest" && mkdir -p "$dest"
cp -R "$src"/. "$dest"/
printf '{"sha":"%s","run":"%s/%s/actions/runs/%s","at":"%s"}\n' "${HEAD_SHA:-$GITHUB_SHA}" "$GITHUB_SERVER_URL" "$GITHUB_REPOSITORY" "$GITHUB_RUN_ID" "$(date -u +%FT%TZ)" > "$dest/meta.json"

cd "$work"
git add -A
git commit -qm "$scope/$lane @ ${HEAD_SHA:-$GITHUB_SHA}" || exit 0
for attempt in 1 2 3 4; do
  git push -q origin HEAD:ci-shots && exit 0
  sleep $((attempt * 3))
  git pull -q --rebase origin ci-shots
done
exit 1
