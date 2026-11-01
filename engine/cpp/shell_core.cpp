// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Shell and coupled solid+shell solve drivers: assembly, essential BCs, coupling
// reduction and the CG solve. See shell_core.h. The element math, the sparse
// solver and the coupling constraints live in their own translation units
// (shell_element, tet_element, sparse_cg, coupling_constraints).

#include "shell_core.h"

#include <array>
#include <cstddef>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "bc_validation.h"
#include "coupling_constraints.h"
#include "shell_element.h"
#include "sparse_cg.h"

namespace kofem::shell {

namespace {

using sparse::SparseMatrix;

// Assemble one DKT+CST shell facet into the global 6-DOF/node system, its
// stiffness multiplied by `scale` (1 for the plain solve; the SIMP density
// interpolation E(ρ)/E₀ for topology optimization — the element stiffness is
// linear in E, so one scalar scales the whole facet). The 18×18 global element
// matrix itself is built by facet_global_stiffness (shell_element.h).
void assemble_shell_element(SparseMatrix& K, const std::vector<double>& V, int n0, int n1,
                            int n2, double t, double E, double nu, double scale = 1.0) {
    const auto KG = facet_global_stiffness(V, n0, n1, n2, t, E, nu);
    const std::array<int, 3> nodes = {n0, n1, n2};
    for (int a = 0; a < 18; ++a)
        for (int b = 0; b < 18; ++b) {
            if (KG[a][b] == 0.0) continue;
            K.add(6 * nodes[a / 6] + a % 6, 6 * nodes[b / 6] + b % 6, scale * KG[a][b]);
        }
}

// Fold `prescribed` into the (fixed, values) pair the elimination takes. A DOF
// constrained twice to different values is a modelling contradiction, not
// something to pick a winner for (KOF-218): a DOF already in `fixed` (u = 0) may
// only be prescribed to 0, and two prescribed values must agree. Identical
// duplicates pass.
void add_prescribed(const std::vector<std::pair<int, double>>& prescribed, int nDof,
                    const char* what, std::vector<char>& fixed, std::vector<double>& values) {
    if (prescribed.empty()) return;
    values.assign(nDof, 0.0);
    std::vector<char> seen(nDof, 0);
    for (const auto& [dof, val] : prescribed) {
        if (dof < 0 || dof >= nDof)
            throw std::runtime_error(std::string(what) + ": prescribed DOF out of range");
        if (seen[dof] != 0 || fixed[dof] != 0)
            kofem::bc::require_consistent_dirichlet(
                dof / 6, dof % 6,
                seen[dof] != 0 ? kofem::bc::DirichletSource::Prescribed
                               : kofem::bc::DirichletSource::Fixed,
                values[dof], kofem::bc::DirichletSource::Prescribed, val, what);
        seen[dof] = 1;
        fixed[dof] = 1;
        values[dof] = val;
    }
}

// CG on an assembled shell/coupled system, its result in the ShellResult layout.
ShellResult solve_cg(SparseMatrix& K, const std::vector<double>& F, double rel_tol,
                     std::string breakdown_hint = {}) {
    sparse::CgOptions opts;
    opts.rel_tol = rel_tol;
    opts.log_tag = "shell";
    opts.breakdown_hint = std::move(breakdown_hint);
    sparse::CgResult r = sparse::cg_solve(K, F, opts);
    ShellResult res;
    res.dofs = std::move(r.x);
    res.converged = r.converged;
    res.iterations = r.iterations;
    res.rel_residual = r.rel_residual;
    return res;
}

// Master-slave reduction K_red = Tᵀ K T (T carries Cmap on dependent rows),
// homogeneous BCs, CG solve over the independent DOFs, and recovery of the
// dependent DOFs. Consumes K row-by-row so the full and reduced systems never
// coexist in full (WASM heap headroom).
ShellResult solve_reduced_system(SparseMatrix& K, const std::vector<double>& F,
                                 const std::vector<char>& fixed,
                                 const std::vector<double>& values,
                                 const CouplingConstraints& C, int nDof, double rel_tol) {
    std::vector<int> red(nDof, -1);
    int nIndep = 0;
    for (int i = 0; i < nDof; ++i)
        if (C.dep[i] == 0) red[i] = nIndep++;

    // resolve_constraint_chains has already substituted every dependent DOF out of
    // the constraint rows, so each row references independent DOFs only. Verify
    // it: a leftover chained target has no reduced index (red = −1) and would
    // index the reduced matrix out of bounds.
    for (int i = 0; i < nDof; ++i)
        if (C.dep[i] != 0)
            for (const auto& [q, c] : C.Cmap[i]) {
                (void)c;
                if (C.dep[q] != 0)
                    throw std::runtime_error(
                        "solve_reduced_system: node " + std::to_string(i / 6) +
                        " still depends on node " + std::to_string(q / 6) +
                        ", which is itself dependent — constraint chains were not "
                        "resolved before the reduction (internal error).");
            }

    auto expand = [&](int dof) -> std::vector<std::pair<int, double>> {
        if (C.dep[dof] == 0) return {{dof, 1.0}};
        return C.Cmap[dof];  // entries reference independent (solid) DOFs
    };

    SparseMatrix Kr(nIndep);
    for (int i = 0; i < nDof; ++i) {
        if (K.rows[i].empty()) continue;
        const auto ei = expand(i);
        for (const auto& [j, v] : K.rows[i]) {
            const auto ej = expand(j);
            for (const auto& [pi, ci] : ei)
                for (const auto& [pj, cj] : ej) Kr.add(red[pi], red[pj], ci * cj * v);
        }
        SparseMatrix::Row().swap(K.rows[i]);  // row fully transformed — release it
    }
    K.free_rows();
    std::vector<double> Fr(nIndep, 0.0);
    for (int i = 0; i < nDof; ++i)
        if (F[i] != 0.0)
            for (const auto& [pi, ci] : expand(i)) Fr[red[pi]] += ci * F[i];

    // An independent DOF maps one-to-one onto its reduced column (coefficient 1),
    // so a prescribed value carries over unchanged. A dependent one has no column
    // of its own and is refused below, which is why no transform is needed here.
    std::vector<char> fr(nIndep, 0);
    std::vector<double> vr;
    if (!values.empty()) vr.assign(nIndep, 0.0);
    for (int i = 0; i < nDof; ++i) {
        if (fixed[i] == 0) continue;
        // A fixed or prescribed DOF on a dependent (RBE3 distributing-coupling
        // reference) node has no reduced-system column of its own — its motion is
        // a weighted average of the coupled solid nodes — so it cannot be
        // constrained here. Silently skipping it (the old `&& C.dep[i] == 0`
        // guard) dropped the user's constraint and still let CG converge on an
        // under-restrained model (issue #377). Refuse loudly instead. Driving such
        // a node is refused for the same reason it cannot be clamped: the
        // coupling, not the BC, already dictates the motion (KOF-210).
        if (C.dep[i] != 0) {
            const bool driven = !values.empty() && values[i] != 0.0;
            throw std::runtime_error(
                std::string("solve_reduced_system: ") + (driven ? "prescribed" : "fixed") +
                " DOF " + std::to_string(i) + " (node " + std::to_string(i / 6) +
                ", component " + std::to_string(i % 6) +
                ") lies on a coupling-dependent node — its motion is governed by "
                "the RBE3 distributing coupling to the solid, so a direct "
                "constraint on it cannot be honoured and would otherwise be "
                "silently dropped. Constrain the coupled solid node(s) instead of "
                "the shell coupling reference node.");
        }
        fr[red[i]] = 1;
        if (!vr.empty()) vr[red[i]] = values[i];
    }
    sparse::apply_essential_bc(Kr, Fr, fr, vr);

    ShellResult rr = solve_cg(Kr, Fr, rel_tol,
                              "Check the coupling constraints: a coupling whose reference "
                              "node carries structural stiffness, or whose target patch is "
                              "degenerate, destroys definiteness of Kᵣ = TᵀKT.");
    if (rr.dofs.empty()) rr.dofs.assign(nIndep, 0.0);

    ShellResult full;
    full.converged = rr.converged;
    full.iterations = rr.iterations;
    full.rel_residual = rr.rel_residual;
    full.dofs.assign(nDof, 0.0);
    for (int i = 0; i < nDof; ++i) {
        if (C.dep[i] == 0) {
            full.dofs[i] = rr.dofs[red[i]];
        } else {
            double s = 0.0;
            for (const auto& [q, c] : C.Cmap[i]) s += c * rr.dofs[red[q]];
            full.dofs[i] = s;
        }
    }
    return full;
}

}  // namespace

ShellResult solve_shell_core(const ShellInput& in) {
    if (in.vertices.size() % 3 != 0)
        throw std::runtime_error("shell: vertices length not divisible by 3");
    if (in.triangles.size() % 3 != 0)
        throw std::runtime_error("shell: triangles length not divisible by 3");
    const int nNodes = static_cast<int>(in.vertices.size() / 3);
    const int nTris = static_cast<int>(in.triangles.size() / 3);
    if (nNodes == 0 || nTris == 0)
        throw std::runtime_error("shell: mesh has no nodes or no triangles");
    const int nDof = 6 * nNodes;

    // Thickness is either a valid per-facet field or a positive uniform scalar.
    const bool per_facet = static_cast<int>(in.thicknesses.size()) == nTris;
    if (!per_facet && in.thickness <= 0.0)
        throw std::runtime_error("shell: thickness must be positive");
    if (per_facet)
        for (double tk : in.thicknesses)
            if (tk <= 0.0) throw std::runtime_error("shell: per-facet thickness must be positive");
    // Optional per-facet stiffness scale (SIMP density interpolation); empty ⇒ 1.
    const bool scaled = static_cast<int>(in.element_scale.size()) == nTris;
    if (!in.element_scale.empty() && !scaled)
        throw std::runtime_error("shell: element_scale length must match the triangle count");
    SparseMatrix K(nDof);
    for (int e = 0; e < nTris; ++e) {
        const size_t e3 = 3 * static_cast<size_t>(e);
        assemble_shell_element(K, in.vertices, in.triangles[e3], in.triangles[e3 + 1],
                               in.triangles[e3 + 2], per_facet ? in.thicknesses[e] : in.thickness,
                               in.young, in.poisson, scaled ? in.element_scale[e] : 1.0);
    }

    std::vector<double> F(nDof, 0.0);
    for (const auto& [dof, val] : in.loads) {
        if (dof < 0 || dof >= nDof) throw std::runtime_error("shell: load DOF out of range");
        F[dof] += val;
    }

    std::vector<char> fixed(nDof, 0);
    for (int d : in.fixed_dofs) {
        if (d < 0 || d >= nDof) throw std::runtime_error("shell: fixed DOF out of range");
        fixed[d] = 1;
    }
    std::vector<double> values;
    add_prescribed(in.prescribed_dofs, nDof, "shell", fixed, values);
    sparse::apply_essential_bc(K, F, fixed, values);

    ShellResult res = solve_cg(K, F, in.cg_rel_tol);
    if (res.dofs.empty()) res.dofs.assign(nDof, 0.0);
    return res;
}

// ── Coupled solid + shell ─────────────────────────────────────────────────────

ShellResult solve_solid_shell_core(const CoupledInput& in) {
    const int nNodes = in.n_nodes;
    if (nNodes <= 0) throw std::runtime_error("coupled: n_nodes must be positive");
    if ((int)in.vertices.size() != 3 * nNodes)
        throw std::runtime_error("coupled: vertices length does not match n_nodes");
    const int nDof = 6 * nNodes;

    SparseMatrix K(nDof);
    // Solid stiffness (triplets over 3·node+comp) → translational DOFs.
    for (const auto& tr : in.solid_stiffness) {
        const int gi = 6 * (tr.i / 3) + tr.i % 3;
        const int gj = 6 * (tr.j / 3) + tr.j % 3;
        K.add(gi, gj, tr.v);
    }
    // Shell facets → all 6 DOFs; record which nodes carry rotational stiffness.
    std::vector<char> is_shell(nNodes, 0);
    const int nTris = static_cast<int>(in.triangles.size() / 3);
    const bool per_facet = static_cast<int>(in.thicknesses.size()) == nTris;
    // Optional per-facet stiffness scale (SIMP); the solid tets are scaled by the
    // caller pre-scaling in.solid_stiffness, so one density field spans both.
    const bool scaled = static_cast<int>(in.shell_scale.size()) == nTris;
    if (!in.shell_scale.empty() && !scaled)
        throw std::runtime_error("coupled: shell_scale length must match the triangle count");
    for (int e = 0; e < nTris; ++e) {
        const size_t e3 = 3 * static_cast<size_t>(e);
        const int a = in.triangles[e3], b = in.triangles[e3 + 1], c = in.triangles[e3 + 2];
        assemble_shell_element(K, in.vertices, a, b, c, per_facet ? in.thicknesses[e] : in.thickness,
                               in.shell_young, in.shell_poisson, scaled ? in.shell_scale[e] : 1.0);
        is_shell[a] = is_shell[b] = is_shell[c] = 1;
    }

    std::vector<double> F(nDof, 0.0);
    for (const auto& [dof, val] : in.loads) {
        if (dof < 0 || dof >= nDof) throw std::runtime_error("coupled: load DOF out of range");
        F[dof] += val;
    }

    std::vector<char> fixed(nDof, 0);
    for (int d : in.fixed_dofs) {
        if (d < 0 || d >= nDof) throw std::runtime_error("coupled: fixed DOF out of range");
        fixed[d] = 1;
    }
    std::vector<double> values;
    add_prescribed(in.prescribed_dofs, nDof, "coupled", fixed, values);
    // A coupling reference node's rotations must NOT be auto-fixed, whichever way
    // the coupling points. For a distributing coupling all six of its DOFs are
    // eliminated (they become the RBE3 average of its targets) and a fixed
    // dependent DOF is a conflict the reduction rejects (#377). For a kinematic
    // coupling the reference is the independent point the coupled surface follows,
    // and its rotations are the very DOFs that carry the surface's rigid-body
    // motion — fixing them would weld the spider flat. This also lets a SOLID node
    // be a coupling reference, which is how a gapped solid↔solid interface (a pin
    // in a hole: the two surfaces do not share nodes) is tied.
    std::vector<char> is_coupling_ref(nNodes, 0);
    for (const auto& cp : in.couplings)
        if (cp.kind != CouplingKind::ShellFootprint && cp.ref_node >= 0 && cp.ref_node < nNodes)
            is_coupling_ref[cp.ref_node] = 1;
    // Solid-only nodes have no rotational stiffness → auto-fix their rotations
    // (unless they are a coupling reference, whose rotations are eliminated).
    for (int n = 0; n < nNodes; ++n)
        if (is_shell[n] == 0 && is_coupling_ref[n] == 0) {
            const size_t n6 = 6 * static_cast<size_t>(n);
            for (size_t c = 3; c < 6; ++c) fixed[n6 + c] = 1;
        }

    std::vector<char> has_rotation(nNodes, 0);
    for (int n = 0; n < nNodes; ++n)
        has_rotation[n] = (is_shell[n] != 0 || is_coupling_ref[n] != 0) ? 1 : 0;
    CouplingConstraints constraints =
        build_coupling_constraints(in.vertices, in.couplings, nDof, has_rotation);
    resolve_constraint_chains(constraints, nDof);
    return solve_reduced_system(K, F, fixed, values, constraints, nDof, in.cg_rel_tol);
}

}  // namespace kofem::shell
