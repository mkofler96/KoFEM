// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Volume-mesh ingestion — see fem_mesh_io.h. Moved verbatim out of
// solve_mfem.cpp (KOF-228); the behaviour is unchanged, only the home.

#include "fem_mesh_io.h"

#include "wasm_util.h"

#include <cstdio>
#include <stdexcept>
#include <string>

using emscripten::val;

namespace kofem::fem {

namespace {
constexpr int dim = 3;
}  // namespace

MeshArrays parse_mesh(const val& mesh_js) {
    MeshArrays m;
    m.vertices = f64_vector(mesh_js["vertices"], "mesh.vertices");

    // hexahedra is optional: the Netgen pipeline produces tets only, so most
    // callers never build the array. tetrahedra is likewise absent-tolerant —
    // the "no elements" check below reports that case properly.
    val tets_js = mesh_js["tetrahedra"];
    if (!tets_js.isUndefined() && !tets_js.isNull())
        m.tets = i32_vector(tets_js, "mesh.tetrahedra");
    val hexs_js = mesh_js["hexahedra"];
    if (!hexs_js.isUndefined() && !hexs_js.isNull())
        m.hexs = i32_vector(hexs_js, "mesh.hexahedra");

    // attributes is optional: one 1-based material index per element (tets
    // first, then hexs — the order the elements are added to the MFEM mesh
    // below). Absent means the single-material case: every element keeps the
    // default attribute 1 and materials[0] applies to the whole model.
    val attrs_js = mesh_js["attributes"];
    if (!attrs_js.isUndefined() && !attrs_js.isNull())
        m.attrs = i32_vector(attrs_js, "mesh.attributes");

    if (m.vertices.size() % 3 != 0)
        throw std::runtime_error(
            "mesh.vertices length " + std::to_string(m.vertices.size()) +
            " is not divisible by 3 — expected flat xyz-interleaved coordinates");
    if (m.tets.size() % 4 != 0)
        throw std::runtime_error(
            "mesh.tetrahedra length " + std::to_string(m.tets.size()) +
            " is not divisible by 4 — expected four flat vertex indices per tet");
    if (m.hexs.size() % 8 != 0)
        throw std::runtime_error(
            "mesh.hexahedra length " + std::to_string(m.hexs.size()) +
            " is not divisible by 8 — expected eight flat vertex indices per hex");
    const size_t n_elems = m.tets.size() / 4 + m.hexs.size() / 8;
    if (!m.attrs.empty() && m.attrs.size() != n_elems)
        throw std::runtime_error(
            "mesh.attributes length " + std::to_string(m.attrs.size()) +
            " does not match the element count " + std::to_string(n_elems) +
            " — expected one material index per element (tets first, then hexs)");
    for (int a : m.attrs)
        if (a < 1)
            throw std::runtime_error(
                "mesh.attributes contains the invalid material index " +
                std::to_string(a) + " — indices are 1-based");

    printf("[mfem] mesh counts: nv=%u nt=%u nh=%u\n",
           (unsigned)(m.vertices.size() / 3), (unsigned)(m.tets.size() / 4),
           (unsigned)(m.hexs.size() / 8));
    fflush(stdout);

    if (m.tets.empty() && m.hexs.empty())
        throw std::runtime_error(
            "Mesh has no elements. Send at least one CTETRA or CHEXA element.");

    log_mem("solve: after mesh copy-in");
    return m;
}

// Build MFEM mesh programmatically to avoid C++ iostream file I/O.
//
// The file-based path (Mesh(filename, ...)) opens an ifstream and reads
// through basic_filebuf / basic_streambuf virtual dispatch.  In the WASM
// (Emscripten) build the locale/codec facet pointer inside the streambuf
// object is null, so the first virtual call through it traps with
// "Out of bounds memory access" via invoke_iiiiii.
//
// The programmatic path calls no iostream code at all: AddVertex / AddTet /
// AddHex populate in-memory arrays directly, and FinalizeTopology builds all
// connectivity (faces, boundary elements, edge table) without file I/O.
// In 3D, FinalizeTopology always builds the edge table, which is required by
// H1_FECollection for DOF numbering.
mfem::Mesh build_mfem_mesh(const MeshArrays& m) {
    unsigned nv = (unsigned)(m.vertices.size() / 3);
    unsigned nt = (unsigned)(m.tets.size() / 4);
    unsigned nh = (unsigned)(m.hexs.size() / 8);

    printf("[mfem] building mesh (%u verts, %u tets, %u hexs)\n", nv, nt, nh); fflush(stdout);
    log_mem("solve: before MFEM mesh build");
    mfem::Mesh mesh(dim, (int)nv, (int)(nt + nh), /*NBdrElem=*/0, /*spaceDim=*/dim);

    printf("[mfem] mesh shell ok\n"); fflush(stdout);
    for (unsigned i = 0; i < nv; ++i)
        mesh.AddVertex(m.vertices[3*i], m.vertices[3*i+1], m.vertices[3*i+2]);
    printf("[mfem] vertices added\n"); fflush(stdout);

    // Element attribute = 1-based material index (from mesh.attributes; 1 for
    // every element when absent). PWConstCoefficient in the assembly below maps
    // attribute k to the k-th material's Lamé constants.
    for (unsigned i = 0; i < nt; ++i)
        mesh.AddTet(m.tets[4*i], m.tets[4*i+1], m.tets[4*i+2], m.tets[4*i+3],
                    m.attrs.empty() ? 1 : m.attrs[i]);
    printf("[mfem] tets added\n"); fflush(stdout);

    for (unsigned i = 0; i < nh; ++i)
        mesh.AddHex(m.hexs[8*i], m.hexs[8*i+1], m.hexs[8*i+2], m.hexs[8*i+3],
                    m.hexs[8*i+4], m.hexs[8*i+5], m.hexs[8*i+6], m.hexs[8*i+7],
                    m.attrs.empty() ? 1 : m.attrs[nt + i]);
    printf("[mfem] hexs added\n"); fflush(stdout);

    // generate_bdr=true: boundary Triangle/Quad elements auto-generated from
    // exposed faces of volume elements (correct for a watertight Netgen mesh).
    mesh.FinalizeTopology(/*generate_bdr=*/true);
    printf("[mfem] FinalizeTopology done\n"); fflush(stdout);

    // Netgen uses the opposite tet vertex-winding convention from MFEM.
    // Without fixing orientation every tet has a negative Jacobian, making
    // the assembled stiffness matrix non-positive-definite.  CG then fails
    // at iteration 0 ("preconditioner not positive definite") and returns the
    // zero initial guess, giving physically meaningless results.
    // fix_orientation=true calls CheckElementOrientation(true) which swaps
    // two vertices per tet to correct the sign — this uses only GetVertices()
    // (int* overload, already anchored) and direct array swaps, no new virtual
    // calls.
    mesh.Finalize(/*refine=*/false, /*fix_orientation=*/true);
    printf("[mfem] Finalize done\n"); fflush(stdout);

    printf("[mfem] mesh ready: %d vertices, %d elements, %d boundary elems\n",
           mesh.GetNV(), mesh.GetNE(), mesh.GetNBE());
    fflush(stdout);
    log_mem("solve: after MFEM mesh build");
    return mesh;
}

}  // namespace kofem::fem
