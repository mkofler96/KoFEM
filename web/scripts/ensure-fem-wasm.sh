#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Michael Kofler
# SPDX-License-Identifier: AGPL-3.0-or-later

# Make sure web/src/wasm/fem holds the Rust finite-element module before a
# dev server, build or test run — the pre-hooks in package.json call this
# through `wasm:prepare`.
#
#   - In the repo: build it with scripts/build-fem-wasm.sh (cargo is
#     incremental, so an unchanged crate costs about a second).
#   - KOFEM_WASM_SKIP_FETCH=1 (CI jobs that download the module as an artifact,
#     like the engine): use it as provisioned, and fail if it is missing.
#   - Docker build context (web/ only, no repo scripts/): use what was copied in.

set -euo pipefail

WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODULE="$WEB_DIR/src/wasm/fem/kofem_wasm_bg.wasm"
BUILD="$WEB_DIR/../scripts/build-fem-wasm.sh"

require_module() {
    if [ ! -f "$MODULE" ]; then
        echo "ERROR: $1, but $MODULE is missing." >&2
        echo "Build it with: bash scripts/build-fem-wasm.sh (from the repo root)" >&2
        exit 1
    fi
}

if [ "${KOFEM_WASM_SKIP_FETCH:-}" = "1" ]; then
    require_module "KOFEM_WASM_SKIP_FETCH=1 says the WASM modules are provisioned"
    echo "KOFEM_WASM_SKIP_FETCH=1 — using web/src/wasm/fem as provisioned."
    exit 0
fi
if [ -f "$BUILD" ]; then
    exec bash "$BUILD"
fi
require_module "there is no repo scripts/ here (Docker build context)"
echo "No repo scripts/ in this context — using src/wasm/fem as provisioned."
