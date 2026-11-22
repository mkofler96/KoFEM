#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Michael Kofler
# SPDX-License-Identifier: AGPL-3.0-or-later

# scripts/publish-wasm-engine.sh
#
# Publish a compiled WASM engine to the GitHub Container Registry as the OCI
# artifact ghcr.io/mkofler96/kofem-engine:engine-<id>, which
# scripts/fetch-wasm-engine.sh downloads. Run by CI on main and develop.
#
#   KOFEM_ENGINE_ID=engine-4f1c2a9b3d70 REGISTRY_USER=<user> REGISTRY_TOKEN=<token> \
#     bash scripts/publish-wasm-engine.sh <folder with kofem_wasm_emcc.js and .wasm>
#
# Not a GitHub Release: Zenodo archives every GitHub Release of this repository
# as a new version of the software, and an engine build is not one (KOF-450).
#
# The ID is a hash of the engine sources (scripts/engine-version.sh), so an
# engine already published under it was built from these exact sources and is
# left alone. Blobs the registry already holds are not uploaded again.
#
# Only curl is needed: the script speaks the OCI distribution API itself.
#
# Environment:
#   KOFEM_ENGINE_ID     required, engine-<12 hex digits>
#   REGISTRY_USER       required, the user REGISTRY_TOKEN belongs to
#   REGISTRY_TOKEN      required, a token that may push the package
#                       (in CI the workflow's GITHUB_TOKEN with packages: write)
#   KOFEM_ENGINE_IMAGE  registry repository, default ghcr.io/mkofler96/kofem-engine
#   GITHUB_REPOSITORY   recorded as the artifact's source, when set
#   GITHUB_SHA          recorded as the artifact's revision, when set

set -euo pipefail

[ "$#" = 1 ] || {
    echo "usage: $0 <folder with kofem_wasm_emcc.js and kofem_wasm_emcc.wasm>" >&2
    exit 1
}
DIST="$1"
ASSETS=(kofem_wasm_emcc.js kofem_wasm_emcc.wasm)
IMAGE="${KOFEM_ENGINE_IMAGE:-ghcr.io/mkofler96/kofem-engine}"
REGISTRY="${IMAGE%%/*}"
NAME="${IMAGE#*/}"
TAG="${KOFEM_ENGINE_ID:-}"

[[ "$TAG" =~ ^engine-[0-9a-f]{12}$ ]] || {
    echo "ERROR: KOFEM_ENGINE_ID '${TAG}' is not of the form engine-<12 hex digits> (scripts/engine-version.sh)." >&2
    exit 1
}
for var in REGISTRY_USER REGISTRY_TOKEN; do
    [ -n "${!var:-}" ] || {
        echo "ERROR: ${var} must be set to push to ${REGISTRY}." >&2
        exit 1
    }
done
for a in "${ASSETS[@]}"; do
    [ -s "$DIST/$a" ] || {
        echo "ERROR: ${DIST}/${a} is missing or empty — nothing to publish." >&2
        exit 1
    }
done

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
size_of() { wc -c <"$1" | tr -d ' '; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# One request whose HTTP status the caller decides on; a transport failure is
# fatal. The body lands in $TMP/body, the response headers in $TMP/headers.
http() {
    local status=0 code
    code="$(curl -sS --retry 3 --retry-delay 2 -o "$TMP/body" -D "$TMP/headers" \
        -w '%{http_code}' "$@" 2>"$TMP/curl.err")" || status=$?
    if [ "$status" -ne 0 ]; then
        cat "$TMP/curl.err" >&2
        echo "ERROR: could not reach ${REGISTRY} (curl exit ${status})." >&2
        exit 1
    fi
    printf '%s' "$code"
}

refused() {
    cat "$TMP/body" >&2 2>/dev/null || true
    echo "" >&2
    echo "ERROR: ${1} (HTTP ${2})." >&2
    exit 1
}

# ── A push token ──────────────────────────────────────────────────────────────
code="$(http -u "${REGISTRY_USER}:${REGISTRY_TOKEN}" \
    "https://${REGISTRY}/token?scope=repository:${NAME}:pull,push&service=${REGISTRY}")"
[ "$code" = 200 ] || refused "${REGISTRY} refused a push token for ${NAME}" "$code"
TOKEN="$(sed -n 's/.*"token" *: *"\([^"]*\)".*/\1/p' "$TMP/body")"
[ -n "$TOKEN" ] || {
    echo "ERROR: ${REGISTRY} answered without a token." >&2
    exit 1
}
AUTH="Authorization: Bearer ${TOKEN}"
MANIFEST_TYPE="application/vnd.oci.image.manifest.v1+json"
MANIFEST_URL="https://${REGISTRY}/v2/${NAME}/manifests/${TAG}"

published() {
    local code
    code="$(http -I -H "$AUTH" -H "Accept: ${MANIFEST_TYPE}" "$MANIFEST_URL")"
    case "$code" in
        200) return 0 ;;
        404) return 1 ;;
        *) refused "${REGISTRY} answered for ${IMAGE}:${TAG}" "$code" ;;
    esac
}

