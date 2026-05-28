#!/usr/bin/env bash
# Upload the pre-built Emscripten C++ libs to the wasm-libs GitHub Release.
#
# Run this once after docker-build-wasm.sh has finished (no emsdk needed here).
# The libs are in ~/.cache/kofem-wasm-libs/ — the volume docker-build-wasm.sh
# mounts as /cache inside the container.
#
# Usage:
#   ./upload_wasms.sh [version]   # version defaults to v1
#
# Bump the version whenever Emscripten or OCCT/Netgen/MFEM versions change,
# then update WASM_LIBS_VERSION in .github/workflows/ci.yml to match.

set -euo pipefail

CACHE_DIR="${KFW_CACHE_DIR:-${HOME}/.cache/kofem-wasm-libs}"
VERSION="${1:-v1}"

export OCCT_WASM_ROOT="${CACHE_DIR}/occt"
export NETGEN_WASM_ROOT="${CACHE_DIR}/netgen-pic"
export MFEM_WASM_ROOT="${CACHE_DIR}/mfem-pic"

for DIR in "$OCCT_WASM_ROOT" "$NETGEN_WASM_ROOT" "$MFEM_WASM_ROOT"; do
    if [ ! -d "$DIR" ]; then
        echo "ERROR: $DIR not found."
        echo "Run scripts/docker-build-wasm.sh first to build the C++ libs."
        exit 1
    fi
done

exec "$(dirname "$0")/scripts/package-wasm-libs.sh" "$VERSION"
