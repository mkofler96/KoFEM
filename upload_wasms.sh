# On your machine with Emscripten installed
source /path/to/emsdk/emsdk_env.sh

# Build OCCT, Netgen, MFEM for Emscripten (see scripts/build-wasm.sh comments for cmake flags)
# Then:
export OCCT_WASM_ROOT=/opt/wasm/occt
export NETGEN_WASM_ROOT=/opt/wasm/netgen
export MFEM_WASM_ROOT=/opt/wasm/mfem

./scripts/package-wasm-libs.sh v1   # uploads wasm-libs-v1 GitHub release