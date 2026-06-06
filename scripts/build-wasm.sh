#!/usr/bin/env bash
# Build the KoFEM WASM module (C++ engine → Emscripten → JS + WASM).
#
# Prerequisites (all compiled with Emscripten):
#   OCCT_WASM_ROOT   — OpenCASCADE install prefix
#   NETGEN_WASM_ROOT — Netgen (nglib) install prefix
#   MFEM_WASM_ROOT   — MFEM install prefix
#
# Quick-start (after activating emsdk):
#   source /path/to/emsdk/emsdk_env.sh
#   OCCT_WASM_ROOT=... NETGEN_WASM_ROOT=... MFEM_WASM_ROOT=... bash scripts/build-wasm.sh
#
# Inside Docker:
#   bash scripts/docker-build-wasm.sh   (handles everything automatically)

set -euo pipefail

: "${OCCT_WASM_ROOT:?OCCT_WASM_ROOT must be set}"
: "${NETGEN_WASM_ROOT:?NETGEN_WASM_ROOT must be set}"
: "${MFEM_WASM_ROOT:?MFEM_WASM_ROOT must be set}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENGINE_DIR="$REPO_ROOT/engine"
BUILD_DIR="$REPO_ROOT/target/wasm-build"
OUT_DIR="$REPO_ROOT/web/src/wasm/pkg"

echo "Building KoFEM WASM engine (C++ / Embind)..."
echo "  OCCT   : $OCCT_WASM_ROOT"
echo "  Netgen : $NETGEN_WASM_ROOT"
echo "  MFEM   : $MFEM_WASM_ROOT"
echo "  Out    : $OUT_DIR"

# Locate which OCCT archive defines BRepFill::Face (helps resolve linker cascade).
echo "--- OCCT lib inventory ---"
ls "$OCCT_WASM_ROOT/lib"/libTK*.a 2>/dev/null | sort | sed 's|.*/||'
echo "--- BRepFill::Face location ---"
NM=$(command -v llvm-nm || command -v nm || true)
if [ -n "$NM" ]; then
    for f in "$OCCT_WASM_ROOT/lib"/libTK*.a; do
        if "$NM" --defined-only "$f" 2>/dev/null | grep -q "BRepFill.*Face\|BRepFillFace"; then
            echo "  FOUND: $(basename "$f")"
        fi
    done
else
    echo "  (nm not available)"
fi
echo "---"

export OCCT_WASM_ROOT NETGEN_WASM_ROOT MFEM_WASM_ROOT

mkdir -p "$BUILD_DIR"

emcmake cmake "$ENGINE_DIR" \
    -B "$BUILD_DIR" \
    -G Ninja \
    -DCMAKE_BUILD_TYPE=Release

cmake --build "$BUILD_DIR" --parallel "$(nproc)"

mkdir -p "$OUT_DIR"

cp "$BUILD_DIR/kofem_wasm_emcc.js"   "$OUT_DIR/kofem_wasm_emcc.js"
cp "$BUILD_DIR/kofem_wasm_emcc.wasm" "$OUT_DIR/kofem_wasm.wasm"

echo "Done."
echo "  $OUT_DIR/kofem_wasm_emcc.js"
echo "  $OUT_DIR/kofem_wasm.wasm"
