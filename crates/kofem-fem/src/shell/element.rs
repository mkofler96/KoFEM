// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Flat-facet Kirchhoff shell element: constant-strain-triangle (CST)
//! membrane plus Discrete Kirchhoff Triangle (DKT) bending, 6 DOF per node
//! (u, v, w, θx, θy, θz). A port of the C++ engine's `shell_element.cpp`; the
//! two must give the same matrices.
//!
//! References: Batoz, Bathe & Ho (1980), "A study of three-node triangular
//! plate bending elements", IJNME 15, 1771–1812 (the DKT bending stiffness).
//! The membrane is the standard CST plane-stress triangle.

use crate::material::Isotropic;
use crate::mesh::{cross, dot, sub};

/// Element DOFs: 6 per node × 3 nodes.
pub const FACET_DOFS: usize = 18;

pub type FacetMatrix = [[f64; FACET_DOFS]; FACET_DOFS];

/// Fictitious drilling (θz) stiffness relative to the mean bending diagonal.
/// It removes the coplanar in-plane rotation singularity; no load excites it
/// on a flat facet.
const DRILLING_RATIO: f64 = 1e-4;

/// Local orthonormal frame of a facet: e1 along P0→P1, e3 the unit normal,
/// e2 = e3 × e1; the corners in that frame (corner 0 at the origin, corner 1
/// on the e1 axis) and the area.
pub(crate) struct FacetFrame {
    /// Rows e1, e2, e3: local vector = axes · global vector.
    pub axes: [[f64; 3]; 3],
    pub local_x: [f64; 3],
    pub local_y: [f64; 3],
    pub area: f64,
}

impl FacetFrame {
    /// The frame of a facet that `ShellMesh` has checked for area.
    pub fn new(corners: &[[f64; 3]; 3]) -> Self {
        let first = sub(corners[1], corners[0]);
        let second = sub(corners[2], corners[0]);
        let length = dot(first, first).sqrt();
        let e1 = scale(first, 1.0 / length);
        let normal = cross(first, second);
        let twice_area = dot(normal, normal).sqrt();
        let e3 = scale(normal, 1.0 / twice_area);
        let e2 = cross(e3, e1);
        Self {
            axes: [e1, e2, e3],
            local_x: [0.0, length, dot(second, e1)],
            local_y: [0.0, 0.0, dot(second, e2)],
            area: 0.5 * twice_area,
        }
    }
}

/// Plane-stress constitutive matrix scaled by `factor`:
/// factor · [[1, ν, 0], [ν, 1, 0], [0, 0, (1−ν)/2]]. With factor E/(1−ν²) it
/// is the membrane law; with the flexural rigidity Et³/(12(1−ν²)) the bending
/// law.
pub(crate) fn constitutive(factor: f64, poisson: f64) -> [[f64; 3]; 3] {
    [
        [factor, factor * poisson, 0.0],
        [factor * poisson, factor, 0.0],
        [0.0, 0.0, factor * (1.0 - poisson) / 2.0],
    ]
}

/// CST strain–displacement matrix (3×6, local DOF order u0,v0,u1,v1,u2,v2).
pub(crate) fn membrane_b(frame: &FacetFrame) -> [[f64; 6]; 3] {
    let (lx, ly) = (&frame.local_x, &frame.local_y);
    // b_i = y_j − y_k, c_i = x_k − x_j (cyclic).
    let b_coef = [ly[1] - ly[2], ly[2] - ly[0], ly[0] - ly[1]];
    let c_coef = [lx[2] - lx[1], lx[0] - lx[2], lx[1] - lx[0]];
    let inv_twice_area = 1.0 / (2.0 * frame.area);
    let mut matrix = [[0.0; 6]; 3];
    for i in 0..3 {
        matrix[0][2 * i] = b_coef[i] * inv_twice_area;
        matrix[1][2 * i + 1] = c_coef[i] * inv_twice_area;
        matrix[2][2 * i] = c_coef[i] * inv_twice_area;
        matrix[2][2 * i + 1] = b_coef[i] * inv_twice_area;
    }
    matrix
}

/// Bᵀ·D·B scaled by `weight`, added into `out`.
fn add_btdb<const N: usize>(
    out: &mut [[f64; N]; N],
    strain: &[[f64; N]; 3],
    law: &[[f64; 3]; 3],
    weight: f64,
) {
    let mut law_strain = [[0.0; N]; 3];
    for (row, entries) in law_strain.iter_mut().enumerate() {
        for (col, entry) in entries.iter_mut().enumerate() {
            *entry = law[row][0] * strain[0][col]
                + law[row][1] * strain[1][col]
                + law[row][2] * strain[2][col];
        }
    }
    for (row, out_row) in out.iter_mut().enumerate() {
        for (col, entry) in out_row.iter_mut().enumerate() {
            let mut sum = 0.0;
            for i in 0..3 {
                sum += strain[i][row] * law_strain[i][col];
            }
            *entry += weight * sum;
        }
    }
}

