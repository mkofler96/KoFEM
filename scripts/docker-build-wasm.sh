#!/usr/bin/env bash
# scripts/docker-build-wasm.sh
#
# Build the KoFEM WASM module on any Docker-capable host (Mac, Linux, Windows/WSL).
# Picks the image matching the host architecture, so Apple Silicon Macs run the
# toolchain natively (linux/arm64) instead of under Rosetta 2 emulation (#176).
#
# Uses the pre-built kofem-dependencies image (same as CI), which already contains
# Emscripten, OCCT, Netgen, and MFEM compiled for WASM — no lengthy first-run build.
#
# Usage:
#   bash scripts/docker-build-wasm.sh
#
# Override the platform (e.g. to reproduce the CI image on an arm64 host):
#   KOFEM_DOCKER_PLATFORM=linux/amd64 bash scripts/docker-build-wasm.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

IMAGE="ghcr.io/mkofler96/kofem-dependencies:main"

case "$(uname -m)" in
    arm64|aarch64) NATIVE_PLATFORM="linux/arm64" ;;
    x86_64|amd64)  NATIVE_PLATFORM="linux/amd64" ;;
    *)
        echo "ERROR: Unsupported host architecture '$(uname -m)'." >&2
        exit 1
        ;;
esac
PLATFORM="${KOFEM_DOCKER_PLATFORM:-$NATIVE_PLATFORM}"

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

echo "==> Pulling ${IMAGE} (${PLATFORM})..."
if ! docker pull --platform "${PLATFORM}" "${IMAGE}"; then
    if [ "${PLATFORM}" != "linux/amd64" ]; then
        echo ""
        echo "WARNING: ${IMAGE} is not available for ${PLATFORM} yet."
        echo "         Falling back to linux/amd64 — the build will run under"
        echo "         emulation and be MUCH slower. Publish a multi-arch image"
        echo "         from KoFEM-Dependencies to fix this."
        echo ""
        PLATFORM="linux/amd64"
        docker pull --platform "${PLATFORM}" "${IMAGE}"
    else
        echo "ERROR: Failed to pull ${IMAGE} for ${PLATFORM}." >&2
        exit 1
    fi
fi
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
