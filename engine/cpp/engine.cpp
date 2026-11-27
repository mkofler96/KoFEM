// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KoFEM WASM engine — Embind entry point.
//
// Pipeline:  STEP/IGES bytes → OCCT tessellation (display) → Netgen OCC
// surface + volume mesh. The finite-element solve runs in the Rust module
// (crates/kofem-wasm), a separate WASM module the web app joins to this one.
//
// Each pipeline stage lives in its own translation unit (issue #290); this file
// only wires those functions into the JS API. Bulk data (coordinates, indices,
// results) crosses the boundary as flat typed arrays — binary, no JSON text
// (issue #166); small option/BC payloads stay JSON strings.
//
//   cad_io.cpp        — STEP/IGES import + surface-only-geometry repair (OCCT)
//   tessellate.cpp    — OCCT surface tessellation (display + meshing input)
//   geometry_cache.cpp— cross-call cache of the loaded CAD shape
//   geometry_edit.cpp — split faces / bodies with a plane, Boolean-combine
//                       bodies (both return STEP bytes)
//   mesh_netgen.cpp   — Netgen OCC surface + tetrahedral volume meshing
//   face_properties.cpp — per-face CAD properties: type, area, normal or axis
//   json_util.cpp     — manual JSON in/out helpers
//   wasm_util.cpp     — WASM memory diagnostics + typed-array returns
//
// Build:  emcmake cmake engine/  &&  cmake --build .
// (see scripts/build-wasm.sh for the full incantation)

#include <emscripten/bind.h>

#include "face_properties.h"
#include "geometry_cache.h"
#include "geometry_edit.h"
#include "mesh_netgen.h"
#include "tessellate.h"

// ── Embind registrations ──────────────────────────────────────────────────────

EMSCRIPTEN_BINDINGS(kofem) {
    emscripten::function("tessellate_step",        &tessellate_step);
    emscripten::function("generate_fem_mesh",      &generate_fem_mesh);
    emscripten::function("free_geometry_cache",    &free_geometry_cache);
    emscripten::function("split_geometry",         &split_geometry);
    emscripten::function("boolean_geometry",       &boolean_geometry);
    emscripten::function("repair_hinges",          &repair_hinges);
    emscripten::function("split_cone_tips",        &split_cone_tips);
    emscripten::function("remove_faces",           &remove_faces);
    emscripten::function("cad_face_properties",    &cad_face_properties);
}
