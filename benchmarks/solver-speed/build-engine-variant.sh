#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Michael Kofler
# SPDX-License-Identifier: AGPL-3.0-or-later

# Build one variant of the C++/MFEM engine as it was before the solver moved
# to Rust (commit 1963c81, the parent of fdaa2d3 "Remove the C++ solvers and
# MFEM from the engine"), for the solver-speed study (README.md).
#
# Usage: build-engine-variant.sh <old-tree> <out-dir> <name> <O2|O3> <on|off>
#   <old-tree>  a worktree of 1963c81:
#               git worktree add <old-tree> 1963c81
#   <O2|O3>     the optimisation level of KoFEM's own C++ (the engine's
#               target_compile_options; MFEM itself is prebuilt at -O3 and the
#               link optimises at -O3 either way)
#   <on|off>    Asyncify. Off removes the three ASYNCIFY link options; the one
#               async import (asked when CG reaches its iteration budget, which
#               the benchmark never does) then answers "stop" synchronously.
#
# Needs the Emscripten SDK and the prebuilt OCCT, Netgen and MFEM of
# kofem-dependencies:0.0.2 (scripts/fetch-wasm-deps.sh puts them in /emsdk and
# /opt/kofem-deps). With O2 and on, the build is byte for byte the engine the
# app shipped (engine-d92699c9ed8f).

set -euo pipefail
OLD=$1; OUT=$2; NAME=$3; OPT=$4; ASYNC=$5
WORK=$OUT/src/$NAME
rm -rf "$WORK"; mkdir -p "$WORK" "$OUT/$NAME"
cp -r "$OLD/engine" "$WORK/engine"
CM="$WORK/engine/CMakeLists.txt"
sed -i "s/^    -O2$/    -$OPT/" "$CM"
grep -q "^    -$OPT\$" "$CM"
if [ "$ASYNC" = off ]; then
    sed -i '/-sASYNCIFY=1/d; /-sASYNCIFY_STACK_SIZE/d; /-sASYNCIFY_ONLY/d' "$CM"
    ! grep -q ASYNCIFY= "$CM"
    python3 - "$WORK/engine/cpp/cg_browser.cpp" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read()
start = text.index("EM_ASYNC_JS(int, ask_cg_limit,")
end = text.rindex("});", start, text.index("EM_JS(bool, has_cg_callback")) + 3
signature = text[start:text.index("{", start)]
arguments = signature[len("EM_ASYNC_JS(int, ask_cg_limit,"):].rstrip().rstrip(",")
text = text[:start] + "EM_JS(int, ask_cg_limit," + arguments + ", { return 0; });" + text[end:]
open(path, "w").write(text)
PY
fi
# shellcheck disable=SC1091
source /emsdk/emsdk_env.sh >/dev/null 2>&1
export OCCT_WASM_ROOT=/opt/kofem-deps/occt NETGEN_WASM_ROOT=/opt/kofem-deps/netgen MFEM_WASM_ROOT=/opt/kofem-deps/mfem
BUILD=$OUT/build/$NAME
emcmake cmake "$WORK/engine" -B "$BUILD" -G Ninja -DCMAKE_BUILD_TYPE=Release >/dev/null
cmake --build "$BUILD" --parallel "$(nproc)" -- -v >"$OUT/$NAME/build.log" 2>&1
cp "$BUILD/kofem_wasm_emcc.js" "$BUILD/kofem_wasm_emcc.wasm" "$OUT/$NAME/"
echo "$NAME: $(sha1sum "$OUT/$NAME/kofem_wasm_emcc.wasm" | cut -d' ' -f1)"
