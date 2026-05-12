//! 2D continuum elements (PLPLANE property): CTRIA3 and CQUAD4.
//!
//! DOF order per node: [ux, uy] — 2D Cartesian in the XY plane.
//! Node z-coordinates are ignored; model must be in the global XY plane.
//!
//! References:
//!   Zienkiewicz & Taylor, "The Finite Element Method", Vol 1, 6th ed., Ch. 4-5
//!   Cook et al., "Concepts and Applications of FEA", 4th ed., Ch. 6-7

use super::Element;
use crate::material::IsotropicElastic;
use crate::property::PlaneFormulation;
use nalgebra::DMatrix;

// ─── Constitutive matrices ────────────────────────────────────────────────────

fn plane_stress_d(e: f64, nu: f64) -> [[f64; 3]; 3] {
    let c = e / (1.0 - nu * nu);
    [
        [c, c * nu, 0.0],
        [c * nu, c, 0.0],
        [0.0, 0.0, c * (1.0 - nu) / 2.0],
    ]
}

fn plane_strain_d(e: f64, nu: f64) -> [[f64; 3]; 3] {
    let c = e / ((1.0 + nu) * (1.0 - 2.0 * nu));
    [
        [c * (1.0 - nu), c * nu, 0.0],
        [c * nu, c * (1.0 - nu), 0.0],
        [0.0, 0.0, c * (1.0 - 2.0 * nu) / 2.0],
    ]
}

fn d_mat(mat: &IsotropicElastic, form: PlaneFormulation) -> [[f64; 3]; 3] {
    match form {
        PlaneFormulation::PlaneStress => plane_stress_d(mat.young, mat.poisson),
        PlaneFormulation::PlaneStrain => plane_strain_d(mat.young, mat.poisson),
    }
}

/// Accumulate Bᵀ D B into k.
/// `b_cols[i]` = column i of B, a 3-vector [εxx, εyy, γxy] contribution for DOF i.
fn accumulate_btdb(k: &mut DMatrix<f64>, b_cols: &[[f64; 3]], d: &[[f64; 3]; 3], scale: f64) {
    let n = b_cols.len();
    for i in 0..n {
        for j in 0..n {
            let mut v = 0.0;
            for p in 0..3 {
                for q in 0..3 {
                    v += b_cols[i][p] * d[p][q] * b_cols[j][q];
                }
            }
            k[(i, j)] += scale * v;
        }
    }
}

// ─── CTRIA3 plane (CST — Constant Strain Triangle) ───────────────────────────
//
// 3 nodes × 2 DOF/node = 6 DOF.
// DOF vector: [u1x, u1y, u2x, u2y, u3x, u3y]

pub struct Ctria3PlaneElement {
    pub material: IsotropicElastic,
    pub thickness: f64,
    pub formulation: PlaneFormulation,
}

impl Element for Ctria3PlaneElement {
    fn dof_per_node(&self) -> usize {
        2
    }

    fn stiffness_matrix(&self, nodes: &[[f64; 3]]) -> DMatrix<f64> {
        let (x1, y1) = (nodes[0][0], nodes[0][1]);
        let (x2, y2) = (nodes[1][0], nodes[1][1]);
        let (x3, y3) = (nodes[2][0], nodes[2][1]);

        // Signed area via cross product; positive when nodes are CCW
        let two_a = (x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1);
        let area = two_a.abs() / 2.0;
        let inv2a = 1.0 / two_a; // keeps sign for proper b_i / c_i

        // Cartesian derivatives of shape functions (constant for CST)
        let b1 = (y2 - y3) * inv2a;
        let b2 = (y3 - y1) * inv2a;
        let b3 = (y1 - y2) * inv2a;
        let c1 = (x3 - x2) * inv2a;
        let c2 = (x1 - x3) * inv2a;
        let c3 = (x2 - x1) * inv2a;

        // B columns: b_cols[dof] = [εxx contrib, εyy contrib, γxy contrib]
        // DOF order: [u1x, u1y, u2x, u2y, u3x, u3y]
        let b_cols: [[f64; 3]; 6] = [
            [b1, 0.0, c1], // u1x
            [0.0, c1, b1], // u1y
            [b2, 0.0, c2], // u2x
            [0.0, c2, b2], // u2y
            [b3, 0.0, c3], // u3x
            [0.0, c3, b3], // u3y
        ];

        let d = d_mat(&self.material, self.formulation);
        let mut k = DMatrix::<f64>::zeros(6, 6);
        // K = t × A × Bᵀ D B  (exact — B is constant for CST)
        accumulate_btdb(&mut k, &b_cols, &d, self.thickness * area);
        k
    }

    fn consistent_mass_matrix(&self, nodes: &[[f64; 3]], density: f64) -> DMatrix<f64> {
        let two_a = ((nodes[1][0] - nodes[0][0]) * (nodes[2][1] - nodes[0][1])
            - (nodes[2][0] - nodes[0][0]) * (nodes[1][1] - nodes[0][1]))
            .abs();
        let m_total = density * self.thickness * two_a / 2.0;
        // Consistent mass for CST: M_ij = ρtA/12 * (2 if i==j, 1 if i≠j), block-diag in xy
        let mut m = DMatrix::<f64>::zeros(6, 6);
        let c = m_total / 12.0;
        for i in 0..3 {
            for j in 0..3 {
                let v = if i == j { 2.0 * c } else { c };
                m[(2 * i, 2 * j)] = v;
                m[(2 * i + 1, 2 * j + 1)] = v;
            }
        }
        m
    }
}

