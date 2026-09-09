#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Michael Kofler
# SPDX-License-Identifier: AGPL-3.0-or-later

# Build and run the native SIMP topology-optimization validation
# (engine/tests/topology_simp_validation.cpp) — KOF-228.
#
# Unlike scripts/test-bc-validation.sh and scripts/test-shell.sh, the SIMP core
# (engine/cpp/topology_simp_core.cpp) solves a real elastic problem, so it links
# MFEM. The precompiled MFEM at $MFEM_WASM_ROOT is a WASM (emcc) archive, so the
# test is compiled with em++ and run under node — the same toolchain the engine
# uses. It is NOT run by CI (see CLAUDE.md); this is the fast local proof of the
# per-iteration math (compliance reproduction + finite-difference sensitivities).
#
# Usage:  bash scripts/test-topology.sh

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
OUT="$OUT_DIR/topology_simp_validation.js"

em++ -std=c++17 -O2 -fexceptions \
    -I "$REPO_ROOT/engine/cpp" \
    -I "$MFEM_ROOT/include" \
    "$REPO_ROOT/engine/cpp/topology_simp_core.cpp" \
    "$REPO_ROOT/engine/tests/topology_simp_validation.cpp" \
    -L "$MFEM_ROOT/lib" -lmfem \
    -sDISABLE_EXCEPTION_CATCHING=0 \
    -sEXPORT_EXCEPTION_HANDLING_HELPERS=1 \
    -sALLOW_MEMORY_GROWTH=1 \
    -sINITIAL_MEMORY=268435456 \
    -sUSE_ZLIB=1 \
    -sENVIRONMENT=node \
    -o "$OUT"

node "$OUT"
