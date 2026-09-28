#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Michael Kofler
# SPDX-License-Identifier: AGPL-3.0-or-later

# Build and run the native stress-constrained SIMP validation
# (engine/tests/topology_stress_validation.cpp) — KOF-236: the FD check of the
# aggregated-stress adjoint and the L-bracket benchmark.
#
# Like scripts/test-topology-optimize.sh it links the precompiled WASM MFEM at
# $MFEM_WASM_ROOT, so it is compiled with em++ and run under node. It is NOT run
# by CI (see AGENTS.md). Pass a directory to also write the L-bracket density
# fields there as CSV for the before/after plot.
#
# Usage:  bash scripts/test-topology-stress.sh [dump-dir]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EMSDK="${EMSDK:-/emsdk}"
MFEM_ROOT="${MFEM_WASM_ROOT:-/opt/kofem-deps/mfem}"

if [ ! -f "$MFEM_ROOT/lib/libmfem.a" ]; then
    echo "ERROR: MFEM WASM library not found at $MFEM_ROOT/lib/libmfem.a." >&2
    echo "Set MFEM_WASM_ROOT or run: bash scripts/fetch-wasm-deps.sh" >&2
    exit 1
fi

# emsdk_env.sh puts em++ and emsdk's node on PATH; tolerate `set -u`.
set +u
# shellcheck disable=SC1091
source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
set -u

OUT_DIR="$(mktemp -d)"
OUT="$OUT_DIR/topology_stress_validation.js"

em++ -std=c++17 -O2 -fexceptions \
    -I "$REPO_ROOT/engine/cpp" \
    -I "$MFEM_ROOT/include" \
    "$REPO_ROOT/engine/cpp/topology_simp_core.cpp" \
    "$REPO_ROOT/engine/cpp/topology_filter.cpp" \
    "$REPO_ROOT/engine/cpp/spatial_grid.cpp" \
    "$REPO_ROOT/engine/cpp/topology_mma.cpp" \
    "$REPO_ROOT/engine/cpp/topology_formulation.cpp" \
    "$REPO_ROOT/engine/cpp/topology_optimize.cpp" \
    "$REPO_ROOT/engine/cpp/topology_stress.cpp" \
    "$REPO_ROOT/engine/tests/topology_stress_validation.cpp" \
    -L "$MFEM_ROOT/lib" -lmfem \
    -sDISABLE_EXCEPTION_CATCHING=0 \
    -sEXPORT_EXCEPTION_HANDLING_HELPERS=1 \
    -sALLOW_MEMORY_GROWTH=1 \
    -sINITIAL_MEMORY=268435456 \
    -sUSE_ZLIB=1 \
    -sENVIRONMENT=node \
    -sNODERAWFS=1 \
    -o "$OUT"

node "$OUT" "$@"
