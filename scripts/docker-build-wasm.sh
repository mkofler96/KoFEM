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
BINARYEN_VERSION="124"       # must be >= 122 for --enable-bulk-memory-opt
OCCT_VERSION="7.8.0"
NETGEN_TAG="v6.2.2401"
MFEM_TAG="v4.7"

IMAGE_TAG="kofem-wasm-builder:emsdk-${EMSDK_VERSION}-wopt${BINARYEN_VERSION}"
PLATFORM="linux/amd64"

echo "╔══════════════════════════════════════════════════════╗"
echo "║       KoFEM WASM Docker Build                        ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "  Repo     : ${REPO_ROOT}"
echo "  Cache    : ${CACHE_DIR}"
echo "  Image    : ${IMAGE_TAG}"
echo "  OCCT     : ${OCCT_VERSION}"
echo "  Netgen   : ${NETGEN_TAG}"
echo "  MFEM     : ${MFEM_TAG}"
echo "  wasm-opt : binaryen-${BINARYEN_VERSION}"
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

# Replace bundled wasm-opt: emsdk ${EMSDK_VERSION}'s version doesn't support
# --enable-bulk-memory-opt, which emcc uses when linking with newer toolchains.
RUN curl -fsSL https://github.com/WebAssembly/binaryen/releases/download/version_${BINARYEN_VERSION}/binaryen-version_${BINARYEN_VERSION}-x86_64-linux.tar.gz \\
    | tar -xzf - --strip-components=1 -C /emsdk/upstream binaryen-version_${BINARYEN_VERSION}/bin/wasm-opt

WORKDIR /build
DOCKERFILE
    echo "    Image built."
fi

# ── Write the inner build script ──────────────────────────────────────────────

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
# Separate -pic dirs: Netgen and MFEM don't add -fPIC in their own build
# systems; the SIDE_MODULE linker rejects non-PIC objects.  Distinct cache
# dirs force fresh PIC builds when needed.
NETGEN_ROOT="${CACHE}/netgen-pic"
MFEM_ROOT="${CACHE}/mfem-pic"
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
    # ExpToCasExe is a host-side tool that Emscripten can't fully link; the
    # install fails at the very last step but all .a files are already written.
    ninja install 2>&1 || true
    if [ ! -f "${OCCT_ROOT}/lib/libTKernel.a" ]; then
        echo "ERROR: OCCT install failed — libTKernel.a not found"
        exit 1
    fi
    echo "  OCCT done."
else
    echo "==> OCCT: using cached build."
fi

# ── OCCT library name compatibility (runs every time) ─────────────────────────
# OCCT 7.7+ consolidated TKSTEP* into TKDESTEP.  Create symlinks so the
# CMakeLists.txt can use the classic names without version checks.
echo "==> Patching OCCT DataExchange library names..."
cd "${OCCT_ROOT}/lib"
echo "  OCCT libs: $(ls libTKDE*.a libTKSTEP*.a libTKXSBase.a 2>/dev/null | xargs -I{} basename {} | tr '\n' ' ')"
for OLD in TKSTEP TKSTEP209 TKSTEPAttr TKSTEPBase; do
    if [ ! -f "lib${OLD}.a" ]; then
        if [ -f "libTKDESTEP.a" ]; then
            ln -sf libTKDESTEP.a "lib${OLD}.a"
            echo "  lib${OLD}.a -> libTKDESTEP.a"
        else
            echo "  WARNING: lib${OLD}.a not found and libTKDESTEP.a not found either"
        fi
    fi
done
cd /

# ── Build Netgen ──────────────────────────────────────────────────────────────

if [ ! -f "${NETGEN_ROOT}/lib/libnglib.a" ]; then
    echo ""
    echo "==> Building Netgen ${NETGEN_TAG} — ~10-20 minutes"

    echo "  Building Emscripten zlib port..."
    embuilder --pic build zlib
    EM_SYSROOT="${EMSDK}/upstream/emscripten/cache/sysroot"
    ZLIB_LIB="${EM_SYSROOT}/lib/wasm32-emscripten/pic/libz.a"
    ZLIB_INC="${EM_SYSROOT}/include"

    fetch_and_extract \
        "netgen-${NETGEN_TAG}" \
        "https://github.com/NGSolve/netgen/archive/refs/tags/${NETGEN_TAG}.tar.gz" \
        "${SOURCES}/netgen-${NETGEN_TAG}"

    BUILD_DIR="${SOURCES}/build-netgen"
    rm -rf "${BUILD_DIR}" && mkdir -p "${BUILD_DIR}"
    cd "${BUILD_DIR}"

    emcmake cmake "${SOURCES}/netgen-${NETGEN_TAG}" \
        -G Ninja \
        -DCMAKE_INSTALL_PREFIX="${NETGEN_ROOT}" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_CXX_FLAGS="-fPIC" \
        -DCMAKE_C_FLAGS="-fPIC" \
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

    # isockstream.cpp calls bind() unqualified; emcc's libc++ resolves it as
    # std::bind via ADL.  Qualify to avoid the collision.
    sed -i 's/if (bind(sfd,/if (::bind(sfd,/g' \
        "${SOURCES}/mfem-${MFEM_TAG}/general/isockstream.cpp"

    BUILD_DIR="${SOURCES}/build-mfem"
    rm -rf "${BUILD_DIR}" && mkdir -p "${BUILD_DIR}"
    cd "${BUILD_DIR}"

    emcmake cmake "${SOURCES}/mfem-${MFEM_TAG}" \
        -G Ninja \
        -DCMAKE_INSTALL_PREFIX="${MFEM_ROOT}" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_CXX_FLAGS="-fPIC" \
        -DCMAKE_C_FLAGS="-fPIC" \
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

# ── Build KoFEM WASM engine ───────────────────────────────────────────────────

echo ""
echo "==> Building KoFEM WASM engine..."

export OCCT_WASM_ROOT="${OCCT_ROOT}"
export NETGEN_WASM_ROOT="${NETGEN_ROOT}"
export MFEM_WASM_ROOT="${MFEM_ROOT}"

cd /repo
bash scripts/build-wasm.sh

echo ""
echo "==> Done — output: web/src/wasm/pkg/"
INNER_SCRIPT

# ── Run the build container ───────────────────────────────────────────────────

echo "==> Launching build container..."
echo "    C++ libs cache : ${CACHE_DIR}"
echo "    (First run takes several hours; subsequent runs ~5-10 min.)"
echo ""

docker run --rm \
    --platform "${PLATFORM}" \
    -e "OCCT_VERSION=${OCCT_VERSION}" \
    -e "NETGEN_TAG=${NETGEN_TAG}" \
    -e "MFEM_TAG=${MFEM_TAG}" \
    -e "FORCE_REBUILD=${FORCE_REBUILD}" \
    -v "${REPO_ROOT}:/repo" \
    -v "${CACHE_DIR}:/cache" \
    "${IMAGE_TAG}" \
    bash /repo/.docker-wasm-inner.sh

echo ""
echo "Build complete."
echo "  ${REPO_ROOT}/web/src/wasm/pkg/kofem_wasm_emcc.js"
echo "  ${REPO_ROOT}/web/src/wasm/pkg/kofem_wasm.wasm"
