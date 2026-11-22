#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Michael Kofler
# SPDX-License-Identifier: AGPL-3.0-or-later

# scripts/fetch-wasm-engine.sh
#
# Install the prebuilt WASM engine (kofem_wasm_emcc.js + .wasm) into
# web/src/wasm/pkg/ by downloading it from the GitHub Container Registry.
#
# The compiled engine is ~34 MB and used to be committed on every engine change,
# which added a fresh full-size blob to git history each time (KOF-186). It is a
# build output, not source, so CI publishes it instead, as the OCI artifact
# ghcr.io/mkofler96/kofem-engine:engine-<id> (scripts/publish-wasm-engine.sh).
# It is not a GitHub Release: Zenodo archives every GitHub Release of this
# repository as a version of the software (KOF-450). Engines published before
# that are GitHub Releases, which the scripts in those older checkouts fetch.
#
# Which engine? scripts/engine-version.sh hashes the engine sources into an ID,
# and CI publishes each build under that ID on push to main and develop. So the
# sources in your checkout select the matching binary automatically — there is no
# version to bump by hand, and a stale binary can never be paired with new sources.
#
# Only curl is needed: the script speaks the registry's HTTP API itself, pulls
# anonymously (the package is public), and checks every file against the
# sha256 digest the registry lists for it.
#
# Usage:
#   bash scripts/fetch-wasm-engine.sh              # install, fail if unavailable
#   bash scripts/fetch-wasm-engine.sh --optional   # install if published, else no-op
#
# Environment:
#   KOFEM_ENGINE_ID     override the computed ID (for hosts without git metadata)
#   KOFEM_ENGINE_IMAGE  registry repository, default ghcr.io/mkofler96/kofem-engine
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
# second-guess it — on a PR that changes engine/ nothing is published yet.
if [ "${KOFEM_WASM_SKIP_FETCH:-}" = "1" ]; then
    echo "KOFEM_WASM_SKIP_FETCH=1 — using web/src/wasm/pkg as provisioned."
    exit 0
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$REPO_ROOT/web/src/wasm/pkg"
STAMP="$OUT_DIR/.engine-id"
IMAGE="${KOFEM_ENGINE_IMAGE:-ghcr.io/mkofler96/kofem-engine}"
REGISTRY="${IMAGE%%/*}"
NAME="${IMAGE#*/}"
ASSETS=(kofem_wasm_emcc.js kofem_wasm_emcc.wasm)

TAG="${KOFEM_ENGINE_ID:-$(bash "$REPO_ROOT/scripts/engine-version.sh")}"

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | cut -d' ' -f1
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
        echo "'curl' not available here — skipping the download."
        exit 0
    fi
    echo "ERROR: 'curl' is required but not installed" >&2
    exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Nothing published for these sources: keep an engine already on disk, let an
# --optional caller build from source, and fail anyone else with how to build.
unavailable() {
    if have_engine; then
        echo "WARNING: no published engine build for ${TAG} (${1})." >&2
        echo "         Keeping the existing ${OUT_DIR#"$REPO_ROOT"/} — it was built from different sources." >&2
        echo "         Rebuild with scripts/docker-build-wasm.sh to match this checkout." >&2
        exit 0
    fi
    if [ "$OPTIONAL" = "1" ]; then
        echo "No published engine build for ${TAG} (${1}) — caller will build from source."
        exit 0
    fi
    echo "ERROR: no published engine build for ${TAG} (${1}), and none present locally." >&2
    echo "" >&2
    echo "  CI publishes the engine for sources merged to main or develop. If you" >&2
    echo "  changed engine/ (or are on a branch that did), build it:" >&2
    echo "" >&2
    echo "    bash scripts/docker-build-wasm.sh" >&2
    echo "" >&2
    echo "  Otherwise it may still be publishing — check the CI run on develop." >&2
    exit 1
}

# One request whose HTTP status the caller decides on. A transport failure
# (no network, DNS) is shown verbatim and is always fatal: it says nothing
# about whether the engine is published.
http() {
    local out="$1" status=0 code
    shift
    code="$(curl -sS --retry 3 --retry-delay 2 -o "$out" -w '%{http_code}' "$@" 2>"$TMP/curl.err")" || status=$?
    if [ "$status" -ne 0 ]; then
        cat "$TMP/curl.err" >&2
        echo "ERROR: could not reach ${REGISTRY} (curl exit ${status})." >&2
        exit 1
    fi
    printf '%s' "$code"
}

