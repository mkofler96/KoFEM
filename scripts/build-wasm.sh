#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Michael Kofler
# SPDX-License-Identifier: AGPL-3.0-or-later

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

export OCCT_WASM_ROOT NETGEN_WASM_ROOT MFEM_WASM_ROOT

mkdir -p "$BUILD_DIR"

emcmake cmake "$ENGINE_DIR" \
    -B "$BUILD_DIR" \
    -G Ninja \
    -DCMAKE_BUILD_TYPE=Release

cmake --build "$BUILD_DIR" --parallel "$(nproc)"

mkdir -p "$OUT_DIR"

# Copy both outputs verbatim — keep the .wasm name as emitted. The emcc loader
# self-references its sibling as new URL("kofem_wasm_emcc.wasm", import.meta.url);
# renaming the binary here would break that static reference and force Vite to
# leave the URL unresolved (a "resolved at runtime" warning). Same name = Vite
# hashes it at build time.
cp "$BUILD_DIR/kofem_wasm_emcc.js"   "$OUT_DIR/kofem_wasm_emcc.js"
cp "$BUILD_DIR/kofem_wasm_emcc.wasm" "$OUT_DIR/kofem_wasm_emcc.wasm"

# Record which sources these binaries came from, so scripts/fetch-wasm-engine.sh
# leaves a fresh local build alone instead of replacing it with a download. The
# build may run somewhere without git metadata (a CI container checked out from a
# tarball), in which case the caller passes the ID down; with neither, drop the
# stamp rather than leave a stale one claiming the wrong sources.
ENGINE_ID="${KOFEM_ENGINE_ID:-$(bash "$REPO_ROOT/scripts/engine-version.sh" 2>/dev/null || true)}"
if [ -n "$ENGINE_ID" ]; then
    printf '%s\n' "$ENGINE_ID" >"$OUT_DIR/.engine-id"
else
    rm -f "$OUT_DIR/.engine-id"
    echo "NOTE: engine ID unavailable here — wrote no .engine-id stamp."
fi

echo "Done."
echo "  $OUT_DIR/kofem_wasm_emcc.js"
echo "  $OUT_DIR/kofem_wasm_emcc.wasm"
