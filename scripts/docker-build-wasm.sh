#!/usr/bin/env bash
# scripts/docker-build-wasm.sh
#
# Build the KoFEM WASM module on any Docker-capable host (Mac, Linux, Windows/WSL).
# Works on Apple Silicon Macs — the container runs linux/amd64 via Rosetta 2.
#
# Uses the pre-built kofem-dependencies image (same as CI), which already contains
# Emscripten, OCCT, Netgen, and MFEM compiled for WASM — no lengthy first-run build.
#
# Usage:
#   bash scripts/docker-build-wasm.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

IMAGE="ghcr.io/mkofler96/kofem-dependencies:main"
PLATFORM="linux/amd64"

echo "╔══════════════════════════════════════════════════════╗"
echo "║       KoFEM WASM Docker Build                        ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "  Repo  : ${REPO_ROOT}"
echo "  Image : ${IMAGE}"
echo ""

# ── Pre-flight checks ────────────────────────────────────────────────────────

if ! command -v docker &>/dev/null; then
    echo "ERROR: docker not found."
    echo "  Install Docker Desktop from https://www.docker.com/products/docker-desktop"
    exit 1
fi

if ! docker info &>/dev/null; then
    echo "ERROR: Docker daemon is not running. Start Docker Desktop and try again."
    exit 1
fi

# ── Pull the latest image ─────────────────────────────────────────────────────

echo "==> Pulling ${IMAGE}..."
docker pull --platform "${PLATFORM}" "${IMAGE}"
echo ""

# ── Run the build container ───────────────────────────────────────────────────

echo "==> Launching build container..."
echo ""

docker run --rm \
    --platform "${PLATFORM}" \
    -v "${REPO_ROOT}:/repo" \
    -w /repo \
    "${IMAGE}" \
    bash -c "
        rm -f target/wasm-build/CMakeCache.txt
        rm -rf target/wasm-build/CMakeFiles
        bash scripts/build-wasm.sh
    "

echo ""
echo "Build complete."
echo "  ${REPO_ROOT}/web/src/wasm/pkg/kofem_wasm_emcc.js"
echo "  ${REPO_ROOT}/web/src/wasm/pkg/kofem_wasm.wasm"
