#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Michael Kofler
# SPDX-License-Identifier: AGPL-3.0-or-later

# web/scripts/ensure-wasm-engine.sh
#
# Make sure src/wasm/pkg holds the compiled engine before `bun run dev|build|test`.
# Wired up as the pre-hooks in package.json.
#
# The engine is no longer committed (KOF-186); scripts/fetch-wasm-engine.sh at the
# repo root downloads the release matching the engine sources. That script does not
# exist in every context this runs in: web/Dockerfile's build context is web/ alone,
# and there the engine is already COPYed in, so there is nothing to fetch.

set -euo pipefail

FETCH="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/fetch-wasm-engine.sh"

if [ -f "$FETCH" ]; then
    exec bash "$FETCH" "$@"
fi

echo "No repo scripts/ in this context — using src/wasm/pkg as provisioned."
