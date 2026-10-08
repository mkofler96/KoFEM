#!/usr/bin/env bash
# Print the product version, after checking that everything declaring it agrees.
#
#   scripts/release-version.sh          # prints e.g. 0.1.0
#   scripts/release-version.sh --notes  # prints that version's CHANGELOG.md section
#
# The version lives in web/package.json and in Cargo.toml [workspace.package];
# CHANGELOG.md must carry a "## [X.Y.Z]" section for it. CI runs this on every PR,
# so a release PR that bumps one file and forgets the other cannot merge.
set -euo pipefail
cd "$(dirname "$0")/.."

web_version=$(jq -r .version web/package.json)
cargo_version=$(sed -n '/^\[workspace\.package\]/,/^\[/s/^version = "\(.*\)"$/\1/p' Cargo.toml)

if [ -z "$cargo_version" ]; then
  echo "ERROR: no version found under [workspace.package] in Cargo.toml." >&2
  exit 1
fi
if [ "$web_version" != "$cargo_version" ]; then
  echo "ERROR: web/package.json says $web_version but Cargo.toml [workspace.package] says $cargo_version. A release PR bumps both." >&2
  exit 1
fi

# Everything from "## [X.Y.Z]" up to the next "## [" heading, minus the heading.
notes=$(awk -v ver="$web_version" '
  index($0, "## [" ver "]") == 1 { inside = 1; next }
  inside && index($0, "## [") == 1 { exit }
  inside { print }
' CHANGELOG.md)

if [ -z "$(printf '%s' "$notes" | tr -d '[:space:]')" ]; then
  echo "ERROR: CHANGELOG.md has no '## [$web_version]' section, or it is empty. A release PR adds one." >&2
  exit 1
fi

if [ "${1:-}" = "--notes" ]; then
  printf '%s\n' "$notes" | sed -e '/./,$!d'
else
  echo "$web_version"
fi