/// CST membrane stiffness (6×6): t·A·Bᵀ·D·B.
fn membrane_stiffness(frame: &FacetFrame, thickness: f64, material: &Isotropic) -> [[f64; 6]; 6] {
    let (young, poisson) = (material.young(), material.poisson());
    let law = constitutive(young / (1.0 - poisson * poisson), poisson);
    let mut matrix = [[0.0; 6]; 6];
    add_btdb(
        &mut matrix,
        &membrane_b(frame),
        &law,
        thickness * frame.area,
    );
    matrix
}

/// Batoz side coefficients a, b, c, d, e (in that order), each indexed by
/// side: 0 ↔ side 2-3, 1 ↔ side 3-1, 2 ↔ side 1-2.
struct DktSides([[f64; 3]; 5]);

impl DktSides {
    fn new(frame: &FacetFrame) -> Self {
        let (lx, ly) = (&frame.local_x, &frame.local_y);
        let xij = [lx[1] - lx[2], lx[2] - lx[0], lx[0] - lx[1]];
        let yij = [ly[1] - ly[2], ly[2] - ly[0], ly[0] - ly[1]];
        let mut coef = [[0.0; 3]; 5];
        for k in 0..3 {
            let length_squared = xij[k] * xij[k] + yij[k] * yij[k];
            coef[0][k] = -xij[k] / length_squared;
            coef[1][k] = 0.75 * xij[k] * yij[k] / length_squared;
            coef[2][k] = (0.25 * xij[k] * xij[k] - 0.5 * yij[k] * yij[k]) / length_squared;
            coef[3][k] = -yij[k] / length_squared;
            coef[4][k] = (0.25 * yij[k] * yij[k] - 0.5 * xij[k] * xij[k]) / length_squared;
        }
        Self(coef)
    }

    /// One derivative (ξ or η) of the DKT rotation interpolations Hx and Hy,
    /// from the same derivative of the six quadratic shape functions (corners
    /// 1–3, mid-sides 4 = 23, 5 = 31, 6 = 12).
    fn h_derivative(&self, shape: &[f64; 6]) -> ([f64; 9], [f64; 9]) {
        let [sa, sb, sc, sd, se] = &self.0;
        let n = shape;
        let hx = [
            1.5 * (sa[2] * n[5] - sa[1] * n[4]),
            sb[2] * n[5] + sb[1] * n[4],
            n[0] - sc[2] * n[5] - sc[1] * n[4],
            1.5 * (sa[0] * n[3] - sa[2] * n[5]),
            sb[0] * n[3] + sb[2] * n[5],
            n[1] - sc[0] * n[3] - sc[2] * n[5],
            1.5 * (sa[1] * n[4] - sa[0] * n[3]),
            sb[1] * n[4] + sb[0] * n[3],
            n[2] - sc[1] * n[4] - sc[0] * n[3],
        ];
        let hy = [
            1.5 * (sd[2] * n[5] - sd[1] * n[4]),
            -n[0] + se[2] * n[5] + se[1] * n[4],
            -sb[2] * n[5] - sb[1] * n[4],
            1.5 * (sd[0] * n[3] - sd[2] * n[5]),
            -n[1] + se[0] * n[3] + se[2] * n[5],
            -sb[0] * n[3] - sb[2] * n[5],
            1.5 * (sd[1] * n[4] - sd[0] * n[3]),
            -n[2] + se[1] * n[4] + se[0] * n[3],
            -sb[1] * n[4] - sb[0] * n[3],
        ];
        (hx, hy)
    }
}

