#!/usr/bin/env bash
# Give every published KoFEM release vX.Y.Z a plain image tag, IMAGE:vX.Y.Z.
# Run by CI on main, after scripts/publish-release.sh.
#
#   IMAGE=ghcr.io/mkofler96/kofem-web bash scripts/tag-release-image.sh
#
# The tag goes on the digest main already built, tested and attested for the
# release commit, IMAGE:vX.Y.Z-<sha7> (the publish-image job). Nothing is
# rebuilt and `latest` is never consulted. For every version in CHANGELOG.md
# whose vX.Y.Z Git tag exists on origin:
#
# - IMAGE:vX.Y.Z already on that digest: nothing to do, so reruns are safe.
# - IMAGE:vX.Y.Z on another digest: error. A release tag is never moved.
# - IMAGE:vX.Y.Z-<sha7> missing: an error for the current version (its image
#   was published by this same run), a warning for an older one (backfill only
#   tags releases whose own image still exists).
set -euo pipefail
cd "$(dirname "$0")/.."

: "${IMAGE:?IMAGE must name the image repository, e.g. ghcr.io/mkofler96/kofem-web}"

current=$(bash scripts/release-version.sh)

# The commit a release tag on origin points to. A lightweight tag lists the
# commit itself; an annotated one also lists the commit as "<tag>^{}".
tag_commit() {
  local refs
  refs=$(git ls-remote --tags origin "refs/tags/$1" "refs/tags/$1^{}")
  [ -n "$refs" ] || return 0
  if grep -q '\^{}$' <<<"$refs"; then
    grep '\^{}$' <<<"$refs" | cut -f1
  else
    cut -f1 <<<"$refs"
  fi
}

# The digest a reference names, or nothing when the registry has no such tag.
digest_of() {
  local manifest
  manifest=$(docker buildx imagetools inspect "$1" --format '{{json .Manifest}}' 2>/dev/null) || return 0
  jq -r '.digest' <<<"$manifest"
}

failed=0
for version in $(bash scripts/release-version.sh --changelog-versions); do
  tag="v$version"
  commit=$(tag_commit "$tag")
  [ -n "$commit" ] || continue

  # publish-image names the image after `git rev-parse --short HEAD` in a
  # shallow checkout, which is always 7 characters there.
  source="$IMAGE:$tag-${commit:0:7}"
  target="$IMAGE:$tag"

  expected=$(digest_of "$source")
  if [ -z "$expected" ]; then
    message="$source does not exist, so $target cannot be added. It is never taken from another tag such as latest."
    if [ "$version" = "$current" ]; then
      echo "ERROR: $message" >&2
      failed=1
    else
      echo "::warning::$message"
    fi
    continue
  fi

  existing=$(digest_of "$target")
  if [ -n "$existing" ]; then
    if [ "$existing" = "$expected" ]; then
      echo "$target -> $expected (already tagged)"
    else
      echo "ERROR: $target points to $existing, but release $tag was built as $source = $expected. A release tag is never moved; check which image was deployed before changing it by hand." >&2
      failed=1
    fi
    continue
  fi

  docker buildx imagetools create --tag "$target" "$IMAGE@$expected"
  tagged=$(digest_of "$target")
  if [ "$tagged" != "$expected" ]; then
    echo "ERROR: $target now points to '${tagged}', expected $expected (from $source)." >&2
    failed=1
    continue
  fi
  echo "$target -> $expected"
done

exit "$failed"