// ─── CQUAD4 plane (bilinear isoparametric quad, 2×2 Gauss) ──────────────────
//
// 4 nodes × 2 DOF/node = 8 DOF.
// Node ordering (Nastran, CCW): 1(–,–), 2(+,–), 3(+,+), 4(–,+)
// DOF vector: [u1x, u1y, u2x, u2y, u3x, u3y, u4x, u4y]

// Natural-coordinate corner of each node: [ξ_i, η_i]
const QUAD4_NAT: [[f64; 2]; 4] = [[-1.0, -1.0], [1.0, -1.0], [1.0, 1.0], [-1.0, 1.0]];

// 2-point Gauss: ±1/√3, weight = 1
const GP2: [f64; 2] = [-0.5773502691896258, 0.5773502691896258];

/// Returns [∂N_i/∂ξ, ∂N_i/∂η] for each node i at natural point (xi, eta).
fn quad4_nat_grad(xi: f64, eta: f64) -> [[f64; 2]; 4] {
    let mut g = [[0.0f64; 2]; 4];
    for (i, nc) in QUAD4_NAT.iter().enumerate() {
        g[i][0] = nc[0] * (1.0 + nc[1] * eta) / 4.0; // ∂N_i/∂ξ
        g[i][1] = nc[1] * (1.0 + nc[0] * xi) / 4.0; // ∂N_i/∂η
    }
    g
}

pub struct Cquad4PlaneElement {
    pub material: IsotropicElastic,
    pub thickness: f64,
    pub formulation: PlaneFormulation,
}

impl Element for Cquad4PlaneElement {
    fn dof_per_node(&self) -> usize {
        2
    }

    fn stiffness_matrix(&self, nodes: &[[f64; 3]]) -> DMatrix<f64> {
        let d = d_mat(&self.material, self.formulation);
        let mut k = DMatrix::<f64>::zeros(8, 8);

        for &xi in &GP2 {
            for &eta in &GP2 {
                let gn = quad4_nat_grad(xi, eta);

                // 2×2 Jacobian: J[r][c] = sum_i gn[i][r] * coord[i][c]
                let mut j = [[0.0f64; 2]; 2];
                for i in 0..4 {
                    j[0][0] += gn[i][0] * nodes[i][0];
                    j[0][1] += gn[i][0] * nodes[i][1];
                    j[1][0] += gn[i][1] * nodes[i][0];
                    j[1][1] += gn[i][1] * nodes[i][1];
                }
                let det_j = j[0][0] * j[1][1] - j[0][1] * j[1][0];
                let inv_d = 1.0 / det_j;
                // J^{-1} (2×2 analytic inverse)
                let ji = [
                    [j[1][1] * inv_d, -j[0][1] * inv_d],
                    [-j[1][0] * inv_d, j[0][0] * inv_d],
                ];

                // Physical gradients ∂N_i/∂x, ∂N_i/∂y  = J^{-1} * [∂N/∂ξ, ∂N/∂η]^T
                let mut gp = [[0.0f64; 2]; 4];
                for i in 0..4 {
                    gp[i][0] = ji[0][0] * gn[i][0] + ji[0][1] * gn[i][1]; // ∂N_i/∂x
                    gp[i][1] = ji[1][0] * gn[i][0] + ji[1][1] * gn[i][1]; // ∂N_i/∂y
                }

                // B columns (8 DOF): b_cols[2i] for u_ix, b_cols[2i+1] for u_iy
                let mut b_cols = [[0.0f64; 3]; 8];
                for i in 0..4 {
                    let (nx, ny) = (gp[i][0], gp[i][1]);
                    b_cols[2 * i] = [nx, 0.0, ny]; // u_ix contribution
                    b_cols[2 * i + 1] = [0.0, ny, nx]; // u_iy contribution
                }

                // K += |J| * Bᵀ D B  (Gauss weight = 1 × 1)
                accumulate_btdb(&mut k, &b_cols, &d, self.thickness * det_j.abs());
            }
        }
        k
    }

    fn consistent_mass_matrix(&self, nodes: &[[f64; 3]], density: f64) -> DMatrix<f64> {
        let mut m = DMatrix::<f64>::zeros(8, 8);
        for &xi in &GP2 {
            for &eta in &GP2 {
                // Shape function values at Gauss point
                let n = [
                    (1.0 - xi) * (1.0 - eta) / 4.0,
                    (1.0 + xi) * (1.0 - eta) / 4.0,
                    (1.0 + xi) * (1.0 + eta) / 4.0,
                    (1.0 - xi) * (1.0 + eta) / 4.0,
                ];
                let gn = quad4_nat_grad(xi, eta);
                let mut j = [[0.0f64; 2]; 2];
                for i in 0..4 {
                    j[0][0] += gn[i][0] * nodes[i][0];
                    j[0][1] += gn[i][0] * nodes[i][1];
                    j[1][0] += gn[i][1] * nodes[i][0];
                    j[1][1] += gn[i][1] * nodes[i][1];
                }
                let det_j = (j[0][0] * j[1][1] - j[0][1] * j[1][0]).abs();
                let scale = density * self.thickness * det_j;
                for i in 0..4 {
                    for jj in 0..4 {
                        let v = scale * n[i] * n[jj];
                        m[(2 * i, 2 * jj)] += v;
                        m[(2 * i + 1, 2 * jj + 1)] += v;
                    }
                }
            }
        }
        m
    }
}
