// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Flat-facet Kirchhoff shell element: the OPT membrane with drilling
//! rotations (`shell::membrane`) plus Discrete Kirchhoff Triangle (DKT)
//! bending, 6 DOF per node (u, v, w, θx, θy, θz).
//!
//! References: Batoz, Bathe & Ho (1980), "A study of three-node triangular
//! plate bending elements", IJNME 15, 1771–1812 (the DKT bending stiffness);
//! Felippa (2003), CMAME 192, 2125–2168 (the membrane).

use crate::material::Isotropic;
use crate::mesh::{cross, dot, sub};
use crate::shell::membrane::{OptMembrane, MEMBRANE_DOFS as MEMBRANE_DOF_COUNT};

/// Element DOFs: 6 per node × 3 nodes.
pub const FACET_DOFS: usize = 18;

pub type FacetMatrix = [[f64; FACET_DOFS]; FACET_DOFS];

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

/// Positions of the membrane DOFs (u, v, θz of each node) in the 18-DOF
/// vector.
const MEMBRANE_DOFS: [usize; MEMBRANE_DOF_COUNT] = [0, 1, 5, 6, 7, 11, 12, 13, 17];
/// Positions of the bending DOFs (w, θx, θy of each node).
const BENDING_DOFS: [usize; 9] = [2, 3, 4, 8, 9, 10, 14, 15, 16];

/// The 3×3 maps from a corner's global DOFs to the facet's local ones: the
/// translations onto (e1, e2, e3), the rotation onto (e1, e2) for bending and
/// onto the corner's drilling axis for the membrane.
pub(crate) fn corner_transforms(
    frame: &FacetFrame,
    drilling_axes: &[[f64; 3]; 3],
) -> [[[f64; 3]; 3]; 6] {
    let [e1, e2, _] = frame.axes;
    std::array::from_fn(|block| {
        if block % 2 == 0 {
            frame.axes
        } else {
            [e1, e2, drilling_axes[block / 2]]
        }
    })
}

/// One facet's 18×18 stiffness in global coordinates (DOF order u, v, w, θx,
/// θy, θz per node) — the matrix the shell assembly scatters.
/// `drilling_axes` holds each corner's drilling axis
/// ([`ShellMesh::drilling_normals`](crate::shell::ShellMesh::drilling_normals)):
/// the facet's own normal on a flat region or at a fold.
#[must_use]
pub fn facet_stiffness(
    corners: &[[f64; 3]; 3],
    drilling_axes: &[[f64; 3]; 3],
    thickness: f64,
    material: &Isotropic,
) -> FacetMatrix {
    let frame = FacetFrame::new(corners);
    let poisson = material.poisson();
    let membrane = OptMembrane::new(&frame).stiffness(
        thickness,
        &constitutive(material.young() / (1.0 - poisson * poisson), poisson),
        poisson,
    );
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

    // Global = Tᵀ·local·T with T block-diagonal in the corner transforms:
    // each 3×3 block (a, b) becomes T_aᵀ·local_ab·T_b.
    let transforms = corner_transforms(&frame, drilling_axes);
    let mut global = [[0.0; FACET_DOFS]; FACET_DOFS];
    for (block_row, left) in transforms.iter().enumerate() {
        for (block_col, right) in transforms.iter().enumerate() {
            let (row0, col0) = (3 * block_row, 3 * block_col);
            for i in 0..3 {
                for j in 0..3 {
                    let mut sum = 0.0;
                    for (from, left_row) in left.iter().enumerate() {
                        for (to, right_row) in right.iter().enumerate() {
                            sum += left_row[i] * local[row0 + from][col0 + to] * right_row[j];
                        }
                    }
                    global[row0 + i][col0 + j] = sum;
                }
            }
        }
    }
    RigidProjector::new(corners).project_stiffness(&global)
}

/// The element-independent rigid-body projector P = I − Γ·Ψ (Rankin and
/// Nour-Omid 1988; Felippa and Haugen, CMAME 194 (2005) 2285–2335). Ψ fits a
/// rigid motion to the corners' translations: their mean and the
/// least-squares rotation about the centroid. Γ spreads a rigid motion over
/// the 18 DOFs, u = t + Ω × r, θ = Ω. With the drilling DOF on a smooth
/// surface's axis rather than the facet's own normal, a rigid turn of the
/// facet about an in-plane axis would strain its membrane; projecting the
/// stiffness and the recovered displacements removes the rigid part, so a
/// rigid motion strains nothing. A facet that is already rigid-invariant (its
/// own normal as every drilling axis) is left unchanged.
pub(crate) struct RigidProjector {
    /// Γ, 18×6.
    spread: [[f64; 6]; FACET_DOFS],
    /// Ψ, 6×18.
    fit: [[f64; FACET_DOFS]; 6],
}

