#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Michael Kofler
# SPDX-License-Identifier: AGPL-3.0-or-later

# Build and run the native Kirchhoff-shell validation (engine/tests/shell_validation.cpp).
#
# The shell core (engine/cpp/shell_core.cpp and the shell_element, tet_element,
# coupling_constraints and sparse_cg units it drives) has no MFEM/OCCT/Netgen/Emscripten
# dependency, so it compiles with a plain host C++ compiler — this gives a fast
# unit-test loop for the DKT+CST element math, independent of the WASM build.
#
# Usage:  bash scripts/test-shell.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CXX="${CXX:-clang++}"
OUT="$(mktemp -d)/shell_validation"

"$CXX" -std=c++17 -O2 -Wall -Wextra \
    -I "$REPO_ROOT/engine/cpp" \
    "$REPO_ROOT/engine/cpp/shell_core.cpp" \
    "$REPO_ROOT/engine/cpp/shell_element.cpp" \
    "$REPO_ROOT/engine/cpp/tet_element.cpp" \
    "$REPO_ROOT/engine/cpp/coupling_constraints.cpp" \
    "$REPO_ROOT/engine/cpp/sparse_cg.cpp" \
    "$REPO_ROOT/engine/tests/shell_validation.cpp" \
    -o "$OUT"

"$OUT"
