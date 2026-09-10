#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Michael Kofler
# SPDX-License-Identifier: AGPL-3.0-or-later

# Build and run the native SIMP density/sensitivity filter validation
# (engine/tests/topology_filter_validation.cpp) — KOF-229.
#
# The filter core (engine/cpp/topology_filter.cpp) and the shared uniform-grid
# neighbor search (engine/cpp/spatial_grid.cpp) have no MFEM/OCCT/Netgen/
# Emscripten dependency — they work on element centroids and sensitivities as
# plain arrays — so, like scripts/test-shell.sh, this compiles with a plain host
# C++ compiler for a fast unit-test loop. It is NOT run by CI (see CLAUDE.md).
#
# Usage:  bash scripts/test-topology-filter.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CXX="${CXX:-clang++}"
OUT="$(mktemp -d)/topology_filter_validation"

"$CXX" -std=c++17 -O2 -Wall -Wextra \
    -I "$REPO_ROOT/engine/cpp" \
    "$REPO_ROOT/engine/cpp/spatial_grid.cpp" \
    "$REPO_ROOT/engine/cpp/topology_filter.cpp" \
    "$REPO_ROOT/engine/tests/topology_filter_validation.cpp" \
    -o "$OUT"

"$OUT"
