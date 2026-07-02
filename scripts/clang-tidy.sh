#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Michael Kofler
# SPDX-License-Identifier: AGPL-3.0-or-later

# scripts/clang-tidy.sh
#
# Run clang-tidy over the C++ engine (engine/cpp) using the WASM build's
# compile database. The enabled checks live in .clang-tidy and mirror the
# DeepSource C++ rules that gate PRs (issue #294), so findings surface locally
# and in CI instead of as review comments after the fact.
#
# Usage:
#   scripts/clang-tidy.sh [file.cpp ...]    # default: all of engine/cpp/*.cpp
#
# Requirements:
#   - clang-tidy >= 20 — emsdk ships clang-22-era libc++/Embind headers that
#     older clang-tidy front-ends (Ubuntu 24.04's default is 18) cannot parse.
#   - the Emscripten SDK + WASM deps at their image paths
#     (bash scripts/fetch-wasm-deps.sh puts them at /emsdk and /opt/kofem-deps).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$REPO_ROOT/target/wasm-build"

EMSDK="${EMSDK:-/emsdk}"
SYSROOT="$EMSDK/upstream/emscripten/cache/sysroot"
if [ ! -d "$SYSROOT" ]; then
    echo "ERROR: Emscripten sysroot not found at ${SYSROOT}." >&2
    echo "Set EMSDK or run: bash scripts/fetch-wasm-deps.sh" >&2
    exit 1
fi

# ── Pick a clang-tidy that can parse the emsdk headers ─────────────────────────
TIDY="${CLANG_TIDY:-}"
if [ -z "$TIDY" ]; then
    for cand in clang-tidy-22 clang-tidy-21 clang-tidy-20 clang-tidy; do
        command -v "$cand" >/dev/null || continue
        major="$("$cand" --version | sed -n 's/.*version \([0-9]*\).*/\1/p' | head -n1)"
        if [ "${major:-0}" -ge 20 ]; then
            TIDY="$cand"
            break
        fi
    done
fi
if [ -z "$TIDY" ]; then
    echo "ERROR: clang-tidy >= 20 not found (checked clang-tidy-2{2,1,0} and clang-tidy)." >&2
    echo "Install it with: sudo apt-get install clang-tidy-20" >&2
    echo "or point CLANG_TIDY at a suitable binary." >&2
    exit 1
fi

# ── Ensure a compile database exists (configure-only, no build needed) ─────────
if [ ! -f "$BUILD_DIR/compile_commands.json" ]; then
    echo "▶ no compile database — running emcmake configure…"
    export OCCT_WASM_ROOT="${OCCT_WASM_ROOT:-/opt/kofem-deps/occt}"
    export NETGEN_WASM_ROOT="${NETGEN_WASM_ROOT:-/opt/kofem-deps/netgen}"
    export MFEM_WASM_ROOT="${MFEM_WASM_ROOT:-/opt/kofem-deps/mfem}"
    # emsdk_env.sh puts emcmake and emsdk's node on PATH; tolerate `set -u`.
    set +u
    # shellcheck disable=SC1091
    source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
    set -u
    emcmake cmake "$REPO_ROOT/engine" -B "$BUILD_DIR" -G Ninja -DCMAKE_BUILD_TYPE=Release
fi

FILES=("$@")
if [ "${#FILES[@]}" -eq 0 ]; then
    FILES=("$REPO_ROOT"/engine/cpp/*.cpp)
fi

# The compile database records the em++ driver invocation, which omits the
# target/sysroot flags em++ injects internally. Replicate the front-end subset
# of `em++ --cflags` (the -mllvm backend flags are irrelevant for analysis and
# unknown to stock LLVM): fakesdl/compat provide headers musl lacks (xlocale.h).
echo "▶ ${TIDY} (${#FILES[@]} files)…"
"$TIDY" -p "$BUILD_DIR" --quiet \
    --extra-arg-before=--target=wasm32-unknown-emscripten \
    --extra-arg=--sysroot="$SYSROOT" \
    --extra-arg=-DEMSCRIPTEN \
    --extra-arg=-Xclang --extra-arg=-iwithsysroot/include/fakesdl \
    --extra-arg=-Xclang --extra-arg=-iwithsysroot/include/compat \
    "${FILES[@]}"

echo "✓ clang-tidy clean"
