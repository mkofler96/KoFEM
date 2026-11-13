# SPDX-FileCopyrightText: 2026 Michael Kofler
# SPDX-License-Identifier: AGPL-3.0-or-later

# The numerical tests of the C++ engine units that build on their own: no
# OCCT, no Netgen, no Embind. One program per <name>.cpp in this folder; each
# prints its checks and exits non-zero when one fails. Run them with
# `just test-cpp`, or directly:
#
#   cd engine/tests
#   cmake --preset native && cmake --build --preset native && ctest --preset native
#
# Two builds (CMakePresets.json):
#   native  a host compiler. The units without MFEM: a fast loop for the
#           element math, independent of the WebAssembly toolchain.
#   wasm    Emscripten. The units that link MFEM, whose prebuilt library is a
#           WebAssembly archive ($MFEM_WASM_ROOT, scripts/fetch-wasm-deps.sh).
#           Emscripten's toolchain file registers node as the emulator, so
#           ctest runs the .js outputs itself.
#
# A new test is one kofem_test() line; nothing else lists test programs.

cmake_minimum_required(VERSION 3.20)
project(kofem-engine-tests CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

enable_testing()

set(ENGINE "${CMAKE_CURRENT_SOURCE_DIR}/../cpp")

if(EMSCRIPTEN)
    set(MFEM_ROOT "$ENV{MFEM_WASM_ROOT}")
    if(NOT EXISTS "${MFEM_ROOT}/lib/libmfem.a")
        message(FATAL_ERROR
            "MFEM WebAssembly library not found at '${MFEM_ROOT}/lib/libmfem.a'.\n"
            "Set MFEM_WASM_ROOT, or fetch the toolchain: bash scripts/fetch-wasm-deps.sh")
    endif()
endif()

# The optimisation level is part of what these programs check: their
# tolerances were set against -O2, so no build type replaces it.
add_compile_options(-O2)

# kofem_test(<name> [MFEM]
#            [SOURCES <engine/cpp file>...]
#            [DEFINES <definition>...]
#            [LINK_OPTIONS <option>...])
#
# Builds engine/tests/<name>.cpp with the listed engine sources and registers
# the program with ctest. A test marked MFEM exists only in the Emscripten
# build; every other test exists only in the native build.
function(kofem_test name)
    cmake_parse_arguments(TEST "MFEM" "" "SOURCES;DEFINES;LINK_OPTIONS" ${ARGN})
    if(TEST_UNPARSED_ARGUMENTS)
        message(FATAL_ERROR "kofem_test(${name}): unknown arguments ${TEST_UNPARSED_ARGUMENTS}")
    endif()
    if(TEST_MFEM AND NOT EMSCRIPTEN)
        return()
    endif()
    if(EMSCRIPTEN AND NOT TEST_MFEM)
        return()
    endif()

    set(sources "${CMAKE_CURRENT_SOURCE_DIR}/${name}.cpp")
    foreach(source IN LISTS TEST_SOURCES)
        list(APPEND sources "${ENGINE}/${source}")
    endforeach()

    add_executable(${name} ${sources})
    target_include_directories(${name} PRIVATE "${ENGINE}")
    target_compile_definitions(${name} PRIVATE ${TEST_DEFINES})

    if(TEST_MFEM)
        target_include_directories(${name} PRIVATE "${MFEM_ROOT}/include")
        target_compile_options(${name} PRIVATE -fexceptions -sUSE_ZLIB=1)
        target_link_libraries(${name} PRIVATE "${MFEM_ROOT}/lib/libmfem.a")
        target_link_options(${name} PRIVATE
            -O2
            -fexceptions
            -sDISABLE_EXCEPTION_CATCHING=0
            -sALLOW_MEMORY_GROWTH=1
            -sUSE_ZLIB=1
            -sENVIRONMENT=node
            ${TEST_LINK_OPTIONS})
    else()
        target_compile_options(${name} PRIVATE -Wall -Wextra)
    endif()

    add_test(NAME ${name} COMMAND ${name})
    # A watchdog for a solve that never returns, not a performance target.
    set_tests_properties(${name} PROPERTIES TIMEOUT 900)
endfunction()

# The shell and coupling core, shared by several programs.
set(SHELL_CORE
    shell_core.cpp
    shell_element.cpp
    tet_element.cpp
    coupling_constraints.cpp
    sparse_cg.cpp)

# The SIMP loop on MFEM, shared by the topology-optimization programs.
set(TOPOLOGY_MFEM
    topology_simp_core.cpp
    topology_filter.cpp
    spatial_grid.cpp
    topology_mma.cpp
    topology_formulation.cpp
    topology_optimize.cpp
    topology_stress.cpp)

# 256 MB up front and the exception helpers, as the engine links them.
set(TOPOLOGY_LINK
    -sINITIAL_MEMORY=268435456
    -sEXPORT_EXCEPTION_HANDLING_HELPERS=1)

# ── Native ────────────────────────────────────────────────────────────────────
kofem_test(bc_validation)
kofem_test(shell_validation SOURCES ${SHELL_CORE})
kofem_test(cg_continuation_validation SOURCES ${SHELL_CORE})
kofem_test(topology_filter_validation SOURCES spatial_grid.cpp topology_filter.cpp)
kofem_test(topology_mma_validation SOURCES topology_mma.cpp)
kofem_test(topology_shell_validation
    SOURCES ${SHELL_CORE}
            spatial_grid.cpp
            topology_filter.cpp
            topology_mma.cpp
            topology_formulation.cpp
            topology_shell.cpp)

# ── Emscripten, with MFEM ─────────────────────────────────────────────────────
kofem_test(topology_simp_validation MFEM
    SOURCES topology_simp_core.cpp
    LINK_OPTIONS ${TOPOLOGY_LINK})
# The same program as in the native build, here with the MFEM solid path too.
kofem_test(cg_continuation_validation MFEM
    SOURCES ${SHELL_CORE} cg_mfem.cpp
    DEFINES KOFEM_TEST_MFEM)
kofem_test(topology_optimize_validation MFEM
    SOURCES ${TOPOLOGY_MFEM}
    LINK_OPTIONS ${TOPOLOGY_LINK})
# NODERAWFS: given a directory argument, the program writes its density
# fields there for inspection.
kofem_test(topology_stress_validation MFEM
    SOURCES ${TOPOLOGY_MFEM}
    LINK_OPTIONS ${TOPOLOGY_LINK} -sNODERAWFS=1)
kofem_test(topology_levelset_validation MFEM
    SOURCES ${TOPOLOGY_MFEM} topology_levelset.cpp
    LINK_OPTIONS ${TOPOLOGY_LINK})
