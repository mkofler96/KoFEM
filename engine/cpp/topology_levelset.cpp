// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Reaction–diffusion level-set topology optimization — see topology_levelset.h.

#include "topology_levelset.h"

#include "topology_filter.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>

namespace kofem::topopt {

namespace {

using Point = std::array<double, 3>;

// Vertex i of the reference tetrahedron: the origin, then the unit axes.
Point ref_vertex(int i) {
    Point p{0.0, 0.0, 0.0};
    if (i > 0) p[i - 1] = 1.0;
    return p;
}

// Point on the edge from vertex x (φ_x > 0) to vertex y (φ_y ≤ 0) where the
// linear interpolant of φ vanishes.
Point zero_crossing(int x, int y, const std::array<double, 4>& phi) {
    const double s = phi[x] / (phi[x] - phi[y]);
    const Point px = ref_vertex(x);
    const Point py = ref_vertex(y);
    return {px[0] + s * (py[0] - px[0]), px[1] + s * (py[1] - px[1]),
            px[2] + s * (py[2] - px[2])};
}

// |det(b − a, c − a, d − a)|: six times the volume of tet (a, b, c, d). The
// reference tet has det 1, so in reference coordinates this is already the
// fraction of the reference volume.
double abs_det(const Point& a, const Point& b, const Point& c, const Point& d) {
    const Point u{b[0] - a[0], b[1] - a[1], b[2] - a[2]};
    const Point v{c[0] - a[0], c[1] - a[1], c[2] - a[2]};
    const Point w{d[0] - a[0], d[1] - a[1], d[2] - a[2]};
    return std::abs(u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) +
                    u[2] * (v[0] * w[1] - v[1] * w[0]));
}

// Fraction of a tet cut off at a single vertex `v` whose sign differs from the
// other three: the corner tet spanned by the three edge crossings, i.e.
// Π_j φ_v / (φ_v − φ_j).
double corner_fraction(int v, const std::array<double, 4>& phi) {
    double f = 1.0;
    for (int j = 0; j < 4; ++j)
        if (j != v) f *= phi[v] / (phi[v] - phi[j]);
    return f;
}

// Kuhn split of the reference hexahedron into six tets around the 0–6 diagonal,
// in MFEM's hex vertex numbering (0:(0,0,0) 1:(1,0,0) 2:(1,1,0) 3:(0,1,0),
// 4..7 the same at z = 1). Every tet has 1/6 of the reference volume.
constexpr std::array<std::array<int, 4>, 6> kKuhnTets{{
    {0, 1, 2, 6},
    {0, 1, 5, 6},
    {0, 4, 5, 6},
    {0, 4, 7, 6},
    {0, 3, 7, 6},
    {0, 3, 2, 6},
}};

// CG + Gauss–Seidel on the (SPD) reaction–diffusion operator. It is a mass
// matrix plus a small Laplacian, so it is far better conditioned than the
// elasticity solve and converges in a handful of iterations.
void solve_level_set_system(const mfem::SparseMatrix& A, const mfem::Vector& b,
                            mfem::Vector& x) {
    mfem::GSSmoother prec(A);
    mfem::CGSolver cg;
    cg.SetRelTol(1e-10);
    cg.SetMaxIter(5000);
    cg.SetPrintLevel(0);
    cg.SetPreconditioner(prec);
    cg.SetOperator(A);
    cg.iterative_mode = true;  // warm start from φⁿ
    cg.Mult(b, x);
    if (!cg.GetConverged()) {
        std::array<char, 192> msg;
        std::snprintf(msg.data(), msg.size(),
                      "level-set update solve did not converge: relative residual %g "
                      "after %d iterations",
                      (double)cg.GetFinalRelNorm(), cg.GetNumIterations());
        throw std::runtime_error(msg.data());
    }
}

double volume_used(const std::vector<double>& rho, const std::vector<double>& vol) {
    double v = 0.0;
    for (std::size_t e = 0; e < rho.size(); ++e) v += rho[e] * vol[e];
    return v;
}

}  // namespace

double tet_positive_fraction(const std::array<double, 4>& phi) {
    std::array<int, 4> pos{};
    std::array<int, 4> neg{};
    int np = 0;
    int nn = 0;
    for (int i = 0; i < 4; ++i) {
        if (phi[i] > 0.0)
            pos[np++] = i;
        else
            neg[nn++] = i;
    }
    switch (np) {
        case 0: return 0.0;
        case 4: return 1.0;
        case 1: return corner_fraction(pos[0], phi);
        case 3: return 1.0 - corner_fraction(neg[0], phi);
        default: break;
    }
    // Two vertices on each side: {φ > 0} is a triangular prism with end caps
    // (a, P_ac, P_ad) and (b, P_bc, P_bd), split into three tets.
    const int a = pos[0], b = pos[1], c = neg[0], d = neg[1];
    const Point A1 = ref_vertex(a);
    const Point A2 = zero_crossing(a, c, phi);
    const Point A3 = zero_crossing(a, d, phi);
    const Point B1 = ref_vertex(b);
    const Point B2 = zero_crossing(b, c, phi);
    const Point B3 = zero_crossing(b, d, phi);
    const double frac = abs_det(A1, A2, A3, B3) + abs_det(A1, A2, B2, B3) +
                        abs_det(A1, B1, B2, B3);
    return std::min(1.0, std::max(0.0, frac));
}

