#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Michael Kofler
# SPDX-License-Identifier: AGPL-3.0-or-later

# Physical-footprint transition study for KOF-215. Native C++ only.
# Usage: CXX=g++ bash scripts/study-shell-solid-footprint.sh [max refinement 1..6]
# Default: 1..4. Refine all directions, including wall thickness, simultaneously.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CXX="${CXX:-clang++}"
STUDY_DIR="$(mktemp -d)"
trap 'rm -rf "$STUDY_DIR"' EXIT

"$CXX" -std=c++17 -O2 -Wall -Wextra \
    -I "$REPO_ROOT/engine/cpp" \
    "$REPO_ROOT/engine/cpp/shell_core.cpp" \
    "$REPO_ROOT/engine/tests/shell_solid_footprint_study.cpp" \
    -o "$STUDY_DIR/shell_solid_footprint_study"

"$STUDY_DIR/shell_solid_footprint_study" "$@"
