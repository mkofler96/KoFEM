#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Michael Kofler
# SPDX-License-Identifier: AGPL-3.0-or-later

# Build and run the native tie-constraint validation
# (engine/tests/tie_constraints_validation.cpp).
#
# engine/cpp/tie_constraints.cpp turns the node ties of the all-solid solve into a
# master-slave elimination (issue #357). It and the coupling_constraints unit it
# reuses for chain substitution have no MFEM/OCCT/Netgen/Emscripten dependency,
# so they compile with a plain host C++ compiler.
#
# Usage:  bash scripts/test-tie-constraints.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CXX="${CXX:-clang++}"
OUT="$(mktemp -d)/tie_constraints_validation"

"$CXX" -std=c++17 -O2 -Wall -Wextra \
    -I "$REPO_ROOT/engine/cpp" \
    "$REPO_ROOT/engine/cpp/tie_constraints.cpp" \
    "$REPO_ROOT/engine/cpp/coupling_constraints.cpp" \
    "$REPO_ROOT/engine/tests/tie_constraints_validation.cpp" \
    -o "$OUT"

"$OUT"
