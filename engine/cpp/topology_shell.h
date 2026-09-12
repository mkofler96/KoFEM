// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// SIMP minimum-compliance topology optimization for the SHELL and COUPLED
// shell/solid design domains (KOF-237, Phase B of the KOF-226 epic; ADR-0002).
//
// Phase A (topology_optimize.h) optimizes a solid tetrahedral domain through
// MFEM. This is the same SIMP minimum-compliance formulation
//
//   minimize   c(ρ) = fᵀu(ρ)
//   subject to Σ_e ρ_e·V_e ≤ volfrac·Σ_e V_e,   ρ_min ≤ ρ_e ≤ 1
//
// carried onto KoFEM's Kirchhoff/DKT shell facets and its coupled shell/solid
// assembler (shell_core.h). A single density field spans the whole design domain:
// the shell facets (CTRIA3) and, for a coupled model, the solid tets (CTETRA) too.
// The RBE3 (and RBE2/relaxed-MPC) coupling DOFs are NOT design variables — the
// coupling is a geometric constraint, eliminated by the same master-slave
// reduction the coupled solve uses, so it stays intact through every iteration.
//
// Unlike the solid path, this core is MFEM-free: it drives shell_core's native
// assembler + reduction + CG directly, so it compiles and unit-tests with a plain
// host compiler (scripts/test-topology-shell.sh) — the finite-difference
// sensitivity check the acceptance criteria call for. It reuses the shared
// MMA optimizer (topology_mma.h) and mesh-independence filter (topology_filter.h)
// unchanged; only the compliance evaluation differs from the solid path.
//
// SIMP interpolation, identical to the solid path (ADR-0002): each design
// element's stiffness is linear in its Young's modulus, so
//   E(ρ)/E₀ = E_min/E₀ + ρ^p·(1 − E_min/E₀)
// scales the whole element matrix by one scalar. The compliance is self-adjoint,
// so the element sensitivity is dc/dρ_e = −s'(ρ_e)·(uₑᵀk0ₑuₑ) with k0ₑ the
// full-material element stiffness and uₑ the recovered element displacement.
#pragma once

#include "shell_core.h"

#include <array>
#include <utility>
#include <vector>

namespace kofem::topopt {

// Optimizer knobs — the MFEM-free mirror of ComplianceOptConfig
// (topology_optimize.h), duplicated here so this header carries no MFEM include.
struct ShellTopOptConfig {
    double volume_fraction = 0.5;  // target Σρ_e·V_e / ΣV_e
    double penalty = 3.0;          // SIMP penalty p
    double filter_radius = 0.0;    // r_min; ≤ 0 → default 1.5× mean element size
    double move_limit = 0.2;       // MMA move limit
    int max_iterations = 100;
    double tolerance = 0.01;  // convergence on max|Δρ|
    double emin_rel = 1e-9;   // stiffness floor E_min/E₀ (ADR-0002)
    double rho_min = 0.0;     // design lower bound
    // CG relative-residual target for each SIMP inner solve — a caller-set loosening
    // of the static shell solve's 1e-10, the same device the solid path uses
    // (ComplianceOptConfig::cg_rtol, topology_optimize.h). As void regions form the
    // E_min floor drives κ up, so the achievable CG residual floor RISES over the
    // run; a 1e-10 target then sits below what the SSOR/IC-preconditioned CG can
    // reach and the solve burns the whole iteration cap without ever "converging",
    // which throws and stalls the optimization mid-run (KOF-245). This is looser
    // than the solid path's 1e-8 because the thin-wall shell/coupled systems are
    // far worse conditioned (bending/membrane ratio ∝ (t/L)²) and lack MFEM's
    // solver: reaching 1e-8 (or even 1e-6) costs so many CG iterations that a
    // mid-run solve still runs the cap out. 1e-5 keeps the peak iteration count
    // well under the cap (headroom against a finer mesh or thinner wall) while the
    // compliance and its (quadratic-in-u) sensitivities stay accurate to ~1e-5 —
    // negligible for the move-limited MMA step: on the KOF-245 crane the whole
    // trajectory is identical to a 1e-10 solve to six significant figures.
    double cg_rtol = 1e-5;
    // Passive regions over the DESIGN-ELEMENT index (tets first, then facets — see
    // ShellTopOptInput). Pinned solid → 1, pinned void → rho_min. Empty in v1
    // (KOF-238 populates them).
    std::vector<int> passive_solid;
    std::vector<int> passive_void;
};

// The shell/coupled design domain. Design elements are the solid tets FIRST
// (indices 0..nTets−1) then the shell facets (nTets..nTets+nTris−1); the returned
// density is in that order. Pure-shell models leave `tets` empty; coupled models
// carry both plus their couplings. All DOF indices below are in the global
// 6-DOF/node numbering (6·node + component, component 0..5 = u,v,w,θx,θy,θz).
struct ShellTopOptInput {
    int n_nodes = 0;
    std::vector<double> vertices;  // 3·n_nodes, xyz interleaved

