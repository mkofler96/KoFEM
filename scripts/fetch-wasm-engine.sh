#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Michael Kofler
# SPDX-License-Identifier: AGPL-3.0-or-later

# scripts/fetch-wasm-engine.sh
#
# Install the prebuilt WASM engine (kofem_wasm_emcc.js + .wasm) into
# web/src/wasm/pkg/ by downloading it from its GitHub Release.
#
# The compiled engine is ~34 MB and used to be committed on every engine change,
# which added a fresh full-size blob to git history each time (KOF-186). It is a
# build output, not source, so it now ships as a release asset instead.
#
# Which release? scripts/engine-version.sh hashes the engine sources into an ID,
# and CI publishes each build as the release `engine-<id>` on push to main. So the
# sources in your checkout select the matching binary automatically — there is no
# version to bump by hand, and a stale binary can never be paired with new sources.
#
# Usage:
#   bash scripts/fetch-wasm-engine.sh              # install, fail if unavailable
#   bash scripts/fetch-wasm-engine.sh --optional   # install if published, else no-op
#
# Environment:
#   KOFEM_ENGINE_ID    override the computed ID (for hosts without git metadata)
#   KOFEM_ENGINE_REPO  release repository, default mkofler96/KoFEM
#
# If your engine sources are not published (local C++ edits, or an engine change
# that has not merged yet) there is nothing to download — build it instead:
#
#   bash scripts/docker-build-wasm.sh    # any Docker host
#   bash scripts/build-wasm.sh           # with emsdk + deps already set up

set -euo pipefail

OPTIONAL=0
for arg in "$@"; do
    case "$arg" in
        --optional) OPTIONAL=1 ;;
        *)
            echo "ERROR: unknown argument '$arg' (expected --optional)" >&2
            exit 1
            ;;
    esac
done

# CI provisions web/src/wasm/pkg itself (built in the `wasm` job, handed to the
# others as a workflow artifact), so the pre-hooks in web/package.json must not
# second-guess it — on a PR that changes engine/ there is no release to fetch yet.
if [ "${KOFEM_WASM_SKIP_FETCH:-}" = "1" ]; then
    echo "KOFEM_WASM_SKIP_FETCH=1 — using web/src/wasm/pkg as provisioned."
    exit 0
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$REPO_ROOT/web/src/wasm/pkg"
STAMP="$OUT_DIR/.engine-id"
REPO_SLUG="${KOFEM_ENGINE_REPO:-mkofler96/KoFEM}"
ASSETS=(kofem_wasm_emcc.js kofem_wasm_emcc.wasm)

TAG="${KOFEM_ENGINE_ID:-$(bash "$REPO_ROOT/scripts/engine-version.sh")}"

sha256_check() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum -c "$1"
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 -c "$1"
    else
        echo "ERROR: neither sha256sum nor shasum found" >&2
        exit 1
    fi
}

have_engine() {
    for a in "${ASSETS[@]}"; do
        [ -s "$OUT_DIR/$a" ] || return 1
    done
}

# ── Already current? ──────────────────────────────────────────────────────────
# The stamp is written by whoever produced the binaries — this script or
# scripts/build-wasm.sh — so a matching stamp means the files on disk were built
# from exactly these sources. Nothing to do, and no network call.
if have_engine && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$TAG" ]; then
    echo "WASM engine ${TAG} already present — skipping download."
    exit 0
fi

if ! command -v curl >/dev/null; then
    # --optional callers (CI, inside the dependency container) can always fall
    # back to building from source, so a missing curl is not fatal there.
    if [ "$OPTIONAL" = "1" ]; then
        echo "'curl' not available here — skipping the release download."
        exit 0
    fi
    echo "ERROR: 'curl' is required but not installed" >&2
    exit 1
fi

BASE="https://github.com/${REPO_SLUG}/releases/download/${TAG}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> Fetching WASM engine ${TAG} from ${REPO_SLUG} releases..."

# SHA256SUMS doubles as the existence probe: no checksum file, no usable release.
# curl exits 22 on an HTTP error (the expected 404 for an unpublished engine);
# anything else is a transport problem worth showing verbatim.
probe_status=0
curl -fsSL --retry 3 --retry-delay 2 "${BASE}/SHA256SUMS" -o "$TMP/SHA256SUMS" \
    2>"$TMP/probe.err" || probe_status=$?
if [ "$probe_status" -ne 0 ]; then
    if [ "$probe_status" -ne 22 ]; then
        cat "$TMP/probe.err" >&2
        echo "ERROR: could not reach ${BASE}/SHA256SUMS (curl exit ${probe_status})." >&2
        exit 1
    fi
    if have_engine; then
        echo "WARNING: no published engine build for ${TAG}." >&2
        echo "         Keeping the existing ${OUT_DIR#"$REPO_ROOT"/} — it was built from different sources." >&2
        echo "         Rebuild with scripts/docker-build-wasm.sh to match this checkout." >&2
        exit 0
    fi
    if [ "$OPTIONAL" = "1" ]; then
        echo "No published engine build for ${TAG} — caller will build from source."
        exit 0
    fi
    echo "ERROR: no published engine build for ${TAG}, and none present locally." >&2
    echo "" >&2
    echo "  Releases only exist for engine sources merged to main. If you changed" >&2
    echo "  engine/ (or are on a branch that did), build it:" >&2
    echo "" >&2
    echo "    bash scripts/docker-build-wasm.sh" >&2
    echo "" >&2
    echo "  Otherwise the release may still be publishing — check" >&2
    echo "  https://github.com/${REPO_SLUG}/releases/tag/${TAG}" >&2
    exit 1
fi

for a in "${ASSETS[@]}"; do
    echo "    ${a}"
    curl -fSL --retry 3 --retry-delay 2 --progress-bar "${BASE}/${a}" -o "$TMP/${a}"
done

(cd "$TMP" && sha256_check SHA256SUMS) || {
    echo "ERROR: checksum mismatch on the downloaded engine — refusing to install it." >&2
    exit 1
}

mkdir -p "$OUT_DIR"
for a in "${ASSETS[@]}"; do
    mv -f "$TMP/${a}" "$OUT_DIR/${a}"
done
printf '%s\n' "$TAG" >"$STAMP"

echo "==> WASM engine ready:"
for a in "${ASSETS[@]}"; do
    echo "    ${OUT_DIR}/${a}"
done