if published; then
    echo "${IMAGE}:${TAG} is already published — nothing to do."
    exit 0
fi

# ── Blobs: an empty config, then one per file ─────────────────────────────────
printf '{}' >"$TMP/config.json"

push_blob() {
    local file="$1" digest code location url
    digest="sha256:$(sha256_of "$file")"
    code="$(http -I -H "$AUTH" "https://${REGISTRY}/v2/${NAME}/blobs/${digest}")"
    case "$code" in
        200)
            echo "    ${digest} already in the registry" >&2
            printf '%s' "$digest"
            return
            ;;
        404) ;;
        *) refused "${REGISTRY} answered for blob ${digest}" "$code" ;;
    esac

    code="$(http -X POST -H "$AUTH" "https://${REGISTRY}/v2/${NAME}/blobs/uploads/")"
    [ "$code" = 202 ] || refused "${REGISTRY} refused to start an upload" "$code"
    location="$(tr -d '\r' <"$TMP/headers" | sed -n 's/^[Ll][Oo][Cc][Aa][Tt][Ii][Oo][Nn]: *//p' | tail -1)"
    [ -n "$location" ] || {
        echo "ERROR: ${REGISTRY} started an upload without saying where to send it." >&2
        exit 1
    }
    case "$location" in
        /*) url="https://${REGISTRY}${location}" ;;
        *) url="$location" ;;
    esac
    case "$url" in
        *\?*) url="${url}&digest=${digest}" ;;
        *) url="${url}?digest=${digest}" ;;
    esac
    code="$(http -X PUT -H "$AUTH" -H "Content-Type: application/octet-stream" \
        --data-binary "@${file}" "$url")"
    [ "$code" = 201 ] || refused "${REGISTRY} refused blob ${digest} ($(basename "$file"))" "$code"
    echo "    ${digest} uploaded ($(basename "$file"))" >&2
    printf '%s' "$digest"
}

echo "==> Publishing ${IMAGE}:${TAG}"
config_digest="$(push_blob "$TMP/config.json")"
layers=""
for a in "${ASSETS[@]}"; do
    case "$a" in
        *.wasm) type="application/wasm" ;;
        *.js) type="application/javascript" ;;
    esac
    digest="$(push_blob "$DIST/$a")"
    [ -z "$layers" ] || layers="${layers},"
    layers="${layers}
    {\"mediaType\": \"${type}\", \"digest\": \"${digest}\", \"size\": $(size_of "$DIST/$a"), \"annotations\": {\"org.opencontainers.image.title\": \"${a}\"}}"
done

annotations="\"org.opencontainers.image.description\": \"Compiled KoFEM WASM engine ${TAG}, installed by scripts/fetch-wasm-engine.sh\""
if [ -n "${GITHUB_REPOSITORY:-}" ]; then
    annotations="${annotations},
    \"org.opencontainers.image.source\": \"https://github.com/${GITHUB_REPOSITORY}\""
fi
if [ -n "${GITHUB_SHA:-}" ]; then
    annotations="${annotations},
    \"org.opencontainers.image.revision\": \"${GITHUB_SHA}\""
fi

cat >"$TMP/manifest.json" <<JSON
{
  "schemaVersion": 2,
  "mediaType": "${MANIFEST_TYPE}",
  "artifactType": "application/vnd.kofem.engine.v1",
  "config": {"mediaType": "application/vnd.oci.empty.v1+json", "digest": "${config_digest}", "size": 2},
  "layers": [${layers}
  ],
  "annotations": {
    ${annotations}
  }
}
JSON

# ── The manifest, under the engine ID ─────────────────────────────────────────
code="$(http -X PUT -H "$AUTH" -H "Content-Type: ${MANIFEST_TYPE}" \
    --data-binary "@$TMP/manifest.json" "$MANIFEST_URL")"
if [ "$code" != 201 ]; then
    # develop and main can publish the same sources at once. Losing that race
    # is fine: the winner published an engine built from these same sources.
    if published; then
        echo "${IMAGE}:${TAG} was published concurrently — nothing to do."
        exit 0
    fi
    refused "${REGISTRY} refused the manifest for ${IMAGE}:${TAG}" "$code"
fi
echo "==> Published ${IMAGE}:${TAG} (sha256:$(sha256_of "$TMP/manifest.json"))"
