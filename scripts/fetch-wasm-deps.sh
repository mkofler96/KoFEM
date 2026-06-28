#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Michael Kofler
# SPDX-License-Identifier: AGPL-3.0-or-later

# scripts/fetch-wasm-deps.sh
#
# Fetch the prebuilt WASM toolchain + dependencies WITHOUT Docker.
#
# scripts/docker-build-wasm.sh runs the kofem-dependencies image in a container,
# which needs a Docker daemon with a copy-on-write storage driver. Sandboxed
# environments (e.g. Claude Code on the web) often fall back to the `vfs` storage
# driver, which duplicates every layer on unpack and blows past the disk quota —
# so the image can never be materialised there.
#
# This script sidesteps Docker entirely. It pulls only the two directory trees the
# build actually needs straight from the ghcr.io layer blobs:
#
#   /emsdk           — the Emscripten SDK (self-contained: clang, node, sysroot)
#   /opt/kofem-deps  — OCCT, Netgen and MFEM prebuilt as WASM static libs
#
# They are written to the same absolute paths the image uses, so the toolchain's
# baked-in paths stay valid. Extraction is linear in the file union (~2 GB), not
# the O(n^2) layer duplication that vfs incurs.
#
# After running, build with:
#   source /emsdk/emsdk_env.sh
#   OCCT_WASM_ROOT=/opt/kofem-deps/occt \
#   NETGEN_WASM_ROOT=/opt/kofem-deps/netgen \
#   MFEM_WASM_ROOT=/opt/kofem-deps/mfem \
#   bash scripts/build-wasm.sh
#
# (The SessionStart hook in .claude/hooks/session-start.sh runs this automatically
#  and exports those variables for the whole session.)

set -euo pipefail

# Keep IMAGE_TAG in sync with the image tag in scripts/docker-build-wasm.sh.
REGISTRY="ghcr.io"
IMAGE_REPO="mkofler96/kofem-dependencies"
IMAGE_TAG="${KOFEM_DEPS_TAG:-0.0.2}"

EMSDK_DIR="/emsdk"
DEPS_DIR="/opt/kofem-deps"
WANT=(emsdk opt/kofem-deps)

case "$(uname -m)" in
    x86_64 | amd64) ARCH="amd64" ;;
    aarch64 | arm64) ARCH="arm64" ;;
    *)
        echo "ERROR: unsupported architecture '$(uname -m)'"
        exit 1
        ;;
esac

# ── Idempotency: skip if the requested tag is already extracted ────────────────
if [ -x "$EMSDK_DIR/upstream/emscripten/emcc" ] &&
    [ -f "$DEPS_DIR/.kofem-deps-tag" ] &&
    [ "$(cat "$DEPS_DIR/.kofem-deps-tag")" = "$IMAGE_TAG" ]; then
    echo "WASM deps already present (${IMAGE_REPO}:${IMAGE_TAG}) — skipping fetch."
    exit 0
fi

for tool in curl jq tar; do
    command -v "$tool" >/dev/null || {
        echo "ERROR: '$tool' is required but not installed"
        exit 1
    }
done

token() {
    curl -fsSL "https://${REGISTRY}/token?scope=repository:${IMAGE_REPO}:pull&service=${REGISTRY}" | jq -r .token
}

echo "==> Fetching ${IMAGE_REPO}:${IMAGE_TAG} (${ARCH}) from ${REGISTRY} without Docker..."

TOK="$(token)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Resolve the per-architecture manifest out of the multi-arch index.
curl -fsSL -H "Authorization: Bearer $TOK" \
    -H "Accept: application/vnd.oci.image.index.v1+json" \
    -H "Accept: application/vnd.docker.distribution.manifest.list.v2+json" \
    "https://${REGISTRY}/v2/${IMAGE_REPO}/manifests/${IMAGE_TAG}" -o "$TMP/index.json"

DIGEST="$(jq -r --arg a "$ARCH" \
    '.manifests[] | select(.platform.architecture==$a and .platform.os=="linux") | .digest' \
    "$TMP/index.json")"
[ -n "$DIGEST" ] && [ "$DIGEST" != "null" ] || {
    echo "ERROR: no ${ARCH}/linux manifest in ${IMAGE_REPO}:${IMAGE_TAG}"
    exit 1
}

curl -fsSL -H "Authorization: Bearer $TOK" \
    -H "Accept: application/vnd.oci.image.manifest.v1+json" \
    -H "Accept: application/vnd.docker.distribution.manifest.v2+json" \
    "https://${REGISTRY}/v2/${IMAGE_REPO}/manifests/${DIGEST}" -o "$TMP/manifest.json"

mapfile -t LAYERS < <(jq -r '.layers[].digest' "$TMP/manifest.json")
echo "    ${#LAYERS[@]} layers; extracting ${WANT[*]}"

n=0
for L in "${LAYERS[@]}"; do
    n=$((n + 1))
    blob="$TMP/layer.tgz"
    TOK="$(token)" # registry tokens expire after ~5 min; refresh per layer
    curl -fsSL -H "Authorization: Bearer $TOK" \
        "https://${REGISTRY}/v2/${IMAGE_REPO}/blobs/${L}" -o "$blob"

    present=()
    for w in "${WANT[@]}"; do
        if tar -tzf "$blob" "$w" >/dev/null 2>&1 || tar -tzf "$blob" "$w/" >/dev/null 2>&1; then
            present+=("$w")
        fi
    done
    if [ "${#present[@]}" -gt 0 ]; then
        echo "    [$n/${#LAYERS[@]}] ${present[*]}"
        tar -xzf "$blob" -C / "${present[@]}"
    fi
    rm -f "$blob"
done

# ── Validate the extracted layout ──────────────────────────────────────────────
[ -x "$EMSDK_DIR/upstream/emscripten/emcc" ] || {
    echo "ERROR: emcc missing under ${EMSDK_DIR} after extract — image layout changed?"
    exit 1
}
for d in occt netgen mfem; do
    [ -d "$DEPS_DIR/$d/lib" ] || {
        echo "ERROR: ${DEPS_DIR}/${d}/lib missing after extract"
        exit 1
    }
done

echo "$IMAGE_TAG" >"$DEPS_DIR/.kofem-deps-tag"

echo "==> WASM deps ready:"
echo "    EMSDK            = ${EMSDK_DIR}"
echo "    OCCT_WASM_ROOT   = ${DEPS_DIR}/occt"
echo "    NETGEN_WASM_ROOT = ${DEPS_DIR}/netgen"
echo "    MFEM_WASM_ROOT   = ${DEPS_DIR}/mfem"
[ -f "$DEPS_DIR/versions.txt" ] && sed 's/^/    /' "$DEPS_DIR/versions.txt"