/// DKT curvature–displacement matrix κ = B·`u_b` (3×9, local DOF order
/// w0,θx0,θy0,w1,…) at the parametric point (ξ, η).
pub(crate) fn dkt_curvature_b(frame: &FacetFrame, xi: f64, eta: f64) -> [[f64; 9]; 3] {
    let sides = DktSides::new(frame);
    let (lx, ly) = (&frame.local_x, &frame.local_y);
    let det = 2.0 * frame.area;
    // ∂(ξ, η)/∂x and ∂(ξ, η)/∂y.
    let along_x = [(ly[2] - ly[0]) / det, -(ly[1] - ly[0]) / det];
    let along_y = [-(lx[2] - lx[0]) / det, (lx[1] - lx[0]) / det];
    // Quadratic shape functions N1..N6 and their derivatives in ξ (= L2) and
    // η (= L3), L1 = 1 − ξ − η.
    let shape_xi = [
        4.0 * xi + 4.0 * eta - 3.0,
        4.0 * xi - 1.0,
        0.0,
        4.0 * eta,
        -4.0 * eta,
        4.0 - 8.0 * xi - 4.0 * eta,
    ];
    let shape_eta = [
        4.0 * xi + 4.0 * eta - 3.0,
        0.0,
        4.0 * eta - 1.0,
        4.0 * xi,
        4.0 - 4.0 * xi - 8.0 * eta,
        -4.0 * xi,
    ];
    // (Hx, Hy) differentiated by ξ, then by η.
    let by_xi = sides.h_derivative(&shape_xi);
    let by_eta = sides.h_derivative(&shape_eta);
    let physical = |parametric: (&[f64; 9], &[f64; 9]), along: &[f64; 2], i: usize| {
        parametric.0[i] * along[0] + parametric.1[i] * along[1]
    };
    let hx = (&by_xi.0, &by_eta.0);
    let hy = (&by_xi.1, &by_eta.1);
    // κxx = ∂Hx/∂x, κyy = ∂Hy/∂y, 2κxy = ∂Hx/∂y + ∂Hy/∂x.
    [
        std::array::from_fn(|i| physical(hx, &along_x, i)),
        std::array::from_fn(|i| physical(hy, &along_y, i)),
        std::array::from_fn(|i| physical(hx, &along_y, i) + physical(hy, &along_x, i)),
    ]
}

/// DKT bending stiffness (9×9), integrated with the 3-point mid-edge rule.
fn bending_stiffness(frame: &FacetFrame, thickness: f64, material: &Isotropic) -> [[f64; 9]; 9] {
    let (young, poisson) = (material.young(), material.poisson());
    let rigidity = young * thickness.powi(3) / (12.0 * (1.0 - poisson * poisson));
    let law = constitutive(rigidity, poisson);
    let mut matrix = [[0.0; 9]; 9];
    for [xi, eta] in [[0.5, 0.0], [0.0, 0.5], [0.5, 0.5]] {
        add_btdb(
            &mut matrix,
            &dkt_curvature_b(frame, xi, eta),
            &law,
            frame.area / 3.0,
        );
    }
    matrix
}

/// Positions of the membrane DOFs (u, v of each node) in the 18-DOF vector.
const MEMBRANE_DOFS: [usize; 6] = [0, 1, 6, 7, 12, 13];
/// Positions of the bending DOFs (w, θx, θy of each node).
const BENDING_DOFS: [usize; 9] = [2, 3, 4, 8, 9, 10, 14, 15, 16];

/// One facet's 18×18 stiffness in global coordinates (DOF order u, v, w, θx,
/// θy, θz per node), including the drilling stabilisation — the matrix the
/// shell assembly scatters.
#[must_use]
pub fn facet_stiffness(
    corners: &[[f64; 3]; 3],
    thickness: f64,
    material: &Isotropic,
) -> FacetMatrix {
    let frame = FacetFrame::new(corners);
    let membrane = membrane_stiffness(&frame, thickness, material);
    let bending = bending_stiffness(&frame, thickness, material);

    let mut local = [[0.0; FACET_DOFS]; FACET_DOFS];
    for (i, &row) in MEMBRANE_DOFS.iter().enumerate() {
        for (j, &col) in MEMBRANE_DOFS.iter().enumerate() {
            local[row][col] += membrane[i][j];
        }
    }
    for (i, &row) in BENDING_DOFS.iter().enumerate() {
        for (j, &col) in BENDING_DOFS.iter().enumerate() {
            local[row][col] += bending[i][j];
        }
    }
    let bending_trace: f64 = (0..9).map(|i| bending[i][i]).sum();
    let drilling = DRILLING_RATIO * bending_trace / 9.0;
    for node in 0..3 {
        local[6 * node + 5][6 * node + 5] += drilling;
    }

    // Global = Tᵀ·local·T with T block-diagonal in the 3×3 rotation Q (rows
    // e1, e2, e3): each 3×3 block (a, b) becomes Qᵀ·local_ab·Q.
    let rotation = &frame.axes;
    let mut global = [[0.0; FACET_DOFS]; FACET_DOFS];
    for block_row in 0..6 {
        for block_col in 0..6 {
            let (row0, col0) = (3 * block_row, 3 * block_col);
            let mut rotated = [[0.0; 3]; 3];
            for (i, entries) in rotated.iter_mut().enumerate() {
                for (j, entry) in entries.iter_mut().enumerate() {
                    *entry = (0..3)
                        .map(|k| local[row0 + i][col0 + k] * rotation[k][j])
                        .sum();
                }
            }
            for i in 0..3 {
                for j in 0..3 {
                    global[row0 + i][col0 + j] =
                        (0..3).map(|k| rotation[k][i] * rotated[k][j]).sum();
                }
            }
        }
    }
    global
}

fn scale(vector: [f64; 3], factor: f64) -> [f64; 3] {
    vector.map(|component| component * factor)
}
