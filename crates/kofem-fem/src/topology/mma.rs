// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The Method of Moving Asymptotes, the optimizer of every SIMP formulation
//! (ADR-0002 decision 4). Port of the C++ engine's `topology_mma.cpp`.
//!
//! MMA (K. Svanberg, "The method of moving asymptotes — a new method for
//! structural optimization", Int. J. Numer. Methods Eng. 24:359–373, 1987)
//! solves
//!
//! ```text
//! min f_0(x)  s.t.  f_i(x) ≤ 0 (i = 1..m),  x_min ≤ x ≤ x_max
//! ```
//!
//! by replacing every `f_i` at the iterate with a separable convex
//! approximation built on moving asymptotes `L_j` < `x_j` < `U_j`, and solving that
//! subproblem exactly. This is the classic dense small-m variant of
//! Svanberg's 2007 report "MMA and GCMMA — two methods for nonlinear
//! optimization": `mmasub` forms the subproblem and `subsolv` solves its KKT
//! system with a primal-dual interior-point Newton iteration. The arithmetic
//! follows the C++ engine operation by operation, so both take the same steps.

#![allow(
    clippy::min_ident_chars,
    clippy::many_single_char_names,
    clippy::similar_names,
    reason = "Svanberg's notation (x, y, z, m, n, p, q, b, dely, delz, …), kept letter for \
              letter so the port reads against the reference algorithm and the C++ engine"
)]

use crate::error::FemError;

use super::topology_error;

/// Initial asymptote half-span, × the bound gap.
const ASY_INIT: f64 = 0.5;
/// Asymptote expansion when a variable moves monotonically.
const ASY_INCR: f64 = 1.2;
/// Asymptote contraction when it oscillates.
const ASY_DECR: f64 = 0.7;
/// α/β pull-back fraction toward the asymptotes.
const ALBEFA: f64 = 0.1;
/// Convexity perturbation on p and q.
const RAA0: f64 = 1e-5;
/// The asymptotes stay at least this × the gap from x …
const ASY_BOUND_LO: f64 = 0.01;
/// … and at most this × the gap.
const ASY_BOUND_HI: f64 = 10.0;
/// Interior-point barrier floor.
const EPSI_MIN: f64 = 1e-7;
/// Barrier-reduction steps.
const MAX_OUTER: usize = 30;
/// Newton steps per barrier level.
const MAX_NEWTON: usize = 200;
/// Step halvings per Newton step.
const MAX_LINE_SEARCH: usize = 50;

/// Solve the dense k×k system A·s = rhs (row-major) by Gaussian elimination
/// with partial pivoting; the solution overwrites `rhs`.
fn solve_dense(size: usize, matrix: &mut [f64], rhs: &mut [f64]) -> Result<(), FemError> {
    for col in 0..size {
        let mut pivot = col;
        let mut best = matrix[col * size + col].abs();
        for row in col + 1..size {
            let value = matrix[row * size + col].abs();
            if value > best {
                best = value;
                pivot = row;
            }
        }
        if best == 0.0 {
            return Err(topology_error("MMA subproblem: singular Newton system"));
        }
        if pivot != col {
            for entry in 0..size {
                matrix.swap(col * size + entry, pivot * size + entry);
            }
            rhs.swap(col, pivot);
        }
        let diagonal = matrix[col * size + col];
        for row in col + 1..size {
            let factor = matrix[row * size + col] / diagonal;
            if factor == 0.0 {
                continue;
            }
            for entry in col..size {
                matrix[row * size + entry] -= factor * matrix[col * size + entry];
            }
            rhs[row] -= factor * rhs[col];
        }
    }
    for row in (0..size).rev() {
        let mut sum = rhs[row];
        for col in row + 1..size {
            sum -= matrix[row * size + col] * rhs[col];
        }
        rhs[row] = sum / matrix[row * size + row];
    }
    Ok(())
}

/// The MMA subproblem's data: asymptotes, trust region, approximation
/// coefficients (P, Q row-major m×n) and constraint right-hand sides. The
/// artificial-variable weights are the standard a0 = 1, a = 0, c = 1000,
/// d = 1, for which the optimum leaves y and z at zero.
struct Subproblem<'data> {
    n: usize,
    m: usize,
    low: &'data [f64],
    upp: &'data [f64],
    alfa: &'data [f64],
    beta: &'data [f64],
    p0: &'data [f64],
    q0: &'data [f64],
    p: &'data [f64],
    q: &'data [f64],
    b: &'data [f64],
}

