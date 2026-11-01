// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Coupling constraints (RBE3 distributing, relaxed shell-to-solid MPC, RBE2
// kinematic) as master-slave DOF equations. See coupling_constraints.h.

#include "coupling_constraints.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <map>
#include <stdexcept>
#include <string>

#include "small_linalg.h"

namespace kofem::shell {

CouplingConstraints build_coupling_constraints(const std::vector<double>& vertices,
                                               const std::vector<Coupling>& couplings,
                                               int nDof,
                                               const std::vector<char>& has_rotation) {
    if (nDof <= 0 || nDof % 6 != 0)
        throw std::runtime_error("coupled: constraint DOF count must be a positive multiple of 6");
    const size_t nNodes = static_cast<size_t>(nDof) / 6;
    if (vertices.size() != 3 * nNodes)
        throw std::runtime_error("coupled: vertices length does not match the DOF count");
    if (has_rotation.size() != nNodes)
        throw std::runtime_error("coupled: has_rotation length does not match the node count");
    auto vtx = [&](int n) { return vertex(vertices, n); };
    CouplingConstraints out;
    out.dep.assign(nDof, 0);
    out.Cmap.resize(nDof);
    for (const auto& cp : couplings) {
        const int R = cp.ref_node;
        if (R < 0 || 6 * R >= nDof)
            throw std::runtime_error("coupled: coupling ref_node out of range");
        const int N = static_cast<int>(cp.solid_nodes.size());
        const Vec3 pR = vtx(R);

        if (cp.kind == CouplingKind::ShellFootprint) {
            if (N != 2 || cp.weights.size() != 2)
                throw std::runtime_error("coupled: shell footprint needs two shell edge nodes and weights");
            double sum = 0;
            Vec3 anchor{};
            for (int i = 0; i < N; ++i) {
                const int node = cp.solid_nodes[i];
                const double weight = cp.weights[i];
                if (node < 0 || node >= nDof / 6 || node == R || has_rotation[node] == 0 ||
                    !std::isfinite(weight) || weight < 0 || weight > 1)
                    throw std::runtime_error("coupled: invalid shell footprint edge node or weight");
                sum += weight;
                const Vec3 position = vtx(node);
                for (int component = 0; component < 3; ++component)
                    anchor[component] += weight * position[component];
            }
            if (std::abs(sum - 1) > 1e-10)
                throw std::runtime_error("coupled: shell footprint weights must sum to one");
            const Vec3 offset = sub(pR, anchor);
            const auto rotation = skew(offset);
            const size_t base = 6 * static_cast<size_t>(R);
            // Kirchhoff section kinematics: u_S = sum N_i (u_i + theta_i x r).
            // Partition of unity and interpolation of the anchor reproduce rigid
            // motion; the transpose transfers the same resultant and moment.
            for (int component = 0; component < 3; ++component) {
                if (out.dep[base + component] != 0)
                    throw std::runtime_error("coupled: shell footprint DOF already belongs to a constraint");
                out.dep[base + component] = 1;
                for (int i = 0; i < N; ++i) {
                    const int node = cp.solid_nodes[i];
                    out.Cmap[base + component].emplace_back(6 * node + component, cp.weights[i]);
                    for (int axis = 0; axis < 3; ++axis)
                        out.Cmap[base + component].emplace_back(6 * node + 3 + axis,
                                                               -cp.weights[i] * rotation[component][axis]);
                }
            }
            continue;
        }

        if (cp.kind == CouplingKind::Kinematic) {
            // RBE2: every coupled node follows the reference point as a rigid
            // body, so the COUPLED nodes are eliminated and the point stays an
            // independent DOF that can be fixed, loaded or tied onward. One
            // coupled node with the rotations masked out is a spherical joint;
            // with them in, a rigid link.
            if (N < 1)
                throw std::runtime_error("coupled: a kinematic coupling needs ≥1 coupled node");
            for (int i = 0; i < N; ++i) {
                const int sn = cp.solid_nodes[i];
                if (sn < 0 || 6 * sn >= nDof)
                    throw std::runtime_error("coupled: kinematic coupled node out of range");
                if (sn == R)
                    throw std::runtime_error(
                        "coupled: kinematic coupling node " + std::to_string(sn) +
                        " is its own reference point");
                const Vec3 pi = vtx(sn);
                const Vec3 r = {pi[0] - pR[0], pi[1] - pR[1], pi[2] - pR[2]};
                const size_t i6 = 6 * static_cast<size_t>(sn);
                const size_t R6k = 6 * static_cast<size_t>(R);
                // u_i = u_R + θ_R × r  (component-wise, to keep the signs plain)
                //   x: +θy·rz − θz·ry   y: +θz·rx − θx·rz   z: +θx·ry − θy·rx
                static constexpr std::array<int, 3> kPlus = {1, 2, 0};   // θ index, + sign
                static constexpr std::array<int, 3> kMinus = {2, 0, 1};  // θ index, − sign
                for (int c = 0; c < 3; ++c) {
                    if ((cp.dof_mask & (1 << c)) == 0) continue;
                    if (out.dep[i6 + c] != 0)
                        throw std::runtime_error(
                            "coupled: node " + std::to_string(sn) + " DOF " + std::to_string(c) +
                            " is already governed by another coupling — a DOF can be "
                            "eliminated by only one constraint");
                    out.dep[i6 + c] = 1;
                    out.Cmap[i6 + c].emplace_back(R6k + c, 1.0);
                    out.Cmap[i6 + c].emplace_back(R6k + 3 + kPlus[c], r[kMinus[c]]);
                    out.Cmap[i6 + c].emplace_back(R6k + 3 + kMinus[c], -r[kPlus[c]]);
                }
                // θ_i = θ_R, only where the coupled node actually carries a
                // rotational DOF; on a solid-only node there is none to tie.
                for (int a = 0; a < 3; ++a) {
                    if ((cp.dof_mask & (1 << (3 + a))) == 0) continue;
                    if (has_rotation[sn] == 0) continue;
                    if (out.dep[i6 + 3 + a] != 0)
                        throw std::runtime_error(
                            "coupled: node " + std::to_string(sn) + " rotation " +
                            std::to_string(a) +
                            " is already governed by another coupling — a DOF can be "
                            "eliminated by only one constraint");
                    out.dep[i6 + 3 + a] = 1;
                    out.Cmap[i6 + 3 + a].emplace_back(R6k + 3 + a, 1.0);
                }
            }
            continue;
        }

        if (N < 3) throw std::runtime_error("coupled: a coupling needs ≥3 solid nodes");
        for (int sn : cp.solid_nodes)
            if (sn < 0 || 6 * sn >= nDof)
                throw std::runtime_error("coupled: coupling solid node out of range");
        std::vector<double> w(N, 1.0);
        if (!cp.weights.empty()) {
            if ((int)cp.weights.size() != N) throw std::runtime_error("coupled: weights size mismatch");
            w = cp.weights;
        }
        const size_t R6 = 6 * static_cast<size_t>(R);
        for (size_t k = 0; k < 6; ++k) out.dep[R6 + k] = 1;

        if (cp.kind == CouplingKind::RelaxedMpc) {
            // Relaxed shell-to-solid MPC (Lu, Zhang & Yang 2023), generalised to a
            // NON-CONFORMING seam. The paper ties the shell node to a solid node
            // coincident with it; an auto-detected seam has none, and tying to the
            // nearest partner instead welds the mid-surface to one FACE of the very
            // wall it idealises. The mid-surface sits t/2 from the footprint node on
            // either face, so with both partners equidistant the pick is decided by
            // floating-point noise and flips from node to node along the seam. Each
            // flip is a spurious ±t/2 eccentricity, and an eccentric tie carries a
            // moment the structure does not: on a 2 mm wall the shell facets touching
            // a tied node ran 12× the von Mises of their neighbours, peaking exactly
            // where the sign flipped (KOF-212).
            //
            // Anchor the tie on the patch's distance-weighted centroid instead of on
            // one node of it. For the equidistant pair that is precisely the
            // mid-surface, so the eccentricity cancels; a genuinely coincident node
            // still dominates the kernel and recovers the paper's tie. The 1/(d²+ε²)
            // weighting keeps the tie LOCAL, which is what separates it from the
            // equal-weight distributing coupling — that one averages over the whole
            // search ball and smears the junction stress away instead.
            const double psi = cp.relaxation;
            double rmax = 0.0;
            for (int sn : cp.solid_nodes) rmax = std::max(rmax, norm(sub(vtx(sn), pR)));
            if (rmax <= 0.0)
                throw std::runtime_error(
                    "coupled: every coupled node of the shell-to-solid MPC at node " +
                    std::to_string(R) +
                    " sits on the reference point, so the patch has no extent and no "
                    "rotation can be measured from it.");
            // ε softens the kernel at d → 0 and is a fraction of the patch's own
            // radius, so the weighting is scale-free.
            const double eps2 = (0.05 * rmax) * (0.05 * rmax);
            double W = 0.0;
            for (int i = 0; i < N; ++i) {
                const Vec3 d = sub(vtx(cp.solid_nodes[i]), pR);
                w[i] /= dot(d, d) + eps2;
                W += w[i];
            }
            // Σ wᵢ rᵢ = 0 about the weighted centroid — that is what drops the u_A
            // term out of the least-squares rotation below.
            Vec3 pA = {0.0, 0.0, 0.0};
            for (int i = 0; i < N; ++i) {
                const Vec3 pi = vtx(cp.solid_nodes[i]);
                for (int k = 0; k < 3; ++k) pA[k] += (w[i] / W) * pi[k];
            }
            std::vector<Vec3> r(N);
            std::array<std::array<double, 3>, 3> H{};
            for (int i = 0; i < N; ++i) {
                r[i] = sub(vtx(cp.solid_nodes[i]), pA);
                const double rr = dot(r[i], r[i]);
                for (int a = 0; a < 3; ++a)
                    for (int b = 0; b < 3; ++b)
                        H[a][b] += w[i] * ((a == b ? rr : 0.0) - r[i][a] * r[i][b]);
            }
            const auto Hinv = mat3_inv(H);
            // U_R = Σ (wᵢ/W) uᵢ — the patch's weighted motion at the anchor.
            for (int i = 0; i < N; ++i)
                for (int c = 0; c < 3; ++c)
                    out.Cmap[R6 + c].emplace_back(6 * cp.solid_nodes[i] + c, w[i] / W);
            // Θ_R = ψ · Hinv · Σ wᵢ [rᵢ]× uᵢ.
            for (int i = 0; i < N; ++i) {
                const int sn = cp.solid_nodes[i];
                const auto M = mat3_mul(Hinv, skew(r[i]));
                for (int a = 0; a < 3; ++a)
                    for (int c = 0; c < 3; ++c)
                        out.Cmap[R6 + 3 + a].emplace_back(6 * sn + c, psi * w[i] * M[a][c]);
            }
            continue;
        }

        // Distributing (RBE3) coupling: weighted-average translation + weighted
        // least-squares rotation about the reference node.
        double W = 0.0;
        for (double wi : w) W += wi;
        Vec3 S = {0.0, 0.0, 0.0};
        std::array<std::array<double, 3>, 3> H{};
        std::vector<Vec3> r(N);
        for (int i = 0; i < N; ++i) {
            const Vec3 pi = vtx(cp.solid_nodes[i]);
            r[i] = {pi[0] - pR[0], pi[1] - pR[1], pi[2] - pR[2]};
            for (int k = 0; k < 3; ++k) S[k] += w[i] * r[i][k];
            const double rr = dot(r[i], r[i]);
            for (int a = 0; a < 3; ++a)
                for (int b = 0; b < 3; ++b)
                    H[a][b] += w[i] * ((a == b ? rr : 0.0) - r[i][a] * r[i][b]);
        }
        const auto Hinv = mat3_inv(H);
        const auto skewS = skew(S);
        for (int i = 0; i < N; ++i) {
            const int sn = cp.solid_nodes[i];
            // U_R = Σ (w_i/W) u_i  (component-diagonal).
            for (int c = 0; c < 3; ++c) out.Cmap[R6 + c].emplace_back(6 * sn + c, w[i] / W);
            // Θ_R = Hinv·Σ (w_i[r_i]× − (w_i/W)[S]×) u_i.
            const auto sr = skew(r[i]);
            std::array<std::array<double, 3>, 3> inner{};
            for (int a = 0; a < 3; ++a)
                for (int b = 0; b < 3; ++b)
                    inner[a][b] = w[i] * sr[a][b] - (w[i] / W) * skewS[a][b];
            const auto M = mat3_mul(Hinv, inner);
            for (int a = 0; a < 3; ++a)
                for (int c = 0; c < 3; ++c)
                    out.Cmap[R6 + 3 + a].emplace_back(6 * sn + c, M[a][c]);
        }
    }
    return out;
}

// Depth-first with an explicit stack (WASM stacks are small) and a cycle check:
// two constraints that depend on each other have no elimination order and are a
// modelling error, not something to iterate on.
void resolve_constraint_chains(CouplingConstraints& C, int nDof) {
    enum : char { Unvisited = 0, InProgress = 1, Resolved = 2 };
    std::vector<char> state(nDof, Unvisited);
    std::vector<int> stack;
    for (int start = 0; start < nDof; ++start) {
        if (C.dep[start] == 0 || state[start] == Resolved) continue;
        stack.push_back(start);
        while (!stack.empty()) {
            const int d = stack.back();
            if (state[d] == Resolved) {
                stack.pop_back();
                continue;
            }
            if (state[d] == InProgress) {
                // Every dependent DOF this row references is resolved by now, so
                // one substitution pass leaves only independent DOFs.
                std::map<int, double> flat;
                for (const auto& [q, c] : C.Cmap[d]) {
                    if (C.dep[q] == 0) {
                        flat[q] += c;
                    } else {
                        for (const auto& [q2, c2] : C.Cmap[q]) flat[q2] += c * c2;
                    }
                }
                C.Cmap[d].assign(flat.begin(), flat.end());
                state[d] = Resolved;
                stack.pop_back();
                continue;
            }
            state[d] = InProgress;
            for (const auto& [q, c] : C.Cmap[d]) {
                (void)c;
                if (C.dep[q] == 0) continue;
                if (state[q] == InProgress)
                    throw std::runtime_error(
                        "coupled: constraints form a cycle — node " + std::to_string(d / 6) +
                        " and node " + std::to_string(q / 6) +
                        " each depend on the other. Break the loop: a chain of couplings "
                        "must end at nodes that are free.");
                if (state[q] == Unvisited) stack.push_back(q);
            }
        }
    }
}

}  // namespace kofem::shell
