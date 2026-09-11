#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Michael Kofler
# SPDX-License-Identifier: AGPL-3.0-or-later

# Build and run the native shell/coupled SIMP topology-optimization validation
# (engine/tests/topology_shell_validation.cpp) — KOF-237.
#
# The shell/coupled optimizer core (engine/cpp/topology_shell.cpp) drives the
# MFEM-free shell_core assembler and reuses the MMA optimizer and the
# mesh-independence filter, all of which compile with a plain host C++ compiler.
# So — like scripts/test-shell.sh and scripts/test-topology-mma.sh — this gives a
# fast native unit-test loop, independent of the WASM build, and in particular
# the finite-difference sensitivity check the acceptance criteria call for.
#
# Usage:  bash scripts/test-topology-shell.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CXX="${CXX:-clang++}"
OUT="$(mktemp -d)/topology_shell_validation"

"$CXX" -std=c++17 -O2 -Wall -Wextra \
    -I "$REPO_ROOT/engine/cpp" \
    "$REPO_ROOT/engine/cpp/shell_core.cpp" \
    "$REPO_ROOT/engine/cpp/spatial_grid.cpp" \
    "$REPO_ROOT/engine/cpp/topology_filter.cpp" \
    "$REPO_ROOT/engine/cpp/topology_mma.cpp" \
    "$REPO_ROOT/engine/cpp/topology_shell.cpp" \
    "$REPO_ROOT/engine/tests/topology_shell_validation.cpp" \
    -o "$OUT"

"$OUT"
