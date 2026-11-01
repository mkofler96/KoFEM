// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Linear (4-node) isotropic tetrahedron — stiffness and constant-strain stress
// recovery for the MFEM-free coupled solid/shell path. Production assembles the
// solid with MFEM and hands it in as SolidTriplets; the native tests and the
// topology optimizer use the routines here. No MFEM/Emscripten dependency.

#ifndef KOFEM_TET_ELEMENT_H
#define KOFEM_TET_ELEMENT_H

#include <array>
#include <vector>

namespace kofem::shell {

// One assembled solid-stiffness entry over a 3-DOF/node numbering (index
// 3·node+component). Symmetric — provide the full matrix (both i,j and j,i) or
// only the upper/lower part consistently; entries accumulate.
struct SolidTriplet {
    int i = 0;
    int j = 0;
    double v = 0.0;
};

// One linear tet's 12×12 stiffness (3 translational DOF/node × 4 nodes, local DOF
// order u,v,w per node). Throws std::runtime_error on a zero-volume tet.
std::array<std::array<double, 12>, 12> tet_element_stiffness(
    const std::vector<double>& vertices, int n0, int n1, int n2, int n3, double young,
    double poisson);

// Assemble linear-elastic tet stiffness as solid triplets (3·node+comp
// numbering) — the per-element blocks of tet_element_stiffness, zeros skipped.
// For tests and non-MFEM callers; production uses MFEM instead.
std::vector<SolidTriplet> tet_solid_stiffness(const std::vector<double>& vertices,
                                              const std::vector<int>& tets,
                                              double young, double poisson);

// One von Mises value per tet: constant-strain element stress from the
// displacement gradient (translational DOFs only). `dofs` holds 6 values per node
// (the ShellResult::dofs layout).
//
// `attributes[e]` is the 1-based material index of tet e into `youngs` /
// `poissons`; an empty `attributes` puts every tet on material 1. Recovering
// stress with one modulus for an assembly of several materials reports the wrong
// stress everywhere the modulus is not that one, so the selection has to reach
// this far, not just the stiffness assembly.
std::vector<double> tet_von_mises(const std::vector<double>& vertices,
                                  const std::vector<int>& tets,
                                  const std::vector<double>& youngs,
                                  const std::vector<double>& poissons,
                                  const std::vector<int>& attributes,
                                  const std::vector<double>& dofs);

// Single-material convenience overload.
std::vector<double> tet_von_mises(const std::vector<double>& vertices,
                                  const std::vector<int>& tets, double young,
                                  double poisson, const std::vector<double>& dofs);

}  // namespace kofem::shell

#endif  // KOFEM_TET_ELEMENT_H
