#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Michael Kofler
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT
SOURCES=(
    "$REPO_ROOT/engine/cpp/shell_core.cpp"
    "$REPO_ROOT/engine/cpp/shell_element.cpp"
    "$REPO_ROOT/engine/cpp/tet_element.cpp"
    "$REPO_ROOT/engine/cpp/coupling_constraints.cpp"
    "$REPO_ROOT/engine/cpp/sparse_cg.cpp"
    "$REPO_ROOT/engine/tests/cg_continuation_validation.cpp"
)
if [ "${1:-}" = "--mfem" ]; then
    EMSDK="${EMSDK:-/emsdk}"
    MFEM_ROOT="${MFEM_WASM_ROOT:-/opt/kofem-deps/mfem}"
    set +u
    source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
    set -u
    em++ -std=c++17 -O2 -fexceptions -DKOFEM_TEST_MFEM \
        -I "$REPO_ROOT/engine/cpp" -I "$MFEM_ROOT/include" \
        "${SOURCES[@]}" "$REPO_ROOT/engine/cpp/cg_mfem.cpp" \
        -L "$MFEM_ROOT/lib" -lmfem -sUSE_ZLIB=1 \
        -sDISABLE_EXCEPTION_CATCHING=0 -sALLOW_MEMORY_GROWTH=1 \
        -sENVIRONMENT=node -o "$OUT_DIR/cg.js"
    node "$OUT_DIR/cg.js"
else
    "${CXX:-g++}" -std=c++17 -O2 -Wall -Wextra -I "$REPO_ROOT/engine/cpp" \
        "${SOURCES[@]}" -o "$OUT_DIR/cg"
    "$OUT_DIR/cg"
fi
