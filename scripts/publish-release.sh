#!/usr/bin/env bash
# Publish GitHub Releases for KoFEM versions. Run by CI on main.
#
# 1. Every version in CHANGELOG.md whose vX.Y.Z tag already exists but has no
#    GitHub Release gets one, with its changelog section as notes. This covers
#    tags the maintainer made by hand. The tag already fixes the commit, so this
#    is safe from any run.
# 2. If the current version has no tag yet, it is created here, but only by the
#    run for the release commit. That is the commit that added this version's
#    "## [X.Y.Z]" heading to CHANGELOG.md, i.e. the merged release PR. A later
#    commit on main never gets the tag, even when the release commit's run failed
#    or is still running, so a tag always names the commit the maintainer
#    approved by merging.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${GITHUB_SHA:?GITHUB_SHA must name the commit this run is for}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must name the repository}"

if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
  echo "ERROR: shallow checkout. Finding the release commit needs full history (actions/checkout fetch-depth: 0)." >&2
  exit 1
fi

current=$(bash scripts/release-version.sh)

has_release() { gh release view "$1" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; }
has_tag() { git ls-remote --exit-code --tags origin "refs/tags/$1" >/dev/null; }

# Oldest first, so the current version is published last.
for version in $(bash scripts/release-version.sh --changelog-versions); do
  tag="v$version"
  if has_release "$tag" || ! has_tag "$tag"; then
    continue
  fi
  latest=false
  [ "$version" = "$current" ] && latest=true
  bash scripts/release-version.sh --notes "$version" > release-notes.md
  if ! gh release create "$tag" \
    --repo "$GITHUB_REPOSITORY" \
    --verify-tag \
    --title "KoFEM $tag" \
    --notes-file release-notes.md \
    --latest="$latest"; then
    # Two runs on main can backfill the same tag at once; the loser finds it done.
    has_release "$tag" || { echo "ERROR: publishing the release for existing tag $tag failed." >&2; exit 1; }
  fi
  echo "Release $tag published for the existing tag."
done

tag="v$current"
if has_tag "$tag"; then
  echo "Release $tag is published — nothing to tag."
  exit 0
fi

heading_pattern="^## \\[$(printf '%s' "$current" | sed 's/\./\\./g')\\]"
release_commit=$(git log -1 --format=%H -G"$heading_pattern" -- CHANGELOG.md)
if [ -z "$release_commit" ]; then
  echo "ERROR: no commit in history adds the '## [$current]' heading to CHANGELOG.md." >&2
  exit 1
fi

if [ "$release_commit" != "$GITHUB_SHA" ]; then
  echo "::warning::$tag is not published yet. Only the run for its release commit $release_commit publishes it, and this run is for $GITHUB_SHA. If that run failed, re-run it."
  exit 0
fi

bash scripts/release-version.sh --notes > release-notes.md
gh release create "$tag" \
  --repo "$GITHUB_REPOSITORY" \
  --target "$GITHUB_SHA" \
  --title "KoFEM $tag" \
  --notes-file release-notes.md \
  --latest
