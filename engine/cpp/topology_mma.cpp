// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Method of Moving Asymptotes — see topology_mma.h.

#include "topology_mma.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <string>
#include <vector>

namespace kofem::topopt {

namespace {

// ── MMA constants (Svanberg 2007) ────────────────────────────────────────────
constexpr double kAsyInit = 0.5;   // initial asymptote half-span (× bound gap)
constexpr double kAsyIncr = 1.2;   // asymptote expansion when moving monotonically
constexpr double kAsyDecr = 0.7;   // asymptote contraction when oscillating
constexpr double kAlBeFa = 0.1;    // α/β pull-back fraction toward the asymptote
constexpr double kRaa0 = 1e-5;     // convexity perturbation on p/q
constexpr double kAsyBoundLo = 0.01;  // asymptote must stay ≥ this × gap from x
constexpr double kAsyBoundHi = 10.0;  // …and ≤ this × gap from x
constexpr double kEpsiMin = 1e-7;     // interior-point barrier floor
constexpr int kMaxOuter = 30;         // barrier-reduction steps
constexpr int kMaxNewton = 200;       // Newton steps per barrier level
constexpr int kMaxLineSearch = 50;    // step halvings per Newton step

// Solve the dense k×k system A·s = rhs by Gaussian elimination with partial
// pivoting (k = m+1 is tiny — one plus the constraint count). A and rhs are
// row-major and consumed in place; the solution overwrites `rhs`.
void solve_dense(int k, std::vector<double>& A, std::vector<double>& rhs) {
    for (int col = 0; col < k; ++col) {
        int pivot = col;
        double best = std::abs(A[(col * k) + col]);
        for (int r = col + 1; r < k; ++r) {
            const double v = std::abs(A[(r * k) + col]);
            if (v > best) {
                best = v;
                pivot = r;
            }
        }
        if (best == 0.0)
            throw std::runtime_error("MMA subproblem: singular Newton system");
        if (pivot != col) {
            for (int c = 0; c < k; ++c)
                std::swap(A[(col * k) + c], A[(pivot * k) + c]);
            std::swap(rhs[col], rhs[pivot]);
        }
        const double diag = A[(col * k) + col];
        for (int r = col + 1; r < k; ++r) {
            const double factor = A[(r * k) + col] / diag;
            if (factor == 0.0) continue;
            for (int c = col; c < k; ++c) A[(r * k) + c] -= factor * A[(col * k) + c];
            rhs[r] -= factor * rhs[col];
        }
    }
    for (int row = k - 1; row >= 0; --row) {
        double sum = rhs[row];
        for (int c = row + 1; c < k; ++c) sum -= A[(row * k) + c] * rhs[c];
        rhs[row] = sum / A[(row * k) + row];
    }
}

// The MMA subproblem (Svanberg's `subsolv`): minimize the separable convex
// approximation over x ∈ [alfa, beta] plus the artificial variables y, z, solved
// to KKT stationarity by a primal-dual interior-point Newton iteration with the
// barrier parameter epsi driven from 1 down to kEpsiMin. Returns the primal x.
//
// P, Q are the m×n approximation coefficients (row-major); p0, q0 the objective's;
// b the constraint right-hand sides; a0, a, c, d the artificial-variable weights.
std::vector<double> subsolv(int n, int m, const std::vector<double>& low,
                            const std::vector<double>& upp,
                            const std::vector<double>& alfa,
                            const std::vector<double>& beta,
                            const std::vector<double>& p0,
                            const std::vector<double>& q0,
                            const std::vector<double>& P, const std::vector<double>& Q,
                            double a0, const std::vector<double>& a,
                            const std::vector<double>& b, const std::vector<double>& c,
                            const std::vector<double>& d) {
    std::vector<double> x(n);
    for (int j = 0; j < n; ++j) x[j] = 0.5 * (alfa[j] + beta[j]);
    std::vector<double> y(m, 1.0);
    double z = 1.0;
    std::vector<double> lam(m, 1.0);
    std::vector<double> xsi(n), eta(n);
    for (int j = 0; j < n; ++j) {
        xsi[j] = std::max(1.0, 1.0 / (x[j] - alfa[j]));
        eta[j] = std::max(1.0, 1.0 / (beta[j] - x[j]));
    }
    std::vector<double> mu(m);
    for (int i = 0; i < m; ++i) mu[i] = std::max(1.0, 0.5 * c[i]);
    double zet = 1.0;
    std::vector<double> s(m, 1.0);

    // Residual of the relaxed KKT system at the current point, for a given barrier
    // epsi. Writes ‖r‖₂ into *norm and max|r| into *rmax.
    auto residual = [&](double epsi, double* norm, double* rmax) {
        double n2 = 0.0;
        double rmx = 0.0;
        auto acc = [&](double r) {
            n2 += r * r;
            rmx = std::max(rmx, std::abs(r));
        };
        // plam_j = p0_j + Σ_i P_ij·lam_i,  qlam_j = q0_j + Σ_i Q_ij·lam_i
        for (int j = 0; j < n; ++j) {
            double plam = p0[j];
            double qlam = q0[j];
            for (int i = 0; i < m; ++i) {
                plam += P[(i * n) + j] * lam[i];
                qlam += Q[(i * n) + j] * lam[i];
            }
            const double ux1 = upp[j] - x[j];
            const double xl1 = x[j] - low[j];
            const double dpsidx = (plam / (ux1 * ux1)) - (qlam / (xl1 * xl1));
            acc(dpsidx - xsi[j] + eta[j]);                  // rex_j
            acc((xsi[j] * (x[j] - alfa[j])) - epsi);        // rexsi_j
            acc((eta[j] * (beta[j] - x[j])) - epsi);        // reeta_j
        }
        double rez = a0 - zet;
        for (int i = 0; i < m; ++i) {
            double gvec = 0.0;
            for (int j = 0; j < n; ++j)
                gvec += (P[(i * n) + j] / (upp[j] - x[j])) +
                        (Q[(i * n) + j] / (x[j] - low[j]));
            acc(c[i] + (d[i] * y[i]) - mu[i] - lam[i]);          // rey_i
            acc(gvec - (a[i] * z) - y[i] + s[i] - b[i]);         // relam_i
            acc((mu[i] * y[i]) - epsi);                          // remu_i
            acc((lam[i] * s[i]) - epsi);                         // res_i
            rez -= a[i] * lam[i];
        }
        acc(rez);                        // rez
        acc((zet * z) - epsi);           // rezet
        *norm = std::sqrt(n2);
        *rmax = rmx;
    };

    double epsi = 1.0;
    for (int outer = 0; outer < kMaxOuter && epsi > kEpsiMin; ++outer) {
        double resnorm = 0.0;
        double resmax = 0.0;
        residual(epsi, &resnorm, &resmax);

        for (int newton = 0; newton < kMaxNewton && resmax > 0.9 * epsi; ++newton) {
            // Build the Newton direction. GG_ij = ∂g_i/∂x_j; the x-block is diagonal
            // (diagx), so it is eliminated into an (m+1)×(m+1) system for (dlam, dz).
            std::vector<double> plam(n), qlam(n), dpsidx(n), delx(n), diagx(n);
            std::vector<double> GG(static_cast<std::size_t>(m) * n);
            std::vector<double> gvec(m, 0.0);
            for (int j = 0; j < n; ++j) {
                double pj = p0[j];
                double qj = q0[j];
                for (int i = 0; i < m; ++i) {
                    pj += P[(i * n) + j] * lam[i];
                    qj += Q[(i * n) + j] * lam[i];
                }
                plam[j] = pj;
                qlam[j] = qj;
                const double ux1 = upp[j] - x[j];
                const double xl1 = x[j] - low[j];
                const double ux2 = ux1 * ux1;
                const double xl2 = xl1 * xl1;
                dpsidx[j] = (pj / ux2) - (qj / xl2);
                delx[j] = dpsidx[j] - (epsi / (x[j] - alfa[j])) + (epsi / (beta[j] - x[j]));
                diagx[j] = (2.0 * ((pj / (ux1 * ux2)) + (qj / (xl1 * xl2)))) +
                           (xsi[j] / (x[j] - alfa[j])) + (eta[j] / (beta[j] - x[j]));
                for (int i = 0; i < m; ++i) {
                    GG[(i * n) + j] = (P[(i * n) + j] / ux2) - (Q[(i * n) + j] / xl2);
                    gvec[i] += (P[(i * n) + j] / ux1) + (Q[(i * n) + j] / xl1);
                }
            }

            std::vector<double> dely(m), diagy(m), dellam(m), diaglamyi(m);
            for (int i = 0; i < m; ++i) {
                dely[i] = c[i] + (d[i] * y[i]) - lam[i] - (epsi / y[i]);
                diagy[i] = d[i] + (mu[i] / y[i]);
                dellam[i] = gvec[i] - (a[i] * z) - y[i] - b[i] + (epsi / lam[i]);
                diaglamyi[i] = (s[i] / lam[i]) + (1.0 / diagy[i]);
            }
            double delz = a0 - (epsi / z);
            for (int i = 0; i < m; ++i) delz -= a[i] * lam[i];

            // (m+1)×(m+1) system: [[Alam, a],[aᵀ, -zet/z]] · [dlam; dz] = [blam; delz]
            const int k = m + 1;
            std::vector<double> AA(static_cast<std::size_t>(k) * k, 0.0);
            std::vector<double> bb(k);
            for (int i = 0; i < m; ++i) {
                double blam = dellam[i] + (dely[i] / diagy[i]);
                for (int j = 0; j < n; ++j) blam -= GG[(i * n) + j] * (delx[j] / diagx[j]);
                bb[i] = blam;
                // Alam = diag(diaglamyi) + GG·diag(1/diagx)·GGᵀ
                for (int r = 0; r < m; ++r) {
                    double v = 0.0;
                    for (int j = 0; j < n; ++j)
                        v += GG[(i * n) + j] * (1.0 / diagx[j]) * GG[(r * n) + j];
                    AA[(i * k) + r] = v;
                }
                AA[(i * k) + i] += diaglamyi[i];
                AA[(i * k) + m] = a[i];
                AA[(m * k) + i] = a[i];
            }
            AA[(m * k) + m] = -zet / z;
            bb[m] = delz;
            solve_dense(k, AA, bb);

            std::vector<double> dlam(m);
            for (int i = 0; i < m; ++i) dlam[i] = bb[i];
            const double dz = bb[m];

            std::vector<double> dx(n), dxsi(n), deta(n);
            for (int j = 0; j < n; ++j) {
                double gsum = 0.0;
                for (int i = 0; i < m; ++i) gsum += GG[(i * n) + j] * dlam[i];
                dx[j] = (-delx[j] - gsum) / diagx[j];
                dxsi[j] = -xsi[j] + ((epsi - (xsi[j] * dx[j])) / (x[j] - alfa[j]));
                deta[j] = -eta[j] + ((epsi + (eta[j] * dx[j])) / (beta[j] - x[j]));
            }
            std::vector<double> dy(m), dmu(m), ds(m);
            for (int i = 0; i < m; ++i) {
                dy[i] = (-dely[i] + dlam[i]) / diagy[i];
                dmu[i] = -mu[i] + ((epsi - (mu[i] * dy[i])) / y[i]);
                ds[i] = -s[i] + ((epsi - (s[i] * dlam[i])) / lam[i]);
            }
            const double dzet = -zet + ((epsi - (zet * dz)) / z);

            // Step length: keep every non-negative variable interior (the 1.01
            // factor is Svanberg's) and x inside (alfa, beta).
            double stmax = 1.0;
            auto ratio = [&](double val, double dval) {
                stmax = std::max(stmax, -1.01 * dval / val);
            };
            for (int i = 0; i < m; ++i) {
                ratio(y[i], dy[i]);
                ratio(lam[i], dlam[i]);
                ratio(mu[i], dmu[i]);
                ratio(s[i], ds[i]);
            }
            ratio(z, dz);
            ratio(zet, dzet);
            for (int j = 0; j < n; ++j) {
                ratio(xsi[j], dxsi[j]);
                ratio(eta[j], deta[j]);
                stmax = std::max(stmax, -1.01 * dx[j] / (x[j] - alfa[j]));
                stmax = std::max(stmax, 1.01 * dx[j] / (beta[j] - x[j]));
            }
            double steg = 1.0 / stmax;

            // Line search: halve the step until the residual norm decreases.
            const std::vector<double> xo = x, yo = y, lamo = lam, xsio = xsi, etao = eta,
                                      muo = mu, so = s;
            const double zo = z, zeto = zet;
            double resnew = 2.0 * resnorm;
            double newmax = resmax;
            for (int ls = 0; ls < kMaxLineSearch && resnew > resnorm; ++ls) {
                for (int j = 0; j < n; ++j) {
                    x[j] = xo[j] + (steg * dx[j]);
                    xsi[j] = xsio[j] + (steg * dxsi[j]);
                    eta[j] = etao[j] + (steg * deta[j]);
                }
                for (int i = 0; i < m; ++i) {
                    y[i] = yo[i] + (steg * dy[i]);
                    lam[i] = lamo[i] + (steg * dlam[i]);
                    mu[i] = muo[i] + (steg * dmu[i]);
                    s[i] = so[i] + (steg * ds[i]);
                }
                z = zo + (steg * dz);
                zet = zeto + (steg * dzet);
                residual(epsi, &resnew, &newmax);
                steg *= 0.5;
            }
            resnorm = resnew;
            resmax = newmax;
        }
        epsi *= 0.1;
    }
    return x;
}

}  // namespace

MMAOptimizer::MMAOptimizer(int n, int m, std::vector<double> xmin, std::vector<double> xmax,
                           double move_limit)
    : n_(n),
      m_(m),
      xmin_(std::move(xmin)),
      xmax_(std::move(xmax)),
      move_(move_limit),
      low_(static_cast<std::size_t>(n)),
      upp_(static_cast<std::size_t>(n)) {
    if (n <= 0) throw std::runtime_error("MMAOptimizer: n must be positive");
    if (m < 0) throw std::runtime_error("MMAOptimizer: m must be non-negative");
    if (static_cast<int>(xmin_.size()) != n || static_cast<int>(xmax_.size()) != n)
        throw std::runtime_error("MMAOptimizer: bound arrays must have length n");
    if (!(move_ > 0.0)) throw std::runtime_error("MMAOptimizer: move_limit must be positive");
    for (int j = 0; j < n; ++j)
        if (!(xmax_[j] > xmin_[j]))
            throw std::runtime_error("MMAOptimizer: require xmax > xmin for variable " +
                                     std::to_string(j));
}

std::vector<double> MMAOptimizer::update(const std::vector<double>& x,
                                         [[maybe_unused]] double f0,
                                         const std::vector<double>& df0,
                                         const std::vector<double>& fval,
                                         const std::vector<double>& dfdx) {
    // f0 completes the "objective returns (value, gradient)" contract and is what
    // the caller already has; the MMA subproblem needs only the gradient df0 (the
    // objective value is an additive constant of the approximation that does not
    // move its minimizer), so f0 itself is intentionally unused here.
    if (static_cast<int>(x.size()) != n_ || static_cast<int>(df0.size()) != n_)
        throw std::runtime_error("MMAOptimizer::update: x/df0 must have length n");
    if (static_cast<int>(fval.size()) != m_)
        throw std::runtime_error("MMAOptimizer::update: fval must have length m");
    if (dfdx.size() != static_cast<std::size_t>(m_) * static_cast<std::size_t>(n_))
        throw std::runtime_error("MMAOptimizer::update: dfdx must be m×n");

    ++iter_;
    const int n = n_;
    const int m = m_;

    // ── Moving asymptotes L, U ────────────────────────────────────────────────
    if (iter_ <= 2) {
        for (int j = 0; j < n; ++j) {
            const double gap = xmax_[j] - xmin_[j];
            low_[j] = x[j] - (kAsyInit * gap);
            upp_[j] = x[j] + (kAsyInit * gap);
        }
    } else {
        for (int j = 0; j < n; ++j) {
            const double gap = xmax_[j] - xmin_[j];
            const double trend = (x[j] - xold1_[j]) * (xold1_[j] - xold2_[j]);
            double factor = 1.0;
            if (trend < 0.0)
                factor = kAsyDecr;
            else if (trend > 0.0)
                factor = kAsyIncr;
            low_[j] = x[j] - (factor * (xold1_[j] - low_[j]));
            upp_[j] = x[j] + (factor * (upp_[j] - xold1_[j]));
            low_[j] = std::min(low_[j], x[j] - (kAsyBoundLo * gap));
            low_[j] = std::max(low_[j], x[j] - (kAsyBoundHi * gap));
            upp_[j] = std::max(upp_[j], x[j] + (kAsyBoundLo * gap));
            upp_[j] = std::min(upp_[j], x[j] + (kAsyBoundHi * gap));
        }
    }

    // ── Trust region α ≤ x ≤ β (asymptote pull-back, bounds and move limit) ───
    std::vector<double> alfa(n), beta(n);
    for (int j = 0; j < n; ++j) {
        const double gap = xmax_[j] - xmin_[j];
        alfa[j] = std::max({low_[j] + (kAlBeFa * (x[j] - low_[j])), xmin_[j],
                            x[j] - (move_ * gap)});
        beta[j] = std::min({upp_[j] - (kAlBeFa * (upp_[j] - x[j])), xmax_[j],
                            x[j] + (move_ * gap)});
    }

    // ── Convex approximation coefficients p, q and constraint offsets b ───────
    std::vector<double> p0(n), q0(n);
    std::vector<double> P(static_cast<std::size_t>(m) * n);
    std::vector<double> Q(static_cast<std::size_t>(m) * n);
    std::vector<double> b(m, 0.0);
    for (int j = 0; j < n; ++j) {
        const double ux1 = upp_[j] - x[j];
        const double xl1 = x[j] - low_[j];
        const double ux2 = ux1 * ux1;
        const double xl2 = xl1 * xl1;
        const double raa = kRaa0 / (xmax_[j] - xmin_[j]);
        const double d0p = std::max(df0[j], 0.0);
        const double d0m = std::max(-df0[j], 0.0);
        p0[j] = ux2 * ((1.001 * d0p) + (0.001 * d0m) + raa);
        q0[j] = xl2 * ((0.001 * d0p) + (1.001 * d0m) + raa);
        for (int i = 0; i < m; ++i) {
            const double dij = dfdx[(i * n) + j];
            const double dp = std::max(dij, 0.0);
            const double dm = std::max(-dij, 0.0);
            const double pij = ux2 * ((1.001 * dp) + (0.001 * dm) + raa);
            const double qij = xl2 * ((0.001 * dp) + (1.001 * dm) + raa);
            P[(i * n) + j] = pij;
            Q[(i * n) + j] = qij;
            b[i] += (pij / ux1) + (qij / xl1);
        }
    }
    for (int i = 0; i < m; ++i) b[i] -= fval[i];

    // Standard artificial-variable weights: a0 = 1, a = 0, c = 1000, d = 1.
    const double a0 = 1.0;
    const std::vector<double> a(m, 0.0);
    const std::vector<double> c(m, 1000.0);
    const std::vector<double> d(m, 1.0);

    std::vector<double> xnew =
        subsolv(n, m, low_, upp_, alfa, beta, p0, q0, P, Q, a0, a, b, c, d);

    xold2_ = xold1_;
    xold1_ = x;
    return xnew;
}

}  // namespace kofem::topopt
