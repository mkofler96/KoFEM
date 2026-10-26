#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Michael Kofler
# SPDX-License-Identifier: AGPL-3.0-or-later

# KOF-215 native reference study; no MFEM/OCCT/Netgen/Emscripten required.
# Successful execution means the solves converged, not that a coupling is accurate.
# Usage: CXX=g++ bash scripts/study-rbe3-junction.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CXX="${CXX:-clang++}"
STUDY_DIR="$(mktemp -d)"
trap 'rm -rf "$STUDY_DIR"' EXIT

"$CXX" -std=c++17 -O2 -Wall -Wextra \
    -I "$REPO_ROOT/engine/cpp" \
    "$REPO_ROOT/engine/cpp/shell_core.cpp" \
    "$REPO_ROOT/engine/tests/rbe3_junction_study.cpp" \
    -o "$STUDY_DIR/rbe3_junction_study"

"$STUDY_DIR/rbe3_junction_study"
