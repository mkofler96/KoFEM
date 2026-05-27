#!/usr/bin/env bash
# scripts/docker-build-wasm.sh
#
# Build the KoFEM WASM module on any Docker-capable host (Mac, Linux, Windows/WSL).
# Works on Apple Silicon Macs — the container runs linux/amd64 via Rosetta 2.
#
# First run: ~2-4 hours (downloads and builds OCCT, Netgen, MFEM with Emscripten).
# Subsequent runs: ~5-10 minutes (C++ libs are cached in ~/.cache/kofem-wasm-libs).
#
# Usage:
#   bash scripts/docker-build-wasm.sh
#
# Override the cache directory:
#   KFW_CACHE_DIR=/my/fast/disk bash scripts/docker-build-wasm.sh
#
# Force a clean rebuild of the C++ libs (e.g. after changing versions):
#   KFW_FORCE_REBUILD=1 bash scripts/docker-build-wasm.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE_DIR="${KFW_CACHE_DIR:-${HOME}/.cache/kofem-wasm-libs}"
FORCE_REBUILD="${KFW_FORCE_REBUILD:-0}"

EMSDK_VERSION="3.1.64"
OCCT_VERSION="7.8.0"
NETGEN_TAG="v6.2.2401"
MFEM_TAG="v4.7"

IMAGE_TAG="kofem-wasm-builder:emsdk-${EMSDK_VERSION}"
PLATFORM="linux/amd64"

# Named Docker volumes so that Cargo's registry and build artifacts survive
# across container runs without being exposed on the slow macOS bind-mount layer.
CARGO_TARGET_VOL="kofem-wasm-cargo-target"
CARGO_REGISTRY_VOL="kofem-wasm-cargo-registry"

echo "╔══════════════════════════════════════════════════════╗"
echo "║       KoFEM WASM Docker Build                        ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "  Repo   : ${REPO_ROOT}"
echo "  Cache  : ${CACHE_DIR}"
echo "  Image  : ${IMAGE_TAG}"
echo "  OCCT   : ${OCCT_VERSION}"
echo "  Netgen : ${NETGEN_TAG}"
echo "  MFEM   : ${MFEM_TAG}"
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

mkdir -p "${CACHE_DIR}"

# ── Build the Docker image (once) ────────────────────────────────────────────

if ! docker image inspect "${IMAGE_TAG}" &>/dev/null; then
    echo "==> Building Docker image ${IMAGE_TAG} (first time only, ~5 minutes)..."
    docker build --platform "${PLATFORM}" -t "${IMAGE_TAG}" - <<DOCKERFILE
FROM emscripten/emsdk:${EMSDK_VERSION}

