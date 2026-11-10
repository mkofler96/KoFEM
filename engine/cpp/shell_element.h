// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Flat-facet Kirchhoff shell element — constant-strain-triangle (CST) membrane
// plus Discrete Kirchhoff Triangle (DKT) bending, 6 DOF/node (u,v,w,θx,θy,θz).
// Element stiffness and stress recovery only; assembly and the solve live in
// shell_core. No MFEM/Emscripten dependency, so it is natively testable.
//
// References:
//   Batoz, Bathe & Ho (1980), "A study of three-node triangular plate bending
//   elements", IJNME 15, 1771–1812 — the DKT bending stiffness.
//   Membrane is the standard CST plane-stress triangle.

#ifndef KOFEM_SHELL_ELEMENT_H
#define KOFEM_SHELL_ELEMENT_H

#include <array>
#include <vector>

namespace kofem::shell {

// One shell facet's 18×18 stiffness (6 DOF/node × 3 nodes, local DOF order
// u,v,w,θx,θy,θz per node), transformed into global coordinates — exactly the
// matrix the shell/coupled assembly scatters, including the drilling
// stabilisation. The topology optimizer (topology_shell.cpp) caches these once at
// the full design modulus E₀ to assemble K(ρ) = Σ_e s(ρ_e)·k0_e and to recover
// the per-element strain energy. Throws std::runtime_error on a degenerate facet.
std::array<std::array<double, 18>, 18> facet_global_stiffness(
    const std::vector<double>& vertices, int n0, int n1, int n2, double t, double E,
    double nu);

// Thickness of each of `n_tris` facets. A non-empty `thicknesses` field is the
// thickness source and must hold exactly one finite, positive value per facet;
// the uniform `thickness` is then ignored. An empty field means every facet
// takes the uniform `thickness`, which must be finite and positive (unless
// there are no facets). Throws std::runtime_error, prefixed with `who`, on any
// other input — a wrong-length field is never silently replaced by the scalar.
std::vector<double> facet_thicknesses(int n_tris, double thickness,
                                      const std::vector<double>& thicknesses,
                                      const char* who);

// One value per shell triangle: plane-stress von Mises at the worse of the two
// surfaces z = ±t/2, combining the CST membrane strain with the DKT bending
// curvature at the facet centroid (σ(z) = D·(ε_m + z·κ)). `dofs` holds 6 values
// per node (the ShellResult::dofs layout); the thickness inputs follow
// facet_thicknesses.
std::vector<double> shell_von_mises(const std::vector<double>& vertices,
                                    const std::vector<int>& triangles,
                                    double thickness,
                                    const std::vector<double>& thicknesses,
                                    double young, double poisson,
                                    const std::vector<double>& dofs);

}  // namespace kofem::shell

#endif  // KOFEM_SHELL_ELEMENT_H