impl RigidProjector {
    pub(crate) fn new(corners: &[[f64; 3]; 3]) -> Self {
        let centroid: [f64; 3] = std::array::from_fn(|axis| {
            (corners[0][axis] + corners[1][axis] + corners[2][axis]) / 3.0
        });
        let arms: [[f64; 3]; 3] = corners.map(|corner| sub(corner, centroid));
        // H = Σ (|r|²·I − r·rᵀ), the inertia of the corners about the centroid.
        let mut inertia = [[0.0; 3]; 3];
        for arm in &arms {
            let squared = dot(*arm, *arm);
            for (row, entries) in inertia.iter_mut().enumerate() {
                for (col, entry) in entries.iter_mut().enumerate() {
                    let identity = if row == col { squared } else { 0.0 };
                    *entry += identity - arm[row] * arm[col];
                }
            }
        }
        let inverse = invert3(&inertia);
        let mut spread = [[0.0; 6]; FACET_DOFS];
        let mut fit = [[0.0; FACET_DOFS]; 6];
        for (node, arm) in arms.iter().enumerate() {
            let lever = skew(*arm);
            for axis in 0..3 {
                // t = mean translation.
                fit[axis][6 * node + axis] = 1.0 / 3.0;
                // Ω = H⁻¹·Σ r × u.
                for component in 0..3 {
                    fit[3 + axis][6 * node + component] =
                        (0..3).map(|k| inverse[axis][k] * lever[k][component]).sum();
                }
                // u = t − [r]×·Ω, θ = Ω.
                spread[6 * node + axis][axis] = 1.0;
                for (spin, entry) in lever[axis].iter().enumerate() {
                    spread[6 * node + axis][3 + spin] = -entry;
                }
                spread[6 * node + 3 + axis][3 + axis] = 1.0;
            }
        }
        Self { spread, fit }
    }

    /// Pᵀ·K·P.
    fn project_stiffness(&self, stiffness: &FacetMatrix) -> FacetMatrix {
        let projector = self.matrix();
        let mut half = [[0.0; FACET_DOFS]; FACET_DOFS];
        for (row, entries) in half.iter_mut().enumerate() {
            for (col, entry) in entries.iter_mut().enumerate() {
                *entry = (0..FACET_DOFS)
                    .map(|k| stiffness[row][k] * projector[k][col])
                    .sum();
            }
        }
        std::array::from_fn(|row| {
            std::array::from_fn(|col| {
                (0..FACET_DOFS)
                    .map(|k| projector[k][row] * half[k][col])
                    .sum()
            })
        })
    }

    /// P·u: the facet's DOFs less their rigid motion.
    pub(crate) fn deformation(&self, dofs: &[f64; FACET_DOFS]) -> [f64; FACET_DOFS] {
        let rigid: [f64; 6] = std::array::from_fn(|mode| {
            self.fit[mode]
                .iter()
                .zip(dofs)
                .map(|(entry, value)| entry * value)
                .sum()
        });
        std::array::from_fn(|dof| {
            dofs[dof]
                - (0..6)
                    .map(|mode| self.spread[dof][mode] * rigid[mode])
                    .sum::<f64>()
        })
    }

    fn matrix(&self) -> FacetMatrix {
        std::array::from_fn(|row| {
            std::array::from_fn(|col| {
                let identity = if row == col { 1.0 } else { 0.0 };
                identity
                    - (0..6)
                        .map(|mode| self.spread[row][mode] * self.fit[mode][col])
                        .sum::<f64>()
            })
        })
    }
}

/// [r]×, the matrix of r × ·.
fn skew(arm: [f64; 3]) -> [[f64; 3]; 3] {
    [
        [0.0, -arm[2], arm[1]],
        [arm[2], 0.0, -arm[0]],
        [-arm[1], arm[0], 0.0],
    ]
}

/// The inverse of the corners' inertia, which is positive definite for a
/// facet `ShellMesh` has checked for area.
fn invert3(matrix: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let cofactor = |row: usize, col: usize| {
        let (r1, r2) = ((row + 1) % 3, (row + 2) % 3);
        let (c1, c2) = ((col + 1) % 3, (col + 2) % 3);
        matrix[r1][c1] * matrix[r2][c2] - matrix[r1][c2] * matrix[r2][c1]
    };
    let determinant: f64 = (0..3).map(|col| matrix[0][col] * cofactor(0, col)).sum();
    std::array::from_fn(|row| std::array::from_fn(|col| cofactor(col, row) / determinant))
}

fn scale(vector: [f64; 3], factor: f64) -> [f64; 3] {
    vector.map(|component| component * factor)
}
