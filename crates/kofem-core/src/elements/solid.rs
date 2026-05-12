//! 3D solid/continuum elements (PSOLID property): CTETRA, CPENTA, CHEXA.
//!
//! DOF order per node: [ux, uy, uz] — 3 translational, no rotations.
//!
//! References:
//!   Zienkiewicz & Taylor, "The Finite Element Method", Vol 1, 6th ed., Ch. 8-9
//!   Hughes, "The Finite Element Method", Ch. 3-4

use super::Element;
use crate::material::IsotropicElastic;
use nalgebra::DMatrix;

// ─── 3D constitutive matrix ───────────────────────────────────────────────────
// 6-component strain/stress: [εxx, εyy, εzz, γxy, γyz, γzx]

fn solid_d(mat: &IsotropicElastic) -> [[f64; 6]; 6] {
    mat.constitutive_3d()
}

/// Accumulate Bᵀ D B into k.
/// `b_cols[i]` = column i of B, a 6-vector [εxx, εyy, εzz, γxy, γyz, γzx] for DOF i.
fn accumulate_btdb_6(k: &mut DMatrix<f64>, b_cols: &[[f64; 6]], d: &[[f64; 6]; 6], scale: f64) {
    let n = b_cols.len();
    for i in 0..n {
        for j in 0..n {
            let mut v = 0.0;
            for p in 0..6 {
                for q in 0..6 {
                    v += b_cols[i][p] * d[p][q] * b_cols[j][q];
                }
            }
            k[(i, j)] += scale * v;
        }
    }
}

/// Build B columns for one node given its physical gradients [∂N/∂x, ∂N/∂y, ∂N/∂z].
/// Strain ordering: [εxx, εyy, εzz, γxy, γyz, γzx]
fn node_b_cols(nx: f64, ny: f64, nz: f64) -> [[f64; 6]; 3] {
    [
        [nx, 0.0, 0.0, ny, 0.0, nz], // u_x DOF
        [0.0, ny, 0.0, nx, nz, 0.0], // u_y DOF
        [0.0, 0.0, nz, 0.0, ny, nx], // u_z DOF
    ]
}

// ─── CTETRA4 (4-node linear tetrahedron, constant strain) ────────────────────
//
// 4 nodes × 3 DOF/node = 12 DOF.
// Nastran node ordering: 1-2-3 form base (CCW when viewed from 4), 4 is apex.
// B is constant → exact integration, K = V × Bᵀ D B.

pub struct Ctetra4Element {
    pub material: IsotropicElastic,
}

impl Element for Ctetra4Element {
    fn dof_per_node(&self) -> usize {
        3
    }

    fn stiffness_matrix(&self, nodes: &[[f64; 3]]) -> DMatrix<f64> {
        let [p1, p2, p3, p4] = [nodes[0], nodes[1], nodes[2], nodes[3]];

        // Jacobian: J[row] = node_i - node_1, for i = 2,3,4
        // J * [∂N/∂ξ, ∂N/∂η, ∂N/∂ζ]^T = [∂x/∂ξ, ∂y/∂η, ∂z/∂ζ]
        // J = [x2-x1  y2-y1  z2-z1]
        //     [x3-x1  y3-y1  z3-z1]
        //     [x4-x1  y4-y1  z4-z1]
        let jm = [
            [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]],
            [p3[0] - p1[0], p3[1] - p1[1], p3[2] - p1[2]],
            [p4[0] - p1[0], p4[1] - p1[1], p4[2] - p1[2]],
        ];
        let det_j = det3(&jm);
        let volume = det_j.abs() / 6.0;

        // J^{-1} via cofactors / det
        let ji = inv3(&jm, det_j);

        // Natural gradients for linear tet:
        // ∇_ξ N1 = [-1,-1,-1], N2 = [1,0,0], N3 = [0,1,0], N4 = [0,0,1]
        let nat_grads: [[f64; 3]; 4] = [
            [-1.0, -1.0, -1.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ];

        // Physical gradients: ∇_x N_i = J^{-1} * ∇_ξ N_i
        // (∇_x N_i)_j = sum_k J^{-1}_{jk} * (∇_ξ N_i)_k
        // Note: since J * ∇_x N = ∇_ξ N, we solve: ∇_x N = J^{-1} ∇_ξ N
        let mut phys_grads = [[0.0f64; 3]; 4];
        for i in 0..4 {
            for r in 0..3 {
                for k in 0..3 {
                    phys_grads[i][r] += ji[r][k] * nat_grads[i][k];
                }
            }
        }

        // Build 12 B columns (3 per node)
        let mut b_cols = [[0.0f64; 6]; 12];
        for i in 0..4 {
            let [nx, ny, nz] = phys_grads[i];
            let cols = node_b_cols(nx, ny, nz);
            for (k, col) in cols.iter().enumerate() {
                b_cols[3 * i + k] = *col;
            }
        }

        let d = solid_d(&self.material);
        let mut k = DMatrix::<f64>::zeros(12, 12);
        accumulate_btdb_6(&mut k, &b_cols, &d, volume);
        k
    }

