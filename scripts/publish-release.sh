#!/usr/bin/env bash
# Publish the GitHub Release vX.Y.Z for the current version. Run by CI on main.
#
# Only the run for the release commit publishes. That is the commit that added
# this version's "## [X.Y.Z]" heading to CHANGELOG.md, i.e. the merged release
# PR. A later commit on main never gets the tag, even when the release commit's
# run failed or is still running, so a tag always names the commit the
# maintainer approved by merging.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${GITHUB_SHA:?GITHUB_SHA must name the commit this run is for}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must name the repository}"

if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
  echo "ERROR: shallow checkout. Finding the release commit needs full history (actions/checkout fetch-depth: 0)." >&2
  exit 1
fi

version=$(bash scripts/release-version.sh)
tag="v$version"

if gh release view "$tag" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
  echo "Release $tag already published — nothing to do."
  exit 0
fi
if git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null; then
  echo "ERROR: tag $tag exists without a GitHub Release. Create the release for it by hand, or bump the version." >&2
  exit 1
fi

heading_pattern="^## \\[$(printf '%s' "$version" | sed 's/\./\\./g')\\]"
release_commit=$(git log -1 --format=%H -G"$heading_pattern" -- CHANGELOG.md)
if [ -z "$release_commit" ]; then
  echo "ERROR: no commit in history adds the '## [$version]' heading to CHANGELOG.md." >&2
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
