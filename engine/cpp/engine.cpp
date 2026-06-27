// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KoFEM WASM engine — Embind entry point.
//
// Pipeline:  STEP/IGES bytes → OCCT tessellation (display) → Netgen OCC surface+volume mesh → MFEM FEM solve
//
// Each pipeline stage lives in its own translation unit (issue #290); this file
// only wires those functions into the JS API. Every function takes / returns
// JSON strings (or typed arrays) so the interface is identical to the previous
// wasm-bindgen build — solver.worker.ts needs no changes.
//
//   cad_io.cpp        — STEP/IGES import + surface-only-geometry repair (OCCT)
//   tessellate.cpp    — OCCT surface tessellation (display + meshing input)
//   geometry_cache.cpp— cross-call cache of the loaded CAD shape
//   mesh_netgen.cpp   — Netgen OCC surface + tetrahedral volume meshing
//   solve_mfem.cpp    — MFEM linear-elastic assembly, CG solve, post-processing
//   json_util.cpp     — manual JSON in/out helpers
//   wasm_util.cpp     — WASM memory diagnostics + typed-array returns
//
// Build:  emcmake cmake engine/  &&  cmake --build .
// (see scripts/build-wasm.sh for the full incantation)

#include <emscripten/bind.h>

#include "geometry_cache.h"
#include "mesh_netgen.h"
#include "solve_mfem.h"
#include "tessellate.h"

// ── Embind registrations ──────────────────────────────────────────────────────

EMSCRIPTEN_BINDINGS(kofem) {
    emscripten::function("tessellate_step",        &tessellate_step);
    emscripten::function("tessellate_for_meshing", &tessellate_for_meshing);
    emscripten::function("generate_volume_mesh",   &generate_volume_mesh);
    emscripten::function("generate_fem_mesh",      &generate_fem_mesh);
    emscripten::function("free_geometry_cache",    &free_geometry_cache);
    emscripten::function("solve_linear_elastic",   &solve_linear_elastic);
}