std::vector<double> level_set_density(const mfem::Mesh& mesh, const std::vector<double>& phi) {
    if (static_cast<int>(phi.size()) != mesh.GetNV())
        throw std::runtime_error("level_set_density: level set has " +
                                 std::to_string(phi.size()) + " values but the mesh has " +
                                 std::to_string(mesh.GetNV()) + " vertices");
    const int ne = mesh.GetNE();
    std::vector<double> rho(ne);
    mfem::Array<int> v;
    for (int e = 0; e < ne; ++e) {
        mesh.GetElementVertices(e, v);
        const mfem::Geometry::Type geom = mesh.GetElementBaseGeometry(e);
        if (geom == mfem::Geometry::TETRAHEDRON) {
            rho[e] = tet_positive_fraction({phi[v[0]], phi[v[1]], phi[v[2]], phi[v[3]]});
        } else if (geom == mfem::Geometry::CUBE) {
            double sum = 0.0;
            for (const std::array<int, 4>& t : kKuhnTets)
                sum += tet_positive_fraction(
                    {phi[v[t[0]]], phi[v[t[1]]], phi[v[t[2]]], phi[v[t[3]]]});
            rho[e] = sum / 6.0;
        } else {
            throw std::runtime_error(
                "level_set_density: element " + std::to_string(e) +
                " is neither a tetrahedron nor a hexahedron — the level-set method "
                "supports CTETRA and CHEXA design domains only");
        }
    }
    return rho;
}

