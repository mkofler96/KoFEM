// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Coupled solid + shell solve (Option A): MFEM assembles the solid tets, the
// stiffness is handed to shell_core's distributing-coupling assembler, which adds
// the DKT shells and the RBE3 shell↔solid couplings and solves. See solve_coupled.cpp.
#pragma once

#include <emscripten/val.h>

#include <string>

// Solve a coupled solid(tet)+shell(triangle) model.
//   mesh:     {vertices: Float64Array, tets: Int32Array, triangles: Int32Array,
//              thicknesses?: Float64Array,   (per-triangle shell thickness)
//              attributes?: Int32Array,      (per-tet 1-based index into mat.solid)
//              shell_attributes?: Int32Array} (per-triangle 1-based index into mat.shell)
//   coupling: {ref: Int32Array, offsets: Int32Array, solid: Int32Array}
//              CSR-style distributing couplings: coupling ref-node k ties to
//              solid[offsets[k]..offsets[k+1]).
//   bcs:      {fixed_dofs: Int32Array, load_dofs: Int32Array, load_vals: Float64Array,
//              prescribed_dofs?: Int32Array, prescribed_vals?: Float64Array}
//              DOF indices are 6·node+component (0..5 = u,v,w,θx,θy,θz).
//              fixed_dofs are constrained to ZERO; prescribed_dofs[k] is driven
//              to prescribed_vals[k] (inhomogeneous essential BC).
//   mat_json: {solid, shell} — each one {young_modulus,poisson_ratio} object or
//              an array of them selected by the matching attributes array.
// Returns {displacements: Float64Array} (three translations per node) or {error}.
emscripten::val solve_coupled(const emscripten::val& mesh, const emscripten::val& coupling,
                              const emscripten::val& bcs, const std::string& mat_json);