const A0: f64 = 1.0;
const AI: f64 = 0.0;
const CI: f64 = 1000.0;
const DI: f64 = 1.0;

/// The primal-dual point of the interior-point iteration.
#[derive(Clone)]
struct Point {
    x: Vec<f64>,
    y: Vec<f64>,
    z: f64,
    lam: Vec<f64>,
    xsi: Vec<f64>,
    eta: Vec<f64>,
    mu: Vec<f64>,
    zet: f64,
    s: Vec<f64>,
}

impl Subproblem<'_> {
    /// ‖r‖₂ and max|r| of the relaxed KKT residual at `point` for barrier `epsi`.
    fn residual(&self, point: &Point, epsi: f64) -> (f64, f64) {
        let (n, m) = (self.n, self.m);
        let mut squares = 0.0;
        let mut largest = 0.0_f64;
        let mut add = |value: f64| {
            squares += value * value;
            largest = largest.max(value.abs());
        };
        for j in 0..n {
            let mut plam = self.p0[j];
            let mut qlam = self.q0[j];
            for i in 0..m {
                plam += self.p[i * n + j] * point.lam[i];
                qlam += self.q[i * n + j] * point.lam[i];
            }
            let ux1 = self.upp[j] - point.x[j];
            let xl1 = point.x[j] - self.low[j];
            let dpsidx = (plam / (ux1 * ux1)) - (qlam / (xl1 * xl1));
            add(dpsidx - point.xsi[j] + point.eta[j]);
            add((point.xsi[j] * (point.x[j] - self.alfa[j])) - epsi);
            add((point.eta[j] * (self.beta[j] - point.x[j])) - epsi);
        }
        let mut rez = A0 - point.zet;
        for i in 0..m {
            let mut gvec = 0.0;
            for j in 0..n {
                gvec += (self.p[i * n + j] / (self.upp[j] - point.x[j]))
                    + (self.q[i * n + j] / (point.x[j] - self.low[j]));
            }
            add(CI + (DI * point.y[i]) - point.mu[i] - point.lam[i]);
            add(gvec - (AI * point.z) - point.y[i] + point.s[i] - self.b[i]);
            add((point.mu[i] * point.y[i]) - epsi);
            add((point.lam[i] * point.s[i]) - epsi);
            rez -= AI * point.lam[i];
        }
        add(rez);
        add((point.zet * point.z) - epsi);
        (squares.sqrt(), largest)
    }

    /// Svanberg's `subsolv`: the primal x of the subproblem's optimum.
    #[allow(
        clippy::too_many_lines,
        reason = "one Newton step of subsolv, kept whole to mirror the reference algorithm"
    )]
    fn solve(&self) -> Result<Vec<f64>, FemError> {
        let (n, m) = (self.n, self.m);
        let x: Vec<f64> = (0..n)
            .map(|j| f64::midpoint(self.alfa[j], self.beta[j]))
            .collect();
        let xsi = (0..n)
            .map(|j| (1.0 / (x[j] - self.alfa[j])).max(1.0))
            .collect();
        let eta = (0..n)
            .map(|j| (1.0 / (self.beta[j] - x[j])).max(1.0))
            .collect();
        let mut point = Point {
            x,
            y: vec![1.0; m],
            z: 1.0,
            lam: vec![1.0; m],
            xsi,
            eta,
            mu: vec![(0.5 * CI).max(1.0); m],
            zet: 1.0,
            s: vec![1.0; m],
        };

        let mut epsi = 1.0;
        let mut outer = 0;
        while outer < MAX_OUTER && epsi > EPSI_MIN {
            outer += 1;
            let (mut resnorm, mut resmax) = self.residual(&point, epsi);
            let mut newton = 0;
            while newton < MAX_NEWTON && resmax > 0.9 * epsi {
                newton += 1;
                let Point {
                    x,
                    y,
                    z,
                    lam,
                    xsi,
                    eta,
                    mu,
                    zet,
                    s,
                } = &point;
                let (z, zet) = (*z, *zet);
                let mut delx = vec![0.0; n];
                let mut diagx = vec![0.0; n];
                let mut gg = vec![0.0; m * n];
                let mut gvec = vec![0.0; m];
                for j in 0..n {
                    let mut pj = self.p0[j];
                    let mut qj = self.q0[j];
                    for i in 0..m {
                        pj += self.p[i * n + j] * lam[i];
                        qj += self.q[i * n + j] * lam[i];
                    }
                    let ux1 = self.upp[j] - x[j];
                    let xl1 = x[j] - self.low[j];
                    let ux2 = ux1 * ux1;
                    let xl2 = xl1 * xl1;
                    let dpsidx = (pj / ux2) - (qj / xl2);
                    delx[j] =
                        dpsidx - (epsi / (x[j] - self.alfa[j])) + (epsi / (self.beta[j] - x[j]));
                    diagx[j] = (2.0 * ((pj / (ux1 * ux2)) + (qj / (xl1 * xl2))))
                        + (xsi[j] / (x[j] - self.alfa[j]))
                        + (eta[j] / (self.beta[j] - x[j]));
                    for i in 0..m {
                        gg[i * n + j] = (self.p[i * n + j] / ux2) - (self.q[i * n + j] / xl2);
                        gvec[i] += (self.p[i * n + j] / ux1) + (self.q[i * n + j] / xl1);
                    }
                }
                let mut dely = vec![0.0; m];
                let mut diagy = vec![0.0; m];
                let mut dellam = vec![0.0; m];
                let mut diaglamyi = vec![0.0; m];
                for i in 0..m {
                    dely[i] = CI + (DI * y[i]) - lam[i] - (epsi / y[i]);
                    diagy[i] = DI + (mu[i] / y[i]);
                    dellam[i] = gvec[i] - (AI * z) - y[i] - self.b[i] + (epsi / lam[i]);
                    diaglamyi[i] = (s[i] / lam[i]) + (1.0 / diagy[i]);
                }
                let mut delz = A0 - (epsi / z);
                for &multiplier in lam {
                    delz -= AI * multiplier;
                }

                // (m+1)×(m+1) system [[Alam, a], [aᵀ, −zet/z]]·[dlam; dz] = [blam; delz].
                let size = m + 1;
                let mut matrix = vec![0.0; size * size];
                let mut rhs = vec![0.0; size];
                for i in 0..m {
                    let mut blam = dellam[i] + (dely[i] / diagy[i]);
                    for j in 0..n {
                        blam -= gg[i * n + j] * (delx[j] / diagx[j]);
                    }
                    rhs[i] = blam;
                    for r in 0..m {
                        let mut value = 0.0;
                        for j in 0..n {
                            value += gg[i * n + j] * (1.0 / diagx[j]) * gg[r * n + j];
                        }
                        matrix[i * size + r] = value;
                    }
                    matrix[i * size + i] += diaglamyi[i];
                    matrix[i * size + m] = AI;
                    matrix[m * size + i] = AI;
                }
                matrix[m * size + m] = -zet / z;
                rhs[m] = delz;
                solve_dense(size, &mut matrix, &mut rhs)?;
                let dlam = &rhs[..m];
                let dz = rhs[m];

                let mut dx = vec![0.0; n];
                let mut dxsi = vec![0.0; n];
                let mut deta = vec![0.0; n];
                for j in 0..n {
                    let mut gsum = 0.0;
                    for i in 0..m {
                        gsum += gg[i * n + j] * dlam[i];
                    }
                    dx[j] = (-delx[j] - gsum) / diagx[j];
                    dxsi[j] = -xsi[j] + ((epsi - (xsi[j] * dx[j])) / (x[j] - self.alfa[j]));
                    deta[j] = -eta[j] + ((epsi + (eta[j] * dx[j])) / (self.beta[j] - x[j]));
                }
                let mut dy = vec![0.0; m];
                let mut dmu = vec![0.0; m];
                let mut ds = vec![0.0; m];
                for i in 0..m {
                    dy[i] = (-dely[i] + dlam[i]) / diagy[i];
                    dmu[i] = -mu[i] + ((epsi - (mu[i] * dy[i])) / y[i]);
                    ds[i] = -s[i] + ((epsi - (s[i] * dlam[i])) / lam[i]);
                }
                let dzet = -zet + ((epsi - (zet * dz)) / z);

                // Keep every non-negative variable interior (Svanberg's 1.01)
                // and x inside (alfa, beta).
                let ratio = |value: f64, step: f64| -1.01 * step / value;
                let mut stmax = 1.0_f64;
                for i in 0..m {
                    stmax = stmax
                        .max(ratio(y[i], dy[i]))
                        .max(ratio(lam[i], dlam[i]))
                        .max(ratio(mu[i], dmu[i]))
                        .max(ratio(s[i], ds[i]));
                }
                stmax = stmax.max(ratio(z, dz)).max(ratio(zet, dzet));
                for j in 0..n {
                    stmax = stmax
                        .max(ratio(xsi[j], dxsi[j]))
                        .max(ratio(eta[j], deta[j]))
                        .max(-1.01 * dx[j] / (x[j] - self.alfa[j]))
                        .max(1.01 * dx[j] / (self.beta[j] - x[j]));
                }
                let mut steg = 1.0 / stmax;

                // Halve the step until the residual norm decreases.
                let old = point.clone();
                let mut resnew = 2.0 * resnorm;
                let mut newmax = resmax;
                let mut halvings = 0;
                while halvings < MAX_LINE_SEARCH && resnew > resnorm {
                    halvings += 1;
                    for j in 0..n {
                        point.x[j] = old.x[j] + (steg * dx[j]);
                        point.xsi[j] = old.xsi[j] + (steg * dxsi[j]);
                        point.eta[j] = old.eta[j] + (steg * deta[j]);
                    }
                    for i in 0..m {
                        point.y[i] = old.y[i] + (steg * dy[i]);
                        point.lam[i] = old.lam[i] + (steg * dlam[i]);
                        point.mu[i] = old.mu[i] + (steg * dmu[i]);
                        point.s[i] = old.s[i] + (steg * ds[i]);
                    }
                    point.z = old.z + (steg * dz);
                    point.zet = old.zet + (steg * dzet);
                    (resnew, newmax) = self.residual(&point, epsi);
                    steg *= 0.5;
                }
                resnorm = resnew;
                resmax = newmax;
            }
            epsi *= 0.1;
        }
        Ok(point.x)
    }
}