# The digest of the layer titled $2 in manifest $1, without jq. awk walks the
# JSON (skipping strings) and looks at every object: a layer descriptor is one
# that holds exactly one "digest" and this title. Key order and formatting do
# not matter, and exactly one layer must match.
layer_digest() {
    local found
    found="$(tr -d '\n\r\t' <"$1" | awk -v title="$2" '
        { s = s $0 }
        END {
            t = title; gsub(/\./, "\\.", t)
            want = "\"org.opencontainers.image.title\": *\"" t "\""
            n = length(s); depth = 0; instr = 0
            for (i = 1; i <= n; i++) {
                c = substr(s, i, 1)
                if (instr) { if (c == "\\") i++; else if (c == "\"") instr = 0; continue }
                if (c == "\"") { instr = 1; continue }
                if (c == "{") { start[++depth] = i; continue }
                if (c != "}" || depth == 0) continue
                obj = substr(s, start[depth], i - start[depth] + 1); depth--
                probe = obj
                if (gsub(/"digest": *"/, "", probe) != 1 || obj !~ want) continue
                if (match(obj, /"digest": *"sha256:[0-9a-f]+"/)) {
                    d = substr(obj, RSTART, RLENGTH); sub(/.*sha256:/, "", d); sub(/"$/, "", d)
                    print d
                }
            }
        }')"
    [[ "$found" =~ ^[0-9a-f]{64}$ ]] || return 1
    printf '%s\n' "$found"
}

echo "==> Fetching WASM engine ${TAG} from ${IMAGE}..."

# An anonymous pull token. GHCR denies it for a package that does not exist or
# is not public; the two look the same from outside.
code="$(http "$TMP/token.json" "https://${REGISTRY}/token?scope=repository:${NAME}:pull&service=${REGISTRY}")"
case "$code" in
    200) ;;
    401 | 403) unavailable "${IMAGE} does not exist or is not public" ;;
    *)
        cat "$TMP/token.json" >&2
        echo "ERROR: ${REGISTRY} refused a pull token with HTTP ${code}." >&2
        exit 1
        ;;
esac
TOKEN="$(sed -n 's/.*"token" *: *"\([^"]*\)".*/\1/p' "$TMP/token.json")"
[ -n "$TOKEN" ] || {
    echo "ERROR: ${REGISTRY} answered without a token." >&2
    exit 1
}
AUTH="Authorization: Bearer ${TOKEN}"

code="$(http "$TMP/manifest.json" -H "$AUTH" \
    -H "Accept: application/vnd.oci.image.manifest.v1+json" \
    "https://${REGISTRY}/v2/${NAME}/manifests/${TAG}")"
case "$code" in
    200) ;;
    404) unavailable "${IMAGE}:${TAG} is not published" ;;
    *)
        cat "$TMP/manifest.json" >&2
        echo "ERROR: ${REGISTRY} answered HTTP ${code} for ${IMAGE}:${TAG}." >&2
        exit 1
        ;;
esac

# Every file is downloaded and checked before any is installed, so a failure
# leaves the engine on disk as it was.
for a in "${ASSETS[@]}"; do
    digest="$(layer_digest "$TMP/manifest.json" "$a")" || {
        echo "ERROR: ${IMAGE}:${TAG} lists no single file named ${a} — refusing to install it." >&2
        exit 1
    }
    echo "    ${a}"
    curl -fSL --retry 3 --retry-delay 2 --progress-bar -H "$AUTH" \
        "https://${REGISTRY}/v2/${NAME}/blobs/sha256:${digest}" -o "$TMP/${a}"
    actual="$(sha256_of "$TMP/${a}")"
    if [ "$actual" != "$digest" ]; then
        echo "ERROR: ${a} does not match its digest sha256:${digest} (got sha256:${actual}) — refusing to install the engine." >&2
        exit 1
    fi
done

mkdir -p "$OUT_DIR"
for a in "${ASSETS[@]}"; do
    mv -f "$TMP/${a}" "$OUT_DIR/${a}"
done
printf '%s\n' "$TAG" >"$STAMP"

echo "==> WASM engine ready:"
for a in "${ASSETS[@]}"; do
    echo "    ${OUT_DIR}/${a}"
done
