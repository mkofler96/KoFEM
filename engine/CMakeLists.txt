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
add_executable(kofem_wasm_emcc cpp/engine.cpp cpp/netgen_glue.cpp cpp/brepfill_stubs.cpp)

target_include_directories(kofem_wasm_emcc PRIVATE
    ${OCCT_ROOT}/include/opencascade
    ${NETGEN_ROOT}/include
    ${MFEM_ROOT}/include
)

# Netgen internal headers (netgen_glue.cpp uses netgen::Mesh / netgen::OCCGeometry).
# Install layouts vary: the kofem-dependencies image has include/{occ,meshing,include,...}
# directly, other installs nest the same tree under include/netgen/.  occ/occgeom.hpp
# does `#include <meshing.hpp>`, which lives in the umbrella dir (libsrc/include) —
# include/include resp. include/netgen/include.  Add every variant that exists.
foreach(_ng_inc
        "${NETGEN_ROOT}/include/include"
        "${NETGEN_ROOT}/include/netgen"
        "${NETGEN_ROOT}/include/netgen/include")
    if(EXISTS "${_ng_inc}")
        target_include_directories(kofem_wasm_emcc PRIVATE "${_ng_inc}")
    endif()
endforeach()

target_link_directories(kofem_wasm_emcc PRIVATE
    ${OCCT_ROOT}/lib
    ${NETGEN_ROOT}/lib
    ${MFEM_ROOT}/lib
)



# OCCT: docker-build-wasm.sh creates TKSTEP*/TKXSBase symlinks → TKDESTEP (7.8+).
# Using the classic names keeps this list compatible with both 7.6 and 7.8.
# ── Netgen OCC geometry mesher (required) ─────────────────────────────────────
# KoFEM requires Netgen built with -DUSE_OCC=ON.
# Auto-detection uses three strategies in order:
#   1. libngocc.a       — separate OCC lib (some Netgen builds)
#   2. occgeom.hpp      — OCC header installed alongside nglib.h with USE_OCC=ON
#   3. llvm-nm symbol   — Ng_OCC_Load_STEP compiled directly into libnglib.a
# Override with -DUSE_NETGEN_OCC=ON/OFF if auto-detection gives the wrong result.

set(_netgen_occ_found OFF)
set(_netgen_occ_separate_lib OFF)

# Strategy 1: separate libngocc.a
if(EXISTS "${NETGEN_ROOT}/lib/libngocc.a")
    set(_netgen_occ_found ON)
    set(_netgen_occ_separate_lib ON)
    message(STATUS "Netgen OCC [1/3]: libngocc.a found — OCC enabled (separate lib)")
else()
    message(STATUS "Netgen OCC [1/3]: libngocc.a not found at ${NETGEN_ROOT}/lib")
endif()

# Strategy 2: OCC-specific header installed by Netgen when USE_OCC=ON
foreach(_occ_hdr
        "${NETGEN_ROOT}/include/occgeom.hpp"
        "${NETGEN_ROOT}/include/netgen/occgeom.hpp"
        "${NETGEN_ROOT}/include/occ/occgeom.hpp")
    if(NOT _netgen_occ_found AND EXISTS "${_occ_hdr}")
        set(_netgen_occ_found ON)
        message(STATUS "Netgen OCC [2/3]: ${_occ_hdr} found — OCC enabled (symbols in libnglib)")
    endif()
endforeach()
if(NOT _netgen_occ_found)
    message(STATUS "Netgen OCC [2/3]: occgeom.hpp not found under ${NETGEN_ROOT}/include")
endif()

# Strategy 3: Ng_OCC_Load_STEP symbol in libnglib.a (OCC compiled into main lib)
if(NOT _netgen_occ_found AND EXISTS "${NETGEN_ROOT}/lib/libnglib.a")
    find_program(_llvm_nm NAMES llvm-nm)
    if(_llvm_nm)
        execute_process(
            COMMAND ${_llvm_nm} --defined-only "${NETGEN_ROOT}/lib/libnglib.a"
            OUTPUT_VARIABLE _nm_out
            ERROR_QUIET
            OUTPUT_STRIP_TRAILING_WHITESPACE
        )
        if(_nm_out MATCHES "Ng_OCC_Load_STEP")
            set(_netgen_occ_found ON)
            message(STATUS "Netgen OCC [3/3]: Ng_OCC_Load_STEP symbol found in libnglib.a — OCC enabled")
        else()
            message(STATUS "Netgen OCC [3/3]: Ng_OCC_Load_STEP NOT found in libnglib.a")
        endif()
    else()
        message(STATUS "Netgen OCC [3/3]: llvm-nm not found, skipping symbol check")
    endif()
else()
    if(NOT _netgen_occ_found)
        message(STATUS "Netgen OCC [3/3]: libnglib.a not found at ${NETGEN_ROOT}/lib")
    endif()
endif()

option(USE_NETGEN_OCC "Enable Netgen OCC geometry meshing (requires Netgen with USE_OCC=ON)" ${_netgen_occ_found})

