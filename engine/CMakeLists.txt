cmake_minimum_required(VERSION 3.20)
project(kofem-wasm CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT EMSCRIPTEN)
    message(FATAL_ERROR
        "This project must be configured through emcmake:\n"
        "  emcmake cmake <source_dir> -B <build_dir> -G Ninja")
endif()

# ── C++ library roots (set by build-wasm.sh / docker-build-wasm.sh) ──────────
set(OCCT_ROOT    "$ENV{OCCT_WASM_ROOT}")
set(NETGEN_ROOT  "$ENV{NETGEN_WASM_ROOT}")
set(MFEM_ROOT    "$ENV{MFEM_WASM_ROOT}")

foreach(V OCCT_ROOT NETGEN_ROOT MFEM_ROOT)
    if(NOT ${V})
        message(FATAL_ERROR "${V} environment variable is not set.\n"
            "Export OCCT_WASM_ROOT, NETGEN_WASM_ROOT, MFEM_WASM_ROOT before running emcmake.")
    endif()
endforeach()

# ── Engine target ─────────────────────────────────────────────────────────────
add_executable(kofem_wasm_emcc cpp/engine.cpp)

target_include_directories(kofem_wasm_emcc PRIVATE
    ${OCCT_ROOT}/include/opencascade
    ${NETGEN_ROOT}/include
    ${MFEM_ROOT}/include
)

target_link_directories(kofem_wasm_emcc PRIVATE
    ${OCCT_ROOT}/lib
    ${NETGEN_ROOT}/lib
    ${MFEM_ROOT}/lib
)

# OCCT: docker-build-wasm.sh creates TKSTEP*/TKXSBase symlinks → TKDESTEP (7.8+).
# Using the classic names keeps this list compatible with both 7.6 and 7.8.
target_link_libraries(kofem_wasm_emcc PRIVATE
    TKernel TKMath TKG2d TKG3d TKGeomBase TKBRep
    TKGeomAlgo TKTopAlgo TKMesh TKShHealing
    TKSTEP TKSTEP209 TKSTEPAttr TKSTEPBase
    nglib
    mfem
)

target_compile_options(kofem_wasm_emcc PRIVATE
    -O2
    -fPIC
    -fexceptions
)

# Embind (--bind) + modularised ES6 output + exception support
target_link_options(kofem_wasm_emcc PRIVATE
    --bind
    -fexceptions
    -sDISABLE_EXCEPTION_CATCHING=0
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sENVIRONMENT=web,worker
    -sINITIAL_MEMORY=134217728      # 128 MB starting heap
    -sALLOW_MEMORY_GROWTH=1
    -sMAXIMUM_MEMORY=2147483648     # 2 GB cap
    -sSTACK_SIZE=8388608            # 8 MB stack for MFEM recursion
)

# emcc adds .wasm automatically; only set the JS extension here
set_target_properties(kofem_wasm_emcc PROPERTIES SUFFIX ".js")