/// One MMA optimization: it keeps the two previous iterates and the current
/// asymptotes, which the asymptote update needs, so one instance drives one
/// run from start to finish.
#[derive(Debug, Clone)]
pub struct Mma {
    n: usize,
    m: usize,
    xmin: Vec<f64>,
    xmax: Vec<f64>,
    move_limit: f64,
    low: Vec<f64>,
    upp: Vec<f64>,
    xold1: Vec<f64>,
    xold2: Vec<f64>,
    iteration: usize,
}

impl Mma {
    /// `n` variables bounded by `xmin` < `xmax`, `m` inequality constraints,
    /// and the move limit: the fraction of the bound gap a variable may move
    /// per iteration (0.2 is the ADR default).
    ///
    /// # Errors
    /// No variables, bounds of the wrong length or without a positive gap,
    /// or a move limit that is not positive.
    pub fn new(
        n: usize,
        m: usize,
        xmin: Vec<f64>,
        xmax: Vec<f64>,
        move_limit: f64,
    ) -> Result<Self, FemError> {
        if n == 0 {
            return Err(topology_error("MMA needs at least one design variable"));
        }
        if xmin.len() != n || xmax.len() != n {
            return Err(topology_error(
                "MMA bound arrays must have one entry per variable",
            ));
        }
        if !(move_limit > 0.0 && move_limit.is_finite()) {
            return Err(topology_error("the MMA move limit must be positive"));
        }
        if let Some(variable) =
            (0..n).find(|&j| !((xmax[j] - xmin[j]).is_finite() && xmax[j] > xmin[j]))
        {
            return Err(topology_error(format!(
                "MMA variable {variable} needs an upper bound above its lower bound"
            )));
        }
        Ok(Self {
            n,
            m,
            xmin,
            xmax,
            move_limit,
            low: vec![0.0; n],
            upp: vec![0.0; n],
            xold1: Vec::new(),
            xold2: Vec::new(),
            iteration: 0,
        })
    }

