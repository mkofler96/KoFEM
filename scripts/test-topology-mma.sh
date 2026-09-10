#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Michael Kofler
# SPDX-License-Identifier: AGPL-3.0-or-later

# Build and run the native MMA optimizer validation
# (engine/tests/topology_mma_validation.cpp) — KOF-230.
#
# The MMA optimizer (engine/cpp/topology_mma.cpp) is self-contained dense linear
# algebra with no MFEM/OCCT/Netgen/Emscripten dependency — it works on design
# variables, function values and gradients as plain arrays — so, like
# scripts/test-shell.sh and scripts/test-topology-filter.sh, this compiles with a
# plain host C++ compiler for a fast unit-test loop. It is NOT run by CI (see
# CLAUDE.md).
#
# Usage:  bash scripts/test-topology-mma.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CXX="${CXX:-clang++}"
OUT="$(mktemp -d)/topology_mma_validation"

"$CXX" -std=c++17 -O2 -Wall -Wextra \
    -I "$REPO_ROOT/engine/cpp" \
    "$REPO_ROOT/engine/cpp/topology_mma.cpp" \
    "$REPO_ROOT/engine/tests/topology_mma_validation.cpp" \
    -o "$OUT"

"$OUT"