    fn consistent_mass_matrix(&self, nodes: &[[f64; 3]], density: f64) -> DMatrix<f64> {
        let [p1, p2, p3, p4] = [nodes[0], nodes[1], nodes[2], nodes[3]];
        let jm = [
            [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]],
            [p3[0] - p1[0], p3[1] - p1[1], p3[2] - p1[2]],
            [p4[0] - p1[0], p4[1] - p1[1], p4[2] - p1[2]],
        ];
        let volume = det3(&jm).abs() / 6.0;
        let m_total = density * volume;
        // Consistent mass for linear tet: M_ij = ρV/20 * (2 if i==j, 1 if i≠j), per translation
        let mut m = DMatrix::<f64>::zeros(12, 12);
        let c = m_total / 20.0;
        for i in 0..4 {
            for j in 0..4 {
                let v = if i == j { 2.0 * c } else { c };
                m[(3 * i, 3 * j)] = v;
                m[(3 * i + 1, 3 * j + 1)] = v;
                m[(3 * i + 2, 3 * j + 2)] = v;
            }
        }
        m
    }
}

// ─── CHEXA8 (8-node trilinear hexahedron, 2×2×2 Gauss) ──────────────────────
//
// 8 nodes × 3 DOF/node = 24 DOF.
// Node ordering (Nastran): nodes 1-4 bottom face (CCW from below), 5-8 top face.
//   1(-,-,-) 2(+,-,-) 3(+,+,-) 4(-,+,-)
//   5(-,-,+) 6(+,-,+) 7(+,+,+) 8(-,+,+)

const HEX8_NAT: [[f64; 3]; 8] = [
    [-1.0, -1.0, -1.0],
    [1.0, -1.0, -1.0],
    [1.0, 1.0, -1.0],
    [-1.0, 1.0, -1.0],
    [-1.0, -1.0, 1.0],
    [1.0, -1.0, 1.0],
    [1.0, 1.0, 1.0],
    [-1.0, 1.0, 1.0],
];

// 2-point Gauss: ±1/√3, weight = 1
const GP2: [f64; 2] = [-0.5773502691896258, 0.5773502691896258];

/// Returns [∂N_i/∂ξ, ∂N_i/∂η, ∂N_i/∂ζ] for each of 8 nodes.
fn hex8_nat_grad(xi: f64, eta: f64, zeta: f64) -> [[f64; 3]; 8] {
    let mut g = [[0.0f64; 3]; 8];
    for (i, nc) in HEX8_NAT.iter().enumerate() {
        let (xi_i, eta_i, zeta_i) = (nc[0], nc[1], nc[2]);
        g[i][0] = xi_i * (1.0 + eta_i * eta) * (1.0 + zeta_i * zeta) / 8.0;
        g[i][1] = eta_i * (1.0 + xi_i * xi) * (1.0 + zeta_i * zeta) / 8.0;
        g[i][2] = zeta_i * (1.0 + xi_i * xi) * (1.0 + eta_i * eta) / 8.0;
    }
    g
}

pub struct Chexa8Element {
    pub material: IsotropicElastic,
}

impl Element for Chexa8Element {
    fn dof_per_node(&self) -> usize {
        3
    }

