#!/usr/bin/env bash
# Build the KoFEM WASM module.
#
# Prerequisites (all compiled with Emscripten):
#   OCCT_WASM_ROOT   — OpenCASCADE install prefix
#   NETGEN_WASM_ROOT — Netgen (nglib) install prefix
#   MFEM_WASM_ROOT   — MFEM install prefix
#
# Quick-start to build the prerequisites:
#
#   # 1. Activate Emscripten
#   source /path/to/emsdk/emsdk_env.sh
#
#   # 2. Build OCCT
#   mkdir occt-build && cd occt-build
#   emcmake cmake ../opencascade-7.8.0 \
#     -DCMAKE_INSTALL_PREFIX="$OCCT_WASM_ROOT" \
#     -DBUILD_MODULE_Draw=OFF -DBUILD_MODULE_Visualization=OFF \
#     -DBUILD_MODULE_ApplicationFramework=OFF
#   emmake make -j$(nproc) install
#
#   # 3. Build Netgen
#   mkdir netgen-build && cd netgen-build
#   emcmake cmake ../netgen \
#     -DCMAKE_INSTALL_PREFIX="$NETGEN_WASM_ROOT" \
#     -DUSE_GUI=OFF -DUSE_PYTHON=OFF
#   emmake make -j$(nproc) install
#
#   # 4. Build MFEM
#   mkdir mfem-build && cd mfem-build
#   emcmake cmake ../mfem \
#     -DCMAKE_INSTALL_PREFIX="$MFEM_WASM_ROOT" \
#     -DMFEM_USE_OPENMP=OFF -DMFEM_USE_MPI=OFF
#   emmake make -j$(nproc) install
#
#   # 5. Run this script
set -euo pipefail

: "${OCCT_WASM_ROOT:?OCCT_WASM_ROOT must be set}"
: "${NETGEN_WASM_ROOT:?NETGEN_WASM_ROOT must be set}"
: "${MFEM_WASM_ROOT:?MFEM_WASM_ROOT must be set}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$REPO_ROOT/web/src/wasm/pkg"

echo "Building KoFEM WASM..."
echo "  OCCT   : $OCCT_WASM_ROOT"
echo "  Netgen : $NETGEN_WASM_ROOT"
echo "  MFEM   : $MFEM_WASM_ROOT"
echo "  Out    : $OUT_DIR"

export OCCT_WASM_ROOT NETGEN_WASM_ROOT MFEM_WASM_ROOT

cargo build \
  --target wasm32-unknown-emscripten \
  --release \
  -p kofem-wasm \
  --target-dir "$REPO_ROOT/target"

mkdir -p "$OUT_DIR"
cp "$REPO_ROOT/target/wasm32-unknown-emscripten/release/kofem_wasm.wasm" "$OUT_DIR/"
cp "$REPO_ROOT/target/wasm32-unknown-emscripten/release/kofem_wasm.js"   "$OUT_DIR/"

echo "Done — WASM module written to $OUT_DIR"
