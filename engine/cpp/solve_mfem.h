// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// MFEM linear-elastic FEM solve: assemble the stiffness system from a volume
// mesh + material + boundary conditions, solve with CG, recover stress.
#pragma once

#include <emscripten/val.h>

#include <string>

// Solve linear elasticity on the given mesh. `mesh` is a JS object of flat
// typed arrays {vertices: Float64Array, tetrahedra: Int32Array, hexahedra?:
// Int32Array}; material and BCs stay JSON (small payloads). Returns
// {displacements: Float64Array, von_mises: Float64Array} — binary transfer,
// no JSON text (issue #166) — or {error: string} when the material inputs
// are incomplete.
emscripten::val solve_linear_elastic(emscripten::val mesh,
                                     const std::string& mat_json,
                                     const std::string& bcs_json,
                                     int order);
