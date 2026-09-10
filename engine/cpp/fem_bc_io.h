// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Boundary-condition and load ingestion shared by the FEM pipeline stages:
// collect the essential (Dirichlet) DOFs and assemble the right-hand side
// (point + work-equivalent surface loads) from the JS BCs payload. Factored out
// of solve_mfem.cpp (ADR-0002 decision 2) so the linear-elastic solve and the
// SIMP topology-optimization loop share one BC/load assembler instead of
// duplicating it; the optimize_topology entry point (topology_simp.cpp, KOF-231)
// is the second caller. solve_linear_elastic's observable behaviour is
// unchanged — this is the same code, relocated.
#pragma once

#include <emscripten/val.h>

#include <mfem.hpp>

#include <deque>
#include <memory>
#include <utility>
#include <vector>

namespace kofem::fem {

// Essential (Dirichlet) DOFs collected from the BCs payload. `prescribed_vals`
// maps a vdof to a NON-ZERO prescribed displacement (inhomogeneous essential
// BC); the caller seeds these into the solution GridFunction before
// FormLinearSystem so the eliminated DOFs carry the requested value. Homogeneous
// constraints leave `prescribed_vals` empty.
struct EssentialBcs {
    mfem::Array<int> ess_tdof;
    std::vector<std::pair<int, double>> prescribed_vals;
};

// Collect the essential DOFs of a vector-H1 space from the BCs payload:
//   fixed_vertices    every translational component of the vertex is pinned to 0
//   fixed_dofs        [{vertex, dofs[]}] pins only the listed components
//   prescribed_dofs   [{vertex, dof, value}] pins a component to a non-zero value
// For order ≥ 2 each condition is extended to the edge-interior DOFs whose
// endpoints both carry it, so a clamped/prescribed face stays fully constrained.
// The returned `ess_tdof` is sorted and de-duplicated.
EssentialBcs collect_essential_dofs(const emscripten::val& bcs_js, mfem::Mesh& mesh,
                                    mfem::FiniteElementSpace& fespace, int order);

// The integrators added by apply_surface_loads take ownership of their
// coefficient by reference and their marker array by pointer, so both must
// outlive b.Assemble(); they are held in these stable-address containers, owned
// by the caller (the solve/optimize orchestrator).
struct SurfaceLoadStorage {
    std::deque<std::unique_ptr<mfem::VectorCoefficient>> coeffs;
    std::deque<mfem::Array<int>> markers;
};

// Add work-equivalent surface (traction / pressure / total-force) loads to the
// linear form `b` via MFEM's boundary linear-form integrator. `storage` must
// outlive b.Assemble(). Overlapping loads are all integrated over the shared
// boundary elements (KOF-216). A no-op when `surf_js` is undefined/null/empty.
void apply_surface_loads(const emscripten::val& surf_js, mfem::Mesh& mesh,
                         mfem::LinearForm& b, SurfaceLoadStorage& storage);

// Add concentrated point loads straight to the assembled load vector `b`
// (call after b.Assemble()). Each entry is { vertex, force: [fx, fy, fz] }.
void apply_point_loads(const emscripten::val& loads_js,
                       mfem::FiniteElementSpace& fespace, mfem::LinearForm& b);

}  // namespace kofem::fem