    std::vector<int> tets;       // 4·nTets solid design elements (may be empty)
    std::vector<int> triangles;  // 3·nTris shell design elements

    // One design material per sub-domain (v1): the minimum-compliance layout is
    // invariant to a uniform modulus scale, but a mixed shell/solid domain needs
    // the RELATIVE stiffness of the two, so both are kept.
    double solid_young = 0.0, solid_poisson = 0.0;  // used iff tets present
    double shell_young = 0.0, shell_poisson = 0.0;  // used iff triangles present
    double thickness = 0.0;               // uniform shell thickness (fallback)
    std::vector<double> thicknesses;      // optional per-facet thickness (nTris)

    std::vector<kofem::shell::Coupling> couplings;  // NOT design variables

    std::vector<int> fixed_dofs;  // homogeneous supports (u = 0)
    // Inhomogeneous essential BCs. The compliance objective is self-adjoint only
    // for homogeneous supports, so optimize_shell_compliance REJECTS a non-empty
    // list (matching the solid path). Carried here only to detect and refuse it.
    std::vector<std::pair<int, double>> prescribed_dofs;
    std::vector<std::pair<int, double>> loads;  // global DOF → force/moment
};

// One optimizer iteration in the returned history — mirrors TopOptHistoryEntry.
struct ShellTopOptHistoryEntry {
    int it;
    double compliance;
    double volume;
    double max_change;
};

struct ShellTopOptResult {
    std::vector<double> density;        // final ρ_e over design elements (tets, facets)
    std::vector<double> displacements;  // 3 per node (translations), node order
    std::vector<ShellTopOptHistoryEntry> history;
    int iterations = 0;
    bool converged = false;  // stopped on tolerance, not max_iterations
};

// One SIMP evaluation of the shell/coupled compliance at a density field.
struct ShellComplianceEvaluation {
    double compliance = 0.0;            // c = Σ_e s(ρ_e)·qₑ = fᵀu
    std::vector<double> dcompliance;    // dc/dρ_e = −s'(ρ_e)·qₑ  (≤ 0)
    std::vector<double> strain_energy;  // qₑ = uₑᵀk0ₑuₑ  (≥ 0)
    std::vector<double> displacements;  // 3 per node (translations)
    int cg_iterations = 0;
};

// Per-element base stiffness (full material), DOF map, volume and centroid, built
// once from the design mesh and reused every iteration. Design-element order:
// tets first, then facets.
struct ShellStiffnessCache {
    // Per design element, its base (full-material) stiffness stored row-major over
    // the element's own DOFs, the global DOF indices those rows/cols map to, the
    // material volume V_e (tet volume, or facet area·thickness) and the centroid.
    std::vector<std::vector<double>> k0;   // size ndof·ndof (144 tet, 324 facet)
    std::vector<std::vector<int>> dofs;    // global 6-DOF/node indices (12 or 18)
    std::vector<double> volume;
    std::vector<std::array<double, 3>> centroid;
    int n_tets = 0;    // design elements [0, n_tets) are solid tets
    int n_facets = 0;  // design elements [n_tets, n_tets+n_facets) are shell facets
    int num_elements() const { return n_tets + n_facets; }
};

// Build the once-per-run element cache from the design domain.
ShellStiffnessCache build_shell_stiffness_cache(const ShellTopOptInput& in);

// One SIMP solve at density `rho` (one per design element, cache order): assemble
// K(ρ) = Σ_e s(ρ_e)·k0_e through shell_core's coupled assembler + reduction, solve
// with the supports clamped, and return the compliance and its self-adjoint
// element sensitivities. Throws std::runtime_error if the solve fails to converge.
ShellComplianceEvaluation evaluate_shell_compliance(const ShellTopOptInput& in,
                                                    const ShellStiffnessCache& cache,
                                                    const std::vector<double>& rho,
                                                    double penalty, double emin_rel,
                                                    double cg_rtol = 1e-10);

// Run the SIMP minimum-compliance loop. Streams one `[topopt] it N: c=… vol=…
// change=…` line per iteration over stdout (the printf→worker channel). Throws
// std::runtime_error on an ill-posed problem (no design elements, an infeasible
// volume fraction, a non-homogeneous BC, a solve that fails to converge).
ShellTopOptResult optimize_shell_compliance(const ShellTopOptInput& in,
                                            const ShellTopOptConfig& config);

}  // namespace kofem::topopt
