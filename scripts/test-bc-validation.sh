#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Michael Kofler
# SPDX-License-Identifier: AGPL-3.0-or-later

# Build and run the native BC/load index validation test
# (engine/tests/bc_validation.cpp).
#
# engine/cpp/bc_validation.h has no MFEM/OCCT/Netgen/Emscripten dependency, so
# it compiles with a plain host C++ compiler — a fast unit-test loop that locks
# in the "reject out-of-range vertex/DOF indices loudly" fix (issue #362)
# without needing the full WASM build.
#
# Usage:  bash scripts/test-bc-validation.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CXX="${CXX:-clang++}"
OUT="$(mktemp -d)/bc_validation"

"$CXX" -std=c++17 -O2 -Wall -Wextra \
    -I "$REPO_ROOT/engine/cpp" \
    "$REPO_ROOT/engine/tests/bc_validation.cpp" \
    -o "$OUT"

"$OUT"
