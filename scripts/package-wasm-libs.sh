#!/usr/bin/env bash
# Package the three Emscripten-compiled C++ libraries into a single tarball
# and upload it as a GitHub release asset tagged `wasm-libs-v<N>`.
#
# Usage:
#   source /path/to/emsdk/emsdk_env.sh
#   export OCCT_WASM_ROOT=/opt/wasm/occt
#   export NETGEN_WASM_ROOT=/opt/wasm/netgen
#   export MFEM_WASM_ROOT=/opt/wasm/mfem
#   ./scripts/package-wasm-libs.sh [version]
#
# The version argument defaults to "v1". Bump it whenever you rebuild the libs
# with a different Emscripten version or library version, then update
# WASM_LIBS_VERSION in .github/workflows/ci.yml to match.
#
# Requires: gh (GitHub CLI), tar
set -euo pipefail

VERSION="${1:-v1}"
TAG="wasm-libs-${VERSION}"
ARCHIVE="wasm-libs.tar.gz"
STAGING="$(mktemp -d)"

: "${OCCT_WASM_ROOT:?OCCT_WASM_ROOT must be set}"
: "${NETGEN_WASM_ROOT:?NETGEN_WASM_ROOT must be set}"
: "${MFEM_WASM_ROOT:?MFEM_WASM_ROOT must be set}"

echo "Staging libs into $STAGING ..."
mkdir -p "$STAGING/occt" "$STAGING/netgen" "$STAGING/mfem"

# Copy static libs and all header variants needed by each library:
#   OCCT:   .hxx (headers), .lxx (inline impls), .gxx (template impls)
#   Netgen: .h / .hxx
#   MFEM:   .hpp (all MFEM public headers use this extension)
# Docs, examples, and cmake config files are excluded to keep the archive small.
rsync -a --include='*.a' \
         --include='*.h' --include='*.hxx' --include='*.lxx' --include='*.gxx' \
         --include='*/' --exclude='*' \
         "$OCCT_WASM_ROOT/"  "$STAGING/occt/"
rsync -a --include='*.a' \
         --include='*.h' --include='*.hxx' \
         --include='*/' --exclude='*' \
         "$NETGEN_WASM_ROOT/" "$STAGING/netgen/"
rsync -a --include='*.a' \
         --include='*.h' --include='*.hpp' \
         --include='*/' --exclude='*' \
         "$MFEM_WASM_ROOT/"  "$STAGING/mfem/"

echo "Creating $ARCHIVE ..."
tar -czf "$ARCHIVE" -C "$STAGING" occt netgen mfem

SIZE=$(du -sh "$ARCHIVE" | cut -f1)
echo "Archive size: $SIZE"

echo "Creating GitHub release $TAG and uploading $ARCHIVE ..."
gh release create "$TAG" "$ARCHIVE" \
  --repo mkofler96/KoFEM \
  --title "WASM pre-built libs ${VERSION}" \
  --notes "Pre-built Emscripten static libraries for OCCT, Netgen, and MFEM.
Used by CI to build the kofem-wasm crate without a full Emscripten toolchain build.
Rebuild and re-upload whenever Emscripten or library versions change, then bump
WASM_LIBS_VERSION in .github/workflows/ci.yml."

rm -rf "$STAGING" "$ARCHIVE"
echo "Done — release $TAG published."
