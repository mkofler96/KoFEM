// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Kirchhoff flat-facet shell solve — Embind wrapper over shell_core. Takes a
// triangle SURFACE mesh (not a volume mesh) plus a uniform thickness, and solves
// the shell (membrane + bending) linear system. See shell_core.h for the
// element formulation.
#pragma once

#include <emscripten/val.h>

#include <string>

// Solve a Kirchhoff shell on the given triangle surface mesh. `mesh` is a JS
// object of flat typed arrays {vertices: Float64Array, triangles: Int32Array}.
// `mat_json` is {young_modulus, poisson_ratio, thickness}. `bcs_json` is
// {fixed_vertices?: int[], fixed_dofs?: [{vertex, dofs:int[]}],
//  point_loads?: [{vertex, force:[fx,fy,fz], moment?:[mx,my,mz]}]} where DOF
// components are 0..5 = (u,v,w,θx,θy,θz). Returns {displacements: Float64Array}
// (three translations per node, node order) or {error: string} on bad input.
emscripten::val solve_shell(emscripten::val mesh,
                            const std::string& mat_json,
                            const std::string& bcs_json);