    /// One MMA step from `x` with the objective gradient `df0`, the `m`
    /// constraint values `fval` and their Jacobian `dfdx` (m×n, row-major).
    /// The objective value `_f0` is an additive constant of the
    /// approximation, so it does not move the step. Returns the next iterate,
    /// within the bounds and the move limit.
    ///
    /// # Errors
    /// Arrays of the wrong length, or a singular subproblem.
    pub fn update(
        &mut self,
        x: &[f64],
        _f0: f64,
        df0: &[f64],
        fval: &[f64],
        dfdx: &[f64],
    ) -> Result<Vec<f64>, FemError> {
        let (n, m) = (self.n, self.m);
        if x.len() != n || df0.len() != n {
            return Err(topology_error(
                "MMA: x and df0 must have one entry per variable",
            ));
        }
        if fval.len() != m {
            return Err(topology_error(
                "MMA: fval must have one entry per constraint",
            ));
        }
        if dfdx.len() != m * n {
            return Err(topology_error("MMA: dfdx must be constraints × variables"));
        }
        self.iteration += 1;

        for j in 0..n {
            let gap = self.xmax[j] - self.xmin[j];
            if self.iteration <= 2 {
                self.low[j] = x[j] - (ASY_INIT * gap);
                self.upp[j] = x[j] + (ASY_INIT * gap);
            } else {
                let trend = (x[j] - self.xold1[j]) * (self.xold1[j] - self.xold2[j]);
                let factor = if trend < 0.0 {
                    ASY_DECR
                } else if trend > 0.0 {
                    ASY_INCR
                } else {
                    1.0
                };
                let mut low = x[j] - (factor * (self.xold1[j] - self.low[j]));
                let mut upp = x[j] + (factor * (self.upp[j] - self.xold1[j]));
                low = low.min(x[j] - (ASY_BOUND_LO * gap));
                low = low.max(x[j] - (ASY_BOUND_HI * gap));
                upp = upp.max(x[j] + (ASY_BOUND_LO * gap));
                upp = upp.min(x[j] + (ASY_BOUND_HI * gap));
                self.low[j] = low;
                self.upp[j] = upp;
            }
        }

        let mut alfa = vec![0.0; n];
        let mut beta = vec![0.0; n];
        for j in 0..n {
            let gap = self.xmax[j] - self.xmin[j];
            alfa[j] = (self.low[j] + (ALBEFA * (x[j] - self.low[j])))
                .max(self.xmin[j])
                .max(x[j] - (self.move_limit * gap));
            beta[j] = (self.upp[j] - (ALBEFA * (self.upp[j] - x[j])))
                .min(self.xmax[j])
                .min(x[j] + (self.move_limit * gap));
        }

        let mut p0 = vec![0.0; n];
        let mut q0 = vec![0.0; n];
        let mut p = vec![0.0; m * n];
        let mut q = vec![0.0; m * n];
        let mut b = vec![0.0; m];
        for j in 0..n {
            let ux1 = self.upp[j] - x[j];
            let xl1 = x[j] - self.low[j];
            let ux2 = ux1 * ux1;
            let xl2 = xl1 * xl1;
            let raa = RAA0 / (self.xmax[j] - self.xmin[j]);
            let d0p = df0[j].max(0.0);
            let d0m = (-df0[j]).max(0.0);
            p0[j] = ux2 * ((1.001 * d0p) + (0.001 * d0m) + raa);
            q0[j] = xl2 * ((0.001 * d0p) + (1.001 * d0m) + raa);
            for i in 0..m {
                let derivative = dfdx[i * n + j];
                let dp = derivative.max(0.0);
                let dm = (-derivative).max(0.0);
                let pij = ux2 * ((1.001 * dp) + (0.001 * dm) + raa);
                let qij = xl2 * ((0.001 * dp) + (1.001 * dm) + raa);
                p[i * n + j] = pij;
                q[i * n + j] = qij;
                b[i] += (pij / ux1) + (qij / xl1);
            }
        }
        for (offset, value) in b.iter_mut().zip(fval) {
            *offset -= value;
        }

        let next = Subproblem {
            n,
            m,
            low: &self.low,
            upp: &self.upp,
            alfa: &alfa,
            beta: &beta,
            p0: &p0,
            q0: &q0,
            p: &p,
            q: &q,
            b: &b,
        }
        .solve()?;
        self.xold2 = std::mem::replace(&mut self.xold1, x.to_vec());
        Ok(next)
    }
}