RUN apt-get update && apt-get install -y --no-install-recommends \\
        cmake ninja-build curl git python3 xz-utils \\
    && rm -rf /var/lib/apt/lists/*

# Install Rust and the Emscripten WASM target
ENV RUSTUP_HOME=/usr/local/rustup \\
    CARGO_HOME=/usr/local/cargo \\
    PATH=/usr/local/cargo/bin:\$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \\
    | sh -s -- -y --default-toolchain stable --no-modify-path \\
 && rustup target add wasm32-unknown-emscripten

WORKDIR /build
DOCKERFILE
    echo "    Image built."
fi

# ── Write the inner build script to a temp file ───────────────────────────────
# Using a temp file avoids heredoc quoting issues with $() and double-quotes.

# Write the inner script inside the repo root, which Docker already mounts.
# A /tmp path on macOS can't be reliably bind-mounted as a file by Docker Desktop.
INNER="${REPO_ROOT}/.docker-wasm-inner.sh"
trap 'rm -f "$INNER"' EXIT

cat > "$INNER" << 'INNER_SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

OCCT_VERSION="${OCCT_VERSION}"
NETGEN_TAG="${NETGEN_TAG}"
MFEM_TAG="${MFEM_TAG}"
FORCE_REBUILD="${FORCE_REBUILD:-0}"

CACHE=/cache
SOURCES="${CACHE}/sources"
OCCT_ROOT="${CACHE}/occt"
NETGEN_ROOT="${CACHE}/netgen"
MFEM_ROOT="${CACHE}/mfem"
JOBS=$(nproc)

mkdir -p "${SOURCES}"

if [ "${FORCE_REBUILD}" = "1" ]; then
    echo "==> KFW_FORCE_REBUILD=1: removing cached C++ lib installs."
    rm -rf "${OCCT_ROOT}" "${NETGEN_ROOT}" "${MFEM_ROOT}"
fi

# ── Source download helpers ──────────────────────────────────────────────────

fetch_and_extract() {
    local name="$1" url="$2" dest="$3"
    local tgz="${SOURCES}/${name}.tar.gz"
    if [ ! -f "${tgz}" ]; then
        echo "  Downloading ${name}..."
        curl -fsSL "${url}" -o "${tgz}"
    fi
    if [ ! -d "${dest}" ]; then
        echo "  Extracting ${name}..."
        mkdir -p "${dest}"
        tar -xzf "${tgz}" -C "${dest}" --strip-components=1
    fi
}

# ── Build OCCT ───────────────────────────────────────────────────────────────

if [ ! -f "${OCCT_ROOT}/lib/libTKernel.a" ]; then
    echo ""
    echo "==> Building OCCT ${OCCT_VERSION} — ~60-90 minutes on first run"
    OCCT_TAG="V$(echo "${OCCT_VERSION}" | tr '.' '_')"
    fetch_and_extract \
        "occt-${OCCT_VERSION}" \
        "https://github.com/Open-Cascade-SAS/OCCT/archive/refs/tags/${OCCT_TAG}.tar.gz" \
        "${SOURCES}/occt-${OCCT_VERSION}"

    BUILD_DIR="${SOURCES}/build-occt"
    rm -rf "${BUILD_DIR}" && mkdir -p "${BUILD_DIR}"
    cd "${BUILD_DIR}"

    emcmake cmake "${SOURCES}/occt-${OCCT_VERSION}" \
        -G Ninja \
        -DCMAKE_INSTALL_PREFIX="${OCCT_ROOT}" \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_MODULE_Draw=OFF \
        -DBUILD_MODULE_Visualization=OFF \
        -DBUILD_MODULE_ApplicationFramework=OFF \
        -DBUILD_MODULE_FoundationClasses=ON \
        -DBUILD_MODULE_ModelingData=ON \
        -DBUILD_MODULE_ModelingAlgorithms=ON \
        -DBUILD_MODULE_DataExchange=ON \
        -DBUILD_MODULE_Mesh=ON \
        -DUSE_FREETYPE=OFF \
        -DUSE_OPENGL=OFF \
        -DUSE_TBB=OFF \
        -DUSE_FREEIMAGE=OFF \
        -DUSE_FFMPEG=OFF \
        -DUSE_OPENVR=OFF \
        -DBUILD_SHARED_LIBS=OFF

    ninja -j"${JOBS}"
    # Install step: ExpToCasExe is a host-side Express-schema dev tool that
    # Emscripten can't fully link.  Its .wasm is never produced, causing the
    # install to fail at the very last step.  All library .a files are already
    # written to the prefix at that point, so we allow the error and verify.
    ninja install 2>&1 || true
    if [ ! -f "${OCCT_ROOT}/lib/libTKernel.a" ]; then
        echo "ERROR: OCCT install failed — libTKernel.a not found"
        exit 1
    fi
    echo "  OCCT done."
else
    echo "==> OCCT: using cached build."
fi

# ── Build Netgen ─────────────────────────────────────────────────────────────

if [ ! -f "${NETGEN_ROOT}/lib/libnglib.a" ]; then
    echo ""
    echo "==> Building Netgen ${NETGEN_TAG} — ~10-20 minutes"

    # Netgen requires zlib.  Build Emscripten's bundled zlib port and pass the
    # exact library path to cmake — FindZLIB won't search the pic/ subdir on
    # its own even though the header is found via the EM sysroot.
    echo "  Building Emscripten zlib port..."
    embuilder --pic build zlib
    EM_SYSROOT="$(/emsdk/upstream/emscripten/emcc --print-sysroot)"
    ZLIB_LIB="${EM_SYSROOT}/lib/wasm32-emscripten/pic/libz.a"
    ZLIB_INC="${EM_SYSROOT}/include"

    fetch_and_extract \
        "netgen-${NETGEN_TAG}" \
        "https://github.com/NGSolve/netgen/archive/refs/tags/${NETGEN_TAG}.tar.gz" \
        "${SOURCES}/netgen-${NETGEN_TAG}"

    # Netgen's top-level CMakeLists.txt is a superbuild wrapper; passing
    # USE_SUPERBUILD=OFF builds Netgen directly from the source tree.
    BUILD_DIR="${SOURCES}/build-netgen"
    rm -rf "${BUILD_DIR}" && mkdir -p "${BUILD_DIR}"
    cd "${BUILD_DIR}"

    emcmake cmake "${SOURCES}/netgen-${NETGEN_TAG}" \
        -G Ninja \
        -DCMAKE_INSTALL_PREFIX="${NETGEN_ROOT}" \
        -DCMAKE_BUILD_TYPE=Release \
        -DUSE_SUPERBUILD=OFF \
        -DUSE_GUI=OFF \
        -DUSE_PYTHON=OFF \
        -DUSE_MPI=OFF \
        -DUSE_OCC=OFF \
        -DUSE_NUMA=OFF \
        -DUSE_NATIVE_ARCH=OFF \
        -DBUILD_SHARED_LIBS=OFF \
        -DBUILD_TESTS=OFF \
        -DENABLE_UNIT_TESTS=OFF \
        -DZLIB_LIBRARY="${ZLIB_LIB}" \
        -DZLIB_INCLUDE_DIR="${ZLIB_INC}"

    ninja -j"${JOBS}" install
    echo "  Netgen done."
else
    echo "==> Netgen: using cached build."
fi

# ── Build MFEM ───────────────────────────────────────────────────────────────

if [ ! -f "${MFEM_ROOT}/lib/libmfem.a" ]; then
    echo ""
    echo "==> Building MFEM ${MFEM_TAG} — ~10-20 minutes"
    fetch_and_extract \
        "mfem-${MFEM_TAG}" \
        "https://github.com/mfem/mfem/archive/refs/tags/${MFEM_TAG}.tar.gz" \
        "${SOURCES}/mfem-${MFEM_TAG}"

    BUILD_DIR="${SOURCES}/build-mfem"
    rm -rf "${BUILD_DIR}" && mkdir -p "${BUILD_DIR}"
    cd "${BUILD_DIR}"

    emcmake cmake "${SOURCES}/mfem-${MFEM_TAG}" \
        -G Ninja \
        -DCMAKE_INSTALL_PREFIX="${MFEM_ROOT}" \
        -DCMAKE_BUILD_TYPE=Release \
        -DMFEM_USE_MPI=OFF \
        -DMFEM_USE_OPENMP=OFF \
        -DMFEM_USE_LAPACK=OFF \
        -DMFEM_USE_METIS=OFF \
        -DMFEM_USE_SUPERLU=OFF \
        -DMFEM_USE_SUITESPARSE=OFF \
        -DBUILD_SHARED_LIBS=OFF

    ninja -j"${JOBS}" install
    echo "  MFEM done."
else
    echo "==> MFEM: using cached build."
fi

# ── Build KoFEM WASM ─────────────────────────────────────────────────────────

echo ""
echo "==> Building KoFEM WASM module..."

export OCCT_WASM_ROOT="${OCCT_ROOT}"
export NETGEN_WASM_ROOT="${NETGEN_ROOT}"
export MFEM_WASM_ROOT="${MFEM_ROOT}"

cd /repo
bash scripts/build-wasm.sh

echo ""
echo "==> Done — output: web/src/wasm/pkg/"
INNER_SCRIPT

# ── Run the build container ───────────────────────────────────────────────────
# Version variables are passed via -e so the inner script reads them from env.
# (No sed needed — avoids the macOS vs GNU sed -i incompatibility.)

echo "==> Launching build container..."
echo "    C++ libs cache : ${CACHE_DIR}"
echo "    (First run will take several hours; grab a coffee.)"
echo ""

docker run --rm \
    --platform "${PLATFORM}" \
    -e "OCCT_VERSION=${OCCT_VERSION}" \
    -e "NETGEN_TAG=${NETGEN_TAG}" \
    -e "MFEM_TAG=${MFEM_TAG}" \
    -e "FORCE_REBUILD=${FORCE_REBUILD}" \
    -v "${REPO_ROOT}:/repo" \
    -v "${CACHE_DIR}:/cache" \
    -v "${CARGO_TARGET_VOL}:/repo/target" \
    -v "${CARGO_REGISTRY_VOL}:/usr/local/cargo/registry" \
    "${IMAGE_TAG}" \
    bash /repo/.docker-wasm-inner.sh

echo ""
echo "Build complete."
echo "  ${REPO_ROOT}/web/src/wasm/pkg/kofem_wasm.js"
echo "  ${REPO_ROOT}/web/src/wasm/pkg/kofem_wasm.wasm"