if(NOT USE_NETGEN_OCC)
    message(FATAL_ERROR
        "Netgen OCC support is required but was not detected in:\n"
        "  ${NETGEN_ROOT}\n"
        "Three checks failed:\n"
        "  1. ${NETGEN_ROOT}/lib/libngocc.a\n"
        "  2. occgeom.hpp under ${NETGEN_ROOT}/include\n"
        "  3. Ng_OCC_Load_STEP symbol in libnglib.a\n"
        "Rebuild Netgen with -DUSE_OCC=ON, or pass -DUSE_NETGEN_OCC=ON to force\n"
        "(the kofem-dependencies Docker image builds Netgen with USE_OCC=ON).")
endif()

target_link_libraries(kofem_wasm_emcc PRIVATE
    TKernel
    TKMath
    TKG2d
    TKG3d
    TKGeomBase
    TKBRep
    TKGeomAlgo
    TKTopAlgo
    TKMesh
    TKShHealing

    TKXSBase

    TKSTEP
    TKSTEP209
    TKSTEPAttr
    TKSTEPBase

    # XCAF/CAF/CDF libraries required by TKDESTEP (OCCT 7.8+).
    # TKCDF    → CDM_Document/CDM_Application (CDF framework)
    # TKLCAF   → TDF_Label, TDocStd (Labeled Application Framework)
    # TKCAF    → TNaming_Builder/Tool/NamedShape, TDataXtd (used by XCAFDoc_ShapeTool)
    # TKXCAF   → XCAFDoc_* (Extended CAF, DataExchange module)
    # The following are transitively required because TKDESTEP (symlinked as TKSTEP)
    # pulls in TKXCAF, which bundles XCAFPrs (visualization) alongside XCAFDoc.
    # That cascades through the entire OCCT vis stack even though the engine
    # never uses any AIS/rendering code.
    #
    # TKCDF    → CDM_Document/CDM_Application
    # TKLCAF   → TDF_Label, TDocStd
    # TKCAF    → TNaming_*, TDataXtd_*
    # TKXCAF   → XCAFDoc_*, XCAFPrs_*
    # TKVCAF   → TPrsStd_Driver/DriverTable (visual OCAF, initialised by XCAFApp)
    # TKService → Graphic3d_* (XCAFPrs_Texture, XCAFDoc_VisMaterial)
    # TKV3d    → AIS_*, SelectMgr_*, Prs3d_* (XCAFPrs_AISObject)
    # TKHLR    → HLRBRep_*/HLRAlgo_* (StdPrs_HLR* in TKV3d)
    # TKDE     → DataExchange base framework (OCCT 7.8+)
    # TKDEIGES → IGESControl_Writer (Netgen occgeom.cpp; replaces TKIGES in 7.8)
    # TKDESTL  → StlAPI_Writer     (Netgen occgeom.cpp; replaces TKSTL  in 7.8)
    # TKPrim   → BRepPrimAPI_MakeRevol/MakePrism, BRepSweep_* (IGESToBRep_TopoSurface)
    # TKFillet → BRepFill::Face/Shell (in TKFillet in this OCCT 7.8 build, not TKOffset)
    # TKOffset → BRepOffset_* (transitively needed by TKFillet)
    TKCDF
    TKLCAF
    TKCAF
    TKXCAF
    TKVCAF
    TKService
    TKV3d
    TKHLR
    TKDE
    TKDEIGES
    TKDESTL
    TKPrim
    TKFillet
    TKOffset

    nglib
    ngcore
    mfem
)

# OCCGEOMETRY gates the OCC parts of Netgen's internal headers (occgeom.hpp).
target_compile_definitions(kofem_wasm_emcc PRIVATE KOFEM_NETGEN_OCC=1 OCCGEOMETRY=1)
if(_netgen_occ_separate_lib)
    message(STATUS "Netgen OCC: linking ngocc as a separate library")
    target_link_libraries(kofem_wasm_emcc PRIVATE ngocc)
else()
    message(STATUS "Netgen OCC: OCC symbols are in libnglib — no separate ngocc needed")
endif()

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
    # Export getExceptionMessage so the JS worker can decode a thrown C++
    # exception (surfaced as a raw heap pointer under -fexceptions) into its
    # what() text instead of showing an opaque number like "Error: 12190840".
    -sEXPORT_EXCEPTION_HANDLING_HELPERS=1
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sENVIRONMENT=web,worker
    -sINITIAL_MEMORY=134217728      # 128 MB starting heap
    -sALLOW_MEMORY_GROWTH=1
    -sMAXIMUM_MEMORY=2147483648     # 2 GB cap
    -sSTACK_SIZE=8388608            # 8 MB stack for MFEM recursion
    -sUSE_ZLIB=1
)

# emcc adds .wasm automatically; only set the JS extension here
set_target_properties(kofem_wasm_emcc PROPERTIES SUFFIX ".js")
