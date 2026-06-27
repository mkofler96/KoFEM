// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// MFEM linear-elastic FEM solve: assemble the stiffness system from a volume
// mesh + material + boundary conditions, solve with CG, recover stress.
#pragma once

#include <string>

// Solve linear elasticity on the given mesh. Returns
// {displacements, von_mises} JSON.
std::string solve_linear_elastic(const std::string& mesh_json,
                                 const std::string& mat_json,
                                 const std::string& bcs_json,
                                 int order);