LevelSetOptResult optimize_level_set(mfem::FiniteElementSpace& fespace,
                                     const ElementStiffnessCache& cache,
                                     const mfem::Array<int>& ess_tdof,
                                     const mfem::LinearForm& load,
                                     const LevelSetOptConfig& config) {
    mfem::Mesh& mesh = *fespace.GetMesh();
    const int ne = fespace.GetNE();
    const int nv = mesh.GetNV();
    if (ne <= 0) throw std::runtime_error("optimize_level_set: mesh has no elements");
    if (static_cast<int>(cache.volume.size()) != ne)
        throw std::runtime_error("optimize_level_set: stiffness cache does not match mesh");
    if (std::isnan(config.volume_fraction) || config.volume_fraction <= 0.0 ||
        config.volume_fraction > 1.0)
        throw std::runtime_error("optimize_level_set: volume_fraction must be in (0, 1]");
    if (!std::isfinite(config.regularization_length))
        throw std::runtime_error("optimize_level_set: regularization_length must be finite");
    if (!std::isfinite(config.time_step) || config.time_step <= 0.0)
        throw std::runtime_error("optimize_level_set: time_step must be finite and positive");
    if (!std::isfinite(config.volume_step) || config.volume_step <= 0.0 ||
        config.volume_step > 1.0)
        throw std::runtime_error("optimize_level_set: volume_step must be in (0, 1]");
    if (config.max_iterations <= 0)
        throw std::runtime_error("optimize_level_set: max_iterations must be positive");
    if (!std::isfinite(config.tolerance) || config.tolerance <= 0.0)
        throw std::runtime_error("optimize_level_set: tolerance must be finite and positive");
    if (!std::isfinite(config.emin_rel) || config.emin_rel <= 0.0 || config.emin_rel >= 1.0)
        throw std::runtime_error("optimize_level_set: emin_rel must be in (0, 1)");
    if (!std::isfinite(config.cg_rtol) || config.cg_rtol <= 0.0)
        throw std::runtime_error("optimize_level_set: cg_rtol must be finite and positive");
    config.stream.validate("optimize_level_set");

    // Pinned vertices: every vertex of a passive element. A vertex shared by a
    // kept-solid and a kept-void element cannot honour both — reject it, as the
    // SIMP loop rejects an element listed in both sets.
    std::vector<char> pin(nv, 0);  // 0 free, 1 solid (φ = 1), 2 void (φ = −1)
    auto mark = [&](const std::vector<int>& set, char kind, const char* which) {
        mfem::Array<int> v;
        for (const int e : set) {
            if (e < 0 || e >= ne)
                throw std::runtime_error(std::string("optimize_level_set: passive ") + which +
                                         " element index " + std::to_string(e) +
                                         " out of range [0, " + std::to_string(ne) + ")");
            mesh.GetElementVertices(e, v);
            for (const int vi : v) {
                if (pin[vi] != 0 && pin[vi] != kind)
                    throw std::runtime_error(
                        "optimize_level_set: vertex " + std::to_string(vi) +
                        " belongs to both a passive-solid and a passive-void element — "
                        "the level set cannot be +1 and −1 there");
                pin[vi] = kind;
            }
        }
    };
    mark(config.passive_solid, 1, "solid");
    mark(config.passive_void, 2, "void");
    auto apply_pins = [&](std::vector<double>& phi) {
        for (int i = 0; i < nv; ++i) {
            if (pin[i] == 1) phi[i] = 1.0;
            else if (pin[i] == 2) phi[i] = -1.0;
        }
    };

    double vtotal = 0.0;
    for (const double v : cache.volume) vtotal += v;
    if (!(vtotal > 0.0)) throw std::runtime_error("optimize_level_set: non-positive volume");

    // Reachable volume range with the pins applied: every free node at −1 (the
    // emptiest design) to every free node at +1 (the fullest). A target outside
    // it cannot be met — the λ bisection would just sit on an endpoint and the
    // loop would return a design violating the constraint — so reject it here.
    auto pinned_extreme = [&](double free_value) {
        std::vector<double> phi_ext(nv, free_value);
        apply_pins(phi_ext);
        double v = 0.0;
        const std::vector<double> rho_ext = level_set_density(mesh, phi_ext);
        for (int e = 0; e < ne; ++e) v += rho_ext[e] * cache.volume[e];
        return v / vtotal;
    };
    const double vf_min = pinned_extreme(-1.0);
    const double vf_max = pinned_extreme(1.0);
    if (config.volume_fraction < vf_min - 1e-9 || config.volume_fraction > vf_max + 1e-9)
        throw std::runtime_error(
            "optimize_level_set: volume fraction " + std::to_string(config.volume_fraction) +
            " is infeasible — with the passive solid/void regions the design can only "
            "reach volume fractions in [" +
            std::to_string(vf_min) + ", " + std::to_string(vf_max) + "]");

    // Scalar linear H1 space on the design mesh: for order 1 its DOFs are the
    // mesh vertices in vertex order, so φ is indexed exactly like the mesh.
    mfem::H1_FECollection fec_s(1, mesh.Dimension());
    mfem::FiniteElementSpace fes_s(&mesh, &fec_s);
    if (fes_s.GetTrueVSize() != nv)
        throw std::runtime_error("optimize_level_set: scalar H1 space has " +
                                 std::to_string(fes_s.GetTrueVSize()) + " DOFs for " +
                                 std::to_string(nv) + " vertices");

    const double ell = config.regularization_length > 0.0
                           ? config.regularization_length
                           : mean_element_size(cache.volume);
    const double tau = ell * ell;
    const double dt = config.time_step;

    // M (consistent mass) for the right-hand side, A = M + Δt·τ·L for the update.
    mfem::BilinearForm mass(&fes_s);
    mass.AddDomainIntegrator(new mfem::MassIntegrator());
    mass.Assemble();
    mass.Finalize();
    mfem::ConstantCoefficient diff_coef(dt * tau);
    mfem::BilinearForm op(&fes_s);
    op.AddDomainIntegrator(new mfem::MassIntegrator());
    op.AddDomainIntegrator(new mfem::DiffusionIntegrator(diff_coef));
    op.Assemble();
    op.Finalize();
    const mfem::SparseMatrix& M = mass.SpMat();
    const mfem::SparseMatrix& A = op.SpMat();

    // Start from full material: the reaction term nucleates holes where the
    // structure is least useful, and the volume target walks down to the goal.
    std::vector<double> phi(nv, 1.0);
    apply_pins(phi);
    std::vector<double> rho = level_set_density(mesh, phi);

    // Nodes per element, for the lumped load ∫N_i·d dΩ ≈ Σ_e d_e·V_e / n_e.
    std::vector<mfem::Array<int>> elem_vertices(ne);
    for (int e = 0; e < ne; ++e) mesh.GetElementVertices(e, elem_vertices[e]);

    std::printf("[topopt] level set: l=%.4g (tau=%.4g), dt=%.3g, volume step=%.3g, "
                "E_min/E0=%.1e\n",
                ell, tau, dt, config.volume_step, config.emin_rel);

    LevelSetOptResult result;
    result.history.reserve(config.max_iterations);
    mfem::Vector phi_v(nv), rhs(nv), psi(nv), forcing(nv);
    std::vector<double> phi_trial(nv);

    for (int it = 1;; ++it) {
        // (1) Ersatz-material solve: s(ρ) = E_min/E₀ + ρ·(1 − E_min/E₀), i.e. SIMP
        // with p = 1 on the geometric volume fraction.
        const ComplianceEvaluation ev = evaluate_compliance(
            fespace, cache, ess_tdof, load, rho, /*penalty=*/1.0, config.emin_rel,
            config.cg_rtol);
        result.displacements = ev.displacements;
        const double vol_frac = volume_used(rho, cache.volume) / vtotal;

        // (2) Sensitivity: the strain-energy density of the current (ersatz)
        // material, normalized by its volume-weighted mean so d − λ is O(1)
        // regardless of load and units. Using the full-material energy instead
        // would rate the soft void as highly as the load path — its large strains
        // times E₀ — and refill every hole the step opens.
        std::vector<double> energy(ne);
        double mean_sed = 0.0;
        for (int e = 0; e < ne; ++e) {
            energy[e] = simp_scale(rho[e], 1.0, config.emin_rel) * ev.strain_energy[e];
            mean_sed += energy[e];
        }
        mean_sed /= vtotal;
        if (!(mean_sed > 0.0))
            throw std::runtime_error(
                "optimize_level_set: the strain energy is zero everywhere — the load "
                "does no work on the structure");
        forcing = 0.0;
        for (int e = 0; e < ne; ++e) {
            const double d = energy[e] / cache.volume[e] / mean_sed;
            const double share = d * cache.volume[e] / elem_vertices[e].Size();
            for (const int vi : elem_vertices[e]) forcing[vi] += share;
        }

        // (3) Reaction–diffusion step without the multiplier: A ψ = M φ + Δt·F.
        for (int i = 0; i < nv; ++i) phi_v[i] = phi[i];
        M.Mult(phi_v, rhs);
        rhs.Add(dt, forcing);
        psi = phi_v;
        solve_level_set_system(A, rhs, psi);

        // (4) λ: since A·1 = M·1, the multiplier shifts ψ uniformly by μ = Δt·λ.
        // Bisect μ so the clamped update meets this iteration's volume target.
        const double target = std::max(config.volume_fraction, vol_frac - config.volume_step);
        auto trial_volume = [&](double mu) {
            for (int i = 0; i < nv; ++i)
                phi_trial[i] = std::min(1.0, std::max(-1.0, psi[i] - mu));
            apply_pins(phi_trial);
            return volume_used(level_set_density(mesh, phi_trial), cache.volume) / vtotal;
        };
        double lo = psi.Min() - 1.0;  // every node clamps to +1: full material
        double hi = psi.Max() + 1.0;  // every node clamps to −1: empty
        for (int k = 0; k < 60 && hi - lo > 1e-12; ++k) {
            const double mid = 0.5 * (lo + hi);
            const double v = trial_volume(mid);
            if (std::abs(v - target) < 1e-6) {
                lo = hi = mid;
                break;
            }
            if (v > target) lo = mid;
            else hi = mid;
        }
        trial_volume(0.5 * (lo + hi));
        const std::vector<double> rho_next = level_set_density(mesh, phi_trial);

        double change = 0.0;
        for (int e = 0; e < ne; ++e) change = std::max(change, std::abs(rho_next[e] - rho[e]));

        std::array<char, 128> line;
        std::snprintf(line.data(), line.size(), "[topopt] it %d: c=%.6g vol=%.4f change=%.4g",
                      it, ev.compliance, vol_frac, change);
        std::printf("%s\n", line.data());
        result.history.push_back({it, ev.compliance, vol_frac, change});
        result.iterations = it;

        // Converged once the analysed design meets the volume target and either
        // the element densities stop moving or the compliance has flattened out
        // over the last five iterations (boundary elements can keep trading a
        // sliver of volume indefinitely without changing the design).
        const bool volume_met = std::abs(vol_frac - config.volume_fraction) < 5e-3;
        bool flat = false;
        const int nh = static_cast<int>(result.history.size());
        if (nh >= 6) {
            double cmin = ev.compliance;
            double cmax = ev.compliance;
            for (int k = nh - 6; k < nh; ++k) {
                cmin = std::min(cmin, result.history[k].compliance);
                cmax = std::max(cmax, result.history[k].compliance);
            }
            flat = (cmax - cmin) < 0.1 * config.tolerance * ev.compliance;
        }
        const bool converged = volume_met && (change < config.tolerance || flat);
        const bool last = converged || it >= config.max_iterations;
        config.stream.emit(it, last, rho);
        if (last) {
            result.converged = converged;
            break;
        }
        phi = phi_trial;
        rho = rho_next;
    }

    result.density = rho;
    result.level_set = phi;
    return result;
}

}  // namespace kofem::topopt
