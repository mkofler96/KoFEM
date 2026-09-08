// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Loud validation of the vertex/DOF-component indices carried by boundary
// conditions and point loads — pure C++, no MFEM/Emscripten dependency so it
// can be unit-tested natively (see scripts/test-bc-validation.sh).
//
// The BC/load ingestion in solve_mfem.cpp resolves a vertex's DOFs via
// FiniteElementSpace::GetVertexVDofs. For an out-of-range vertex index that call
// returns an empty array, which the old guard-at-use code (`if (d < vdofs.Size())`
// / `if (vdofs.Size() >= 3)`) silently skipped — dropping a fixed DOF, a
// prescribed displacement, or a whole point load without any error (issue #362).
// A dropped constraint/force still lets CG "converge", so the solve looks
// successful while quietly missing something the user configured in the UI.
// These helpers validate the incoming indices up front and throw a descriptive
// std::runtime_error instead, matching the "loud, information-rich errors, no
// silent fall-throughs" convention in CLAUDE.md.

#ifndef KOFEM_BC_VALIDATION_H
#define KOFEM_BC_VALIDATION_H

#include <stdexcept>
#include <string>

namespace kofem::bc {

// Throw if `vi` is not a valid 0-based vertex index into a mesh of `nv`
// vertices. `fn` names the calling ingestion function for the error message.
inline void require_valid_vertex(int vi, int nv, const char* fn) {
    if (vi < 0 || vi >= nv)
        throw std::runtime_error(
            std::string(fn) + ": vertex index " + std::to_string(vi) +
            " is out of range [0, " + std::to_string(nv) +
            ") — a boundary condition or load references a vertex the mesh does "
            "not contain (a stale index after a remesh renumbered the nodes?)");
}

// Throw if `d` is not a valid DOF component index for a vertex that resolved to
// `ndof` vector DOFs (0=Ux, 1=Uy, 2=Uz for the 3D vector space here). `vi` and
// `fn` are used only to build the error message.
inline void require_valid_component(int d, int ndof, int vi, const char* fn) {
    if (d < 0 || d >= ndof)
        throw std::runtime_error(
            std::string(fn) + ": vertex " + std::to_string(vi) +
            " was given the invalid DOF component index " + std::to_string(d) +
            " — expected 0.." + std::to_string(ndof - 1) + " (0=Ux, 1=Uy, 2=Uz)");
}

// Throw if a validated vertex did not resolve to at least `need` vector DOFs.
// A point load writes three force components, so it needs the full x/y/z triple;
// after require_valid_vertex this only fails on a malformed FE space, but keeping
// it loud avoids an out-of-bounds write into the load vector.
inline void require_min_dofs(int ndof, int need, int vi, const char* fn) {
    if (ndof < need)
        throw std::runtime_error(
            std::string(fn) + ": vertex " + std::to_string(vi) + " resolved to " +
            std::to_string(ndof) + " DOF(s) but " + std::to_string(need) +
            " are required");
}

// Throw if `d` is not a valid Kirchhoff shell DOF component index (0..5). Unlike
// the solid path's 3-component vector space, a shell node carries six DOFs — three
// translations and three rotations — so solve_shell.cpp's fixed-DOF ingestion
// validates against 0..5 (0=Ux, 1=Uy, 2=Uz, 3=Rx, 4=Ry, 5=Rz) instead of silently
// dropping an out-of-range component (issue #379). `vi` and `fn` build the message.
inline void require_valid_shell_component(int d, int vi, const char* fn) {
    if (d < 0 || d >= 6)
        throw std::runtime_error(
            std::string(fn) + ": vertex " + std::to_string(vi) +
            " was given the invalid shell DOF component index " + std::to_string(d) +
            " — expected 0..5 (0=Ux, 1=Uy, 2=Uz, 3=Rx, 4=Ry, 5=Rz)");
}

// Throw if a surface load's face selection resolved to no boundary element at
// all. `matched` is the number of boundary elements found for the load's
// `n_faces` selected faces; `load_idx` and `type` name the offending entry.
// A load matching nothing contributes nothing to the right-hand side, so the
// solve still "converges" — with the load the user configured simply absent
// (issue #428). The shell path already treats the equivalent case as fatal
// (distributeShellSurfaceLoad in web/src/workers/solver.worker.ts).
inline void require_matched_boundary_elements(int matched, unsigned n_faces,
                                              unsigned load_idx, const char* type) {
    if (matched == 0)
        throw std::runtime_error(
            "surface_load " + std::to_string(load_idx) + " (" + type +
            "): none of the " + std::to_string(n_faces) +
            " selected face(s) matched a boundary element of the mesh, so the "
            "load would apply no force at all — a stale face selection after a "
            "remesh renumbered the nodes?");
}

// Throw if the boundary elements matched by a total-force ("force") surface load
// integrate to a non-positive area. Such a load is applied as the uniform
// traction F/A, which has no meaningful value for A <= 0; returning no
// coefficient instead would drop the force silently (issue #428).
inline void require_positive_load_area(double area, unsigned load_idx, int matched) {
    if (area <= 0.0)
        throw std::runtime_error(
            "surface_load " + std::to_string(load_idx) + " (force): the " +
            std::to_string(matched) +
            " matched boundary element(s) integrate to a total area of " +
            std::to_string(area) +
            ", so a total force cannot be spread into a traction — degenerate or "
            "zero-area faces in the selection?");
}

}  // namespace kofem::bc

#endif  // KOFEM_BC_VALIDATION_H
