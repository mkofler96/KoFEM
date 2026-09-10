// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Volume-mesh ingestion shared by the FEM pipeline stages: copy the flat typed
// arrays of a JS mesh object onto the WASM heap (MeshArrays) and build the
// in-memory MFEM mesh from them (build_mfem_mesh). Factored out of
// solve_mfem.cpp (KOF-228) so the linear-elastic solve and the SIMP
// topology-optimization path share one mesh builder instead of duplicating it;
// the optimize_topology entry point (KOF-231) is the second caller.
#pragma once

#include <emscripten/val.h>

#include <mfem.hpp>

#include <vector>

namespace kofem::fem {

// Flat volume-mesh arrays copied out of the JS mesh object: xyz per vertex,
// four vertex indices per tet, eight per hex, one material attribute per
// element (tets first, then hexs; empty = every element is material 1).
struct MeshArrays {
    std::vector<double> vertices;
    std::vector<int> tets;
    std::vector<int> hexs;
    std::vector<int> attrs;
};

// The mesh arrives as flat typed arrays ({vertices: Float64Array, tetrahedra:
// Int32Array, hexahedra?: Int32Array, attributes?: Int32Array}) and is
// bulk-copied onto the WASM heap (issue #166) — no JSON text and no per-element
// JS↔WASM crossings. Throws with an information-rich message when a length is
// not divisible by the element stride or an attribute index is out of range.
MeshArrays parse_mesh(const emscripten::val& mesh_js);

// Build the MFEM mesh programmatically (no iostream file I/O — see the note in
// the implementation for why the file-based path traps under Emscripten).
// Element attribute = 1-based material index; orientation is fixed so tets keep
// a positive Jacobian.
mfem::Mesh build_mfem_mesh(const MeshArrays& m);

}  // namespace kofem::fem