    fn stiffness_matrix(&self, nodes: &[[f64; 3]]) -> DMatrix<f64> {
        let d = solid_d(&self.material);
        let mut k = DMatrix::<f64>::zeros(24, 24);

        for &xi in &GP2 {
            for &eta in &GP2 {
                for &zeta in &GP2 {
                    let gn = hex8_nat_grad(xi, eta, zeta);

                    // 3×3 Jacobian: J[r][c] = sum_i gn[i][r] * nodes[i][c]
                    let mut jm = [[0.0f64; 3]; 3];
                    for i in 0..8 {
                        for r in 0..3 {
                            for c in 0..3 {
                                jm[r][c] += gn[i][r] * nodes[i][c];
                            }
                        }
                    }
                    let det_j = det3(&jm);
                    let ji = inv3(&jm, det_j);

                    // Physical gradients: ∇_x N_i = J^{-1} ∇_ξ N_i
                    let mut gp = [[0.0f64; 3]; 8];
                    for i in 0..8 {
                        for r in 0..3 {
                            for k2 in 0..3 {
                                gp[i][r] += ji[r][k2] * gn[i][k2];
                            }
                        }
                    }

                    // B columns (24 DOF, 3 per node)
                    let mut b_cols = [[0.0f64; 6]; 24];
                    for i in 0..8 {
                        let [nx, ny, nz] = gp[i];
                        let cols = node_b_cols(nx, ny, nz);
                        for (kk, col) in cols.iter().enumerate() {
                            b_cols[3 * i + kk] = *col;
                        }
                    }

                    // K += |J| * Bᵀ D B  (Gauss weight = 1×1×1)
                    accumulate_btdb_6(&mut k, &b_cols, &d, det_j.abs());
                }
            }
        }
        k
    }

    fn consistent_mass_matrix(&self, nodes: &[[f64; 3]], density: f64) -> DMatrix<f64> {
        let mut m = DMatrix::<f64>::zeros(24, 24);

        for &xi in &GP2 {
            for &eta in &GP2 {
                for &zeta in &GP2 {
                    // Shape function values at Gauss point
                    let mut n = [0.0f64; 8];
                    for (i, nc) in HEX8_NAT.iter().enumerate() {
                        n[i] =
                            (1.0 + nc[0] * xi) * (1.0 + nc[1] * eta) * (1.0 + nc[2] * zeta) / 8.0;
                    }
                    let gn = hex8_nat_grad(xi, eta, zeta);
                    let mut jm = [[0.0f64; 3]; 3];
                    for i in 0..8 {
                        for r in 0..3 {
                            for c in 0..3 {
                                jm[r][c] += gn[i][r] * nodes[i][c];
                            }
                        }
                    }
                    let scale = density * det3(&jm).abs();
                    for i in 0..8 {
                        for j in 0..8 {
                            let v = scale * n[i] * n[j];
                            m[(3 * i, 3 * j)] += v;
                            m[(3 * i + 1, 3 * j + 1)] += v;
                            m[(3 * i + 2, 3 * j + 2)] += v;
                        }
                    }
                }
            }
        }
        m
    }
}

// ─── CPENTA6 stub (6-node wedge) ─────────────────────────────────────────────
pub struct Cpenta6Element {
    pub material: IsotropicElastic,
}

impl Element for Cpenta6Element {
    fn dof_per_node(&self) -> usize {
        3
    }
    fn stiffness_matrix(&self, _nodes: &[[f64; 3]]) -> DMatrix<f64> {
        // TODO: triangular-prism isoparametric formulation
        DMatrix::<f64>::zeros(18, 18)
    }
    fn consistent_mass_matrix(&self, _nodes: &[[f64; 3]], _density: f64) -> DMatrix<f64> {
        DMatrix::<f64>::zeros(18, 18)
    }
}

// ─── CPYRAM5 stub (5-node pyramid) ───────────────────────────────────────────
pub struct Cpyram5Element {
    pub material: IsotropicElastic,
}

impl Element for Cpyram5Element {
    fn dof_per_node(&self) -> usize {
        3
    }
    fn stiffness_matrix(&self, _nodes: &[[f64; 3]]) -> DMatrix<f64> {
        // TODO: degenerate hex isoparametric formulation
        DMatrix::<f64>::zeros(15, 15)
    }
    fn consistent_mass_matrix(&self, _nodes: &[[f64; 3]], _density: f64) -> DMatrix<f64> {
        DMatrix::<f64>::zeros(15, 15)
    }
}

// ─── Linear algebra helpers ───────────────────────────────────────────────────

fn det3(m: &[[f64; 3]; 3]) -> f64 {
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
}

fn inv3(m: &[[f64; 3]; 3], det: f64) -> [[f64; 3]; 3] {
    let id = 1.0 / det;
    [
        [
            (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * id,
            (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * id,
            (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * id,
        ],
        [
            (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * id,
            (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * id,
            (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * id,
        ],
        [
            (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * id,
            (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * id,
            (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * id,
        ],
    ]
}
