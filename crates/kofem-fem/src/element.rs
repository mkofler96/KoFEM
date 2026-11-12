// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-FileCopyrightText: 2010-2024 Lawrence Livermore National Security, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later AND BSD-3-Clause

//! Linear (4-node) and quadratic (10-node) tetrahedra, and linear (8-node)
//! and quadratic (27-node) hexahedra. The stiffness of each is
//!
//! ```text
//! K_ab[i][j] = ∫ ( λ·g_a[i]·g_b[j] + μ·g_a[j]·g_b[i] + μ·δ_ij·(g_a · g_b) ) dV
//! ```
//!
//! where `g_a` is the physical gradient of shape function `a`. A linear tet
//! has constant gradients, so one evaluation times the volume is exact. A
//! quadratic tet (straight-sided, so its Jacobian is constant) has linear
//! gradients and a quadratic integrand, which the 4-point degree-2 rule
//! integrates exactly — the same rule order MFEM picks (2·order − 2).
//!
//! A hex maps the unit cube [0, 1]³ trilinearly onto its eight corners (the
//! extra nodes of a 27-node hex sit where that map puts the edge midpoints,
//! face centres and centre, so its geometry stays trilinear). Its Lagrange
//! shape functions are tensor products of 1D ones on {0, 1} or {0, ½, 1}.
//! The Jacobian varies over a distorted hex, so the integrand is rational
//! and no rule is exact; the stiffness uses MFEM's choice, the tensor
//! Gauss–Legendre rule of order 2·(order + 1): 3³ points for an 8-node hex,
//! 4³ for a 27-node one.
//!
//! MFEM reference: `ElasticityIntegrator::AssembleElementMatrix` in
//! `fem/bilininteg.cpp` (MFEM v4.7), with its integration order
//! `2·OrderGrad` from `IsoparametricTransformation::OrderGrad` in
//! `fem/eltrans.cpp` and the tensor rules of `fem/intrules.cpp`; the order-2
//! `H1_TetrahedronElement` nodal basis (corners and edge midpoints) and the
//! `H1_HexahedronElement` bases of order 1 and 2 (whose Gauss–Lobatto nodes
//! are 0, ½ and 1). MFEM copyright (c) 2010-2024, Lawrence Livermore National
//! Security, LLC. All rights reserved. See `../NOTICE.md` and
//! `../LICENSE-MFEM` (BSD-3-Clause).

use crate::material::Isotropic;
use crate::mesh::{
    cross, determinant, dot, signed_volume, sub, EDGES_OF_HEX, EDGES_OF_TET, FACES_OF_HEX,
};

/// Element stiffness, 12×12 with DOFs ordered (node, component): row
/// 3·a + i is component i of corner a.
pub type Tet4Stiffness = [[f64; 12]; 12];

/// Quadratic element stiffness, 30×30, ordered like [`Tet4Stiffness`] over
/// the four corners and then the six edge nodes in `EDGES_OF_TET` order.
pub type Tet10Stiffness = [[f64; 30]; 30];

/// Barycentric coordinates of the element centre.
pub const CENTROID: [f64; 4] = [0.25; 4];

/// Barycentric points of the symmetric 4-point rule, exact for quadratics;
/// each carries a quarter of the volume.
fn degree_two_points() -> [[f64; 4]; 4] {
    let near = (5.0 - 5.0_f64.sqrt()) / 20.0;
    let far = 1.0 - 3.0 * near;
    let mut points = [[near; 4]; 4];
    for (corner, point) in points.iter_mut().enumerate() {
        point[corner] = far;
    }
    points
}

/// Physical gradients of the four shape functions, and the element volume.
/// Independent of winding: a negative-volume element gives the same result.
#[must_use]
pub fn tet4_gradients(corners: &[[f64; 3]; 4]) -> ([[f64; 3]; 4], f64) {
    let six_volume = 6.0 * signed_volume(corners);
    // With edges e_a = x_a − x_0, ∇N_1 = (e_2 × e_3)/6V and cyclically; ∇N_0
    // follows from the partition of unity (the gradients sum to zero).
    let edge1 = sub(corners[1], corners[0]);
    let edge2 = sub(corners[2], corners[0]);
    let edge3 = sub(corners[3], corners[0]);
    let scale = |vector: [f64; 3]| vector.map(|component| component / six_volume);
    let grad1 = scale(cross(edge2, edge3));
    let grad2 = scale(cross(edge3, edge1));
    let grad3 = scale(cross(edge1, edge2));
    let grad0 = [
        -(grad1[0] + grad2[0] + grad3[0]),
        -(grad1[1] + grad2[1] + grad3[1]),
        -(grad1[2] + grad2[2] + grad3[2]),
    ];
    ([grad0, grad1, grad2, grad3], six_volume.abs() / 6.0)
}

/// Physical gradients of the ten quadratic shape functions at the
/// barycentric point `point`, from the corner gradients `g` of
/// [`tet4_gradients`], with `L` the barycentric coordinates. Corner a has
/// `N = L_a·(2·L_a − 1)`, so `∇N = (4·L_a − 1)·g_a`; the node on edge (a, b)
/// has `N = 4·L_a·L_b`, so `∇N = 4·(L_a·g_b + L_b·g_a)`.
#[must_use]
pub fn tet10_gradients(corner_gradients: &[[f64; 3]; 4], point: [f64; 4]) -> [[f64; 3]; 10] {
    let mut gradients = [[0.0; 3]; 10];
    for (corner, gradient) in corner_gradients.iter().enumerate() {
        let scale = 4.0 * point[corner] - 1.0;
        gradients[corner] = gradient.map(|component| scale * component);
    }
    for (edge, [first, second]) in EDGES_OF_TET.into_iter().enumerate() {
        let (lhs, rhs) = (corner_gradients[first], corner_gradients[second]);
        gradients[4 + edge] =
            [0, 1, 2].map(|axis| 4.0 * (point[first] * rhs[axis] + point[second] * lhs[axis]));
    }
    gradients
}

/// Add `weight` × the isotropic-elasticity integrand at one point to a
/// stiffness of `N` nodes, given that point's shape-function gradients.
fn add_point<const N: usize, const DOFS: usize>(
    stiffness: &mut [[f64; DOFS]; DOFS],
    gradients: &[[f64; 3]; N],
    weight: f64,
    material: &Isotropic,
) {
    let (lambda, mu) = material.lame();
    for (node_a, grad_a) in gradients.iter().enumerate() {
        for (node_b, grad_b) in gradients.iter().enumerate() {
            let shared = mu * dot(*grad_a, *grad_b);
            for row in 0..3 {
                for col in 0..3 {
                    let diagonal = if row == col { shared } else { 0.0 };
                    stiffness[3 * node_a + row][3 * node_b + col] += weight
                        * (lambda * grad_a[row] * grad_b[col]
                            + mu * grad_a[col] * grad_b[row]
                            + diagonal);
                }
            }
        }
    }
}

#[must_use]
pub fn tet4_stiffness(corners: &[[f64; 3]; 4], material: &Isotropic) -> Tet4Stiffness {
    let (grads, volume) = tet4_gradients(corners);
    let mut stiffness = [[0.0; 12]; 12];
    add_point(&mut stiffness, &grads, volume, material);
    stiffness
}

/// Stiffness of a straight-sided quadratic tet with corners `corners`.
#[must_use]
pub fn tet10_stiffness(corners: &[[f64; 3]; 4], material: &Isotropic) -> Tet10Stiffness {
    let (corner_gradients, volume) = tet4_gradients(corners);
    let mut stiffness = [[0.0; 30]; 30];
    for point in degree_two_points() {
        let gradients = tet10_gradients(&corner_gradients, point);
        add_point(&mut stiffness, &gradients, 0.25 * volume, material);
    }
    stiffness
}

/// Linear hex stiffness, 24×24, ordered like [`Tet4Stiffness`] over the
/// eight corners.
pub type Hex8Stiffness = [[f64; 24]; 24];

/// Quadratic hex stiffness, 81×81, ordered like [`Tet4Stiffness`] over the
/// 27 nodes: corners, edges in `EDGES_OF_HEX` order, faces in `FACES_OF_HEX`
/// order, centre.
pub type Hex27Stiffness = [[f64; 81]; 81];

/// Reference coordinates (in the unit cube) of the hex corners, in MFEM /
/// CHEXA order.
pub const HEX_CORNERS: [[u8; 3]; 8] = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
];

/// Reference point of the hex centre, where stresses are recovered.
pub const HEX_CENTRE: [f64; 3] = [0.5; 3];

/// Reference position of each 27-node hex node, in halves (0, 1 or 2 for the
/// coordinates 0, ½ and 1): the mean of the corners of its corner, edge, face
/// or the whole cell.
fn hex27_half_positions() -> [[u8; 3]; 27] {
    let mean = |corners: &[usize]| -> [u8; 3] {
        let mut sum = [0_u8; 3];
        for &corner in corners {
            for (axis, total) in sum.iter_mut().enumerate() {
                *total += HEX_CORNERS[corner][axis];
            }
        }
        #[allow(
            clippy::cast_possible_truncation,
            reason = "an entity has at most eight corners"
        )]
        let count = corners.len() as u8;
        sum.map(|total| 2 * total / count)
    };
    let mut positions = [[0_u8; 3]; 27];
    for (corner, position) in positions.iter_mut().take(8).enumerate() {
        *position = mean(&[corner]);
    }
    for (edge, corners) in EDGES_OF_HEX.iter().enumerate() {
        positions[8 + edge] = mean(corners);
    }
    for (face, corners) in FACES_OF_HEX.iter().enumerate() {
        positions[20 + face] = mean(corners);
    }
    positions[26] = mean(&[0, 1, 2, 3, 4, 5, 6, 7]);
    positions
}

/// 1D linear Lagrange function of node `node` (0 or 1) and its derivative.
fn linear_basis(node: u8, coordinate: f64) -> (f64, f64) {
    if node == 0 {
        (1.0 - coordinate, -1.0)
    } else {
        (coordinate, 1.0)
    }
}

/// 1D quadratic Lagrange function on the nodes {0, ½, 1} of the node at
/// `half`/2, and its derivative.
fn quadratic_basis(half: u8, coordinate: f64) -> (f64, f64) {
    let point = coordinate;
    match half {
        0 => ((2.0 * point - 1.0) * (point - 1.0), 4.0 * point - 3.0),
        1 => (4.0 * point * (1.0 - point), 4.0 - 8.0 * point),
        _ => (point * (2.0 * point - 1.0), 4.0 * point - 1.0),
    }
}

/// Values and reference gradients of tensor-product shape functions whose
/// 1D factors `basis` gives for each node's per-axis index in `positions`.
fn tensor_shape<const N: usize>(
    positions: &[[u8; 3]; N],
    basis: fn(u8, f64) -> (f64, f64),
    point: [f64; 3],
) -> ([f64; N], [[f64; 3]; N]) {
    let mut values = [0.0; N];
    let mut gradients = [[0.0; 3]; N];
    for (node, position) in positions.iter().enumerate() {
        let factors: [(f64, f64); 3] =
            std::array::from_fn(|axis| basis(position[axis], point[axis]));
        values[node] = factors[0].0 * factors[1].0 * factors[2].0;
        gradients[node] = [
            factors[0].1 * factors[1].0 * factors[2].0,
            factors[0].0 * factors[1].1 * factors[2].0,
            factors[0].0 * factors[1].0 * factors[2].1,
        ];
    }
    (values, gradients)
}

/// Gradients, in the unit-cube coordinates, of the eight trilinear shape
/// functions at reference point `point`.
#[must_use]
pub fn hex8_reference_gradients(point: [f64; 3]) -> [[f64; 3]; 8] {
    tensor_shape(&HEX_CORNERS, linear_basis, point).1
}

/// Gradients, in the unit-cube coordinates, of the 27 triquadratic shape
/// functions at reference point `point`, in 27-node order.
#[must_use]
pub fn hex27_reference_gradients(point: [f64; 3]) -> [[f64; 3]; 27] {
    tensor_shape(&hex27_half_positions(), quadratic_basis, point).1
}

/// Jacobian `∂x_i/∂ξ_j` of the trilinear map of a hex with corners `corners`,
/// given the trilinear reference gradients at the point.
#[must_use]
pub fn hex_jacobian(corners: &[[f64; 3]; 8], gradients: &[[f64; 3]; 8]) -> [[f64; 3]; 3] {
    let mut jacobian = [[0.0; 3]; 3];
    for (corner, gradient) in corners.iter().zip(gradients) {
        for (row, entries) in jacobian.iter_mut().enumerate() {
            for (col, entry) in entries.iter_mut().enumerate() {
                *entry += corner[row] * gradient[col];
            }
        }
    }
    jacobian
}

/// Physical gradients of shape functions whose reference gradients at
/// `point` are `reference`, on the hex with corners `corners`, and |det J|
/// there (the volume scale). Independent of the hex's handedness.
#[must_use]
pub fn hex_gradients<const N: usize>(
    corners: &[[f64; 3]; 8],
    reference: &[[f64; 3]; N],
    point: [f64; 3],
) -> ([[f64; 3]; N], f64) {
    let jacobian = hex_jacobian(corners, &hex8_reference_gradients(point));
    let det = determinant(&jacobian);
    // (J⁻¹)ᵀ by cofactors: row k of J⁻¹ᵀ is (col_{k+1} × col_{k+2}) / det,
    // with col_j the columns of J (∂x/∂ξ_j).
    let column = |axis: usize| [jacobian[0][axis], jacobian[1][axis], jacobian[2][axis]];
    let dual: [[f64; 3]; 3] = std::array::from_fn(|axis| {
        cross(column((axis + 1) % 3), column((axis + 2) % 3)).map(|entry| entry / det)
    });
    // ∇N = Σ_j ∂N/∂ξ_j · ∇ξ_j, and ∇ξ_j is dual[j].
    let gradients = reference.map(|local| {
        std::array::from_fn(|axis| {
            (0..3)
                .map(|ref_axis| local[ref_axis] * dual[ref_axis][axis])
                .sum()
        })
    });
    (gradients, det.abs())
}

/// Gauss–Legendre points and weights on [0, 1], for 2, 3 or 4 points.
fn gauss_legendre(count: usize) -> Vec<(f64, f64)> {
    let symmetric: Vec<(f64, f64)> = match count {
        2 => vec![(1.0 / 3.0_f64.sqrt(), 1.0)],
        3 => vec![(0.0, 8.0 / 9.0), ((3.0_f64 / 5.0).sqrt(), 5.0 / 9.0)],
        4 => {
            let offset = 2.0 * (6.0_f64 / 5.0).sqrt();
            let root = 30.0_f64.sqrt();
            vec![
                (((3.0 - offset) / 7.0).sqrt(), (18.0 + root) / 36.0),
                (((3.0 + offset) / 7.0).sqrt(), (18.0 - root) / 36.0),
            ]
        }
        _ => unreachable!("Gauss–Legendre rules of 2 to 4 points only"),
    };
    // Points ±t on [−1, 1] map to (1 ± t)/2 on [0, 1], weights halve.
    let mut rule = Vec::with_capacity(count);
    for (offset, weight) in symmetric {
        if offset == 0.0 {
            rule.push((0.5, 0.5 * weight));
        } else {
            rule.push((f64::midpoint(1.0, -offset), 0.5 * weight));
            rule.push((f64::midpoint(1.0, offset), 0.5 * weight));
        }
    }
    rule
}

/// The tensor Gauss–Legendre rule of `count`³ points on the unit cube.
pub(crate) fn cube_rule(count: usize) -> Vec<([f64; 3], f64)> {
    let line = gauss_legendre(count);
    let mut rule = Vec::with_capacity(count.pow(3));
    for &(along_z, weight_z) in &line {
        for &(along_y, weight_y) in &line {
            for &(along_x, weight_x) in &line {
                rule.push(([along_x, along_y, along_z], weight_x * weight_y * weight_z));
            }
        }
    }
    rule
}

/// The tensor Gauss–Legendre rule of `count`² points on the unit square.
pub(crate) fn square_rule(count: usize) -> Vec<([f64; 2], f64)> {
    let line = gauss_legendre(count);
    let mut rule = Vec::with_capacity(count.pow(2));
    for &(along_t, weight_t) in &line {
        for &(along_s, weight_s) in &line {
            rule.push(([along_s, along_t], weight_s * weight_t));
        }
    }
    rule
}

fn hex_stiffness<const N: usize, const DOFS: usize>(
    corners: &[[f64; 3]; 8],
    material: &Isotropic,
    points_per_axis: usize,
    reference_gradients: fn([f64; 3]) -> [[f64; 3]; N],
) -> [[f64; DOFS]; DOFS] {
    let mut stiffness = [[0.0; DOFS]; DOFS];
    for (point, weight) in cube_rule(points_per_axis) {
        let (gradients, scale) = hex_gradients(corners, &reference_gradients(point), point);
        add_point(&mut stiffness, &gradients, weight * scale, material);
    }
    stiffness
}

/// Stiffness of an 8-node hex with corners `corners` (3³-point rule).
#[must_use]
pub fn hex8_stiffness(corners: &[[f64; 3]; 8], material: &Isotropic) -> Hex8Stiffness {
    hex_stiffness(corners, material, 3, hex8_reference_gradients)
}

/// Stiffness of a 27-node hex with corners `corners` (4³-point rule).
#[must_use]
pub fn hex27_stiffness(corners: &[[f64; 3]; 8], material: &Isotropic) -> Hex27Stiffness {
    hex_stiffness(corners, material, 4, hex27_reference_gradients)
}

/// Values of the shape functions of a quadrilateral face at `point` of the
/// unit square, for a face whose corners run (0,0), (1,0), (1,1), (0,1): the
/// four bilinear ones, or the nine biquadratic ones ordered corners, then the
/// edge nodes between consecutive corners, then the centre.
#[must_use]
pub fn quad_face_shape(quadratic: bool, point: [f64; 2]) -> Vec<f64> {
    // Per-axis node indices (halves for quadratic) in the order above.
    const CORNERS: [[u8; 2]; 4] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const NINE: [[u8; 2]; 9] = [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
        [1, 0],
        [2, 1],
        [1, 2],
        [0, 1],
        [1, 1],
    ];
    if quadratic {
        NINE.iter()
            .map(|node| quadratic_basis(node[0], point[0]).0 * quadratic_basis(node[1], point[1]).0)
            .collect()
    } else {
        CORNERS
            .iter()
            .map(|node| linear_basis(node[0], point[0]).0 * linear_basis(node[1], point[1]).0)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn steel() -> Isotropic {
        Isotropic::new(0, 210_000.0, 0.3).expect("valid material")
    }

    fn skewed_tet() -> [[f64; 3]; 4] {
        [
            [0.1, -0.2, 0.0],
            [1.3, 0.1, 0.2],
            [0.2, 0.9, -0.1],
            [0.3, 0.2, 1.1],
        ]
    }

    fn apply(stiffness: &Tet4Stiffness, displacement: &[f64; 12]) -> [f64; 12] {
        stiffness.map(|row| {
            row.iter()
                .zip(displacement)
                .map(|(entry, value)| entry * value)
                .sum()
        })
    }

    #[test]
    fn stiffness_is_symmetric() {
        let stiffness = tet4_stiffness(&skewed_tet(), &steel());
        for (row, entries) in stiffness.iter().enumerate() {
            let scale = entries[row].abs();
            for (col, entry) in entries.iter().enumerate() {
                assert!((entry - stiffness[col][row]).abs() <= 1e-12 * scale);
            }
        }
    }

    #[test]
    fn rigid_body_motions_cost_no_energy() {
        let corners = skewed_tet();
        let stiffness = tet4_stiffness(&corners, &steel());
        let scale = stiffness[0][0];
        // Three translations and three infinitesimal rotations u = ω × x.
        let mut modes: Vec<[f64; 12]> = Vec::new();
        for axis in 0..3 {
            let mut mode = [0.0; 12];
            for node in 0..4 {
                mode[3 * node + axis] = 1.0;
            }
            modes.push(mode);
        }
        for axis in 0..3 {
            let mut omega = [0.0; 3];
            omega[axis] = 1.0;
            let mut mode = [0.0; 12];
            for (node, corner) in corners.iter().enumerate() {
                let motion = cross(omega, *corner);
                mode[3 * node..3 * node + 3].copy_from_slice(&motion);
            }
            modes.push(mode);
        }
        for mode in &modes {
            for force in apply(&stiffness, mode) {
                assert!(
                    force.abs() <= 1e-10 * scale,
                    "rigid mode produced force {force}"
                );
            }
        }
    }

    #[test]
    fn winding_does_not_change_stiffness() {
        let corners = skewed_tet();
        let flipped = [corners[0], corners[2], corners[1], corners[3]];
        let forward = tet4_stiffness(&corners, &steel());
        let backward = tet4_stiffness(&flipped, &steel());
        // Swapping corners 1 and 2 permutes their rows and columns.
        let perm = [0, 2, 1, 3];
        for node_a in 0..4 {
            for node_b in 0..4 {
                for row in 0..3 {
                    for col in 0..3 {
                        let lhs = forward[3 * perm[node_a] + row][3 * perm[node_b] + col];
                        let rhs = backward[3 * node_a + row][3 * node_b + col];
                        assert!((lhs - rhs).abs() <= 1e-9 * forward[0][0].abs());
                    }
                }
            }
        }
    }

    /// Displacements of the ten nodes of a quadratic tet under `field`.
    fn tet10_nodal(corners: &[[f64; 3]; 4], field: impl Fn([f64; 3]) -> [f64; 3]) -> [f64; 30] {
        let mut points = [[0.0; 3]; 10];
        points[..4].copy_from_slice(corners);
        for (edge, [first, second]) in EDGES_OF_TET.into_iter().enumerate() {
            points[4 + edge] =
                [0, 1, 2].map(|axis| f64::midpoint(corners[first][axis], corners[second][axis]));
        }
        let mut nodal = [0.0; 30];
        for (node, point) in points.iter().enumerate() {
            nodal[3 * node..3 * node + 3].copy_from_slice(&field(*point));
        }
        nodal
    }

    #[test]
    fn tet10_gradients_sum_to_zero_and_reproduce_a_quadratic() {
        let corners = skewed_tet();
        let (corner_gradients, _) = tet4_gradients(&corners);
        // f = x² + 2yz − 3x has ∇f = (2x − 3, 2z, 2y).
        let scalar =
            |point: [f64; 3]| point[0] * point[0] + 2.0 * point[1] * point[2] - 3.0 * point[0];
        let nodal = tet10_nodal(&corners, |point| [scalar(point), 0.0, 0.0]);
        for point in [CENTROID, [0.1, 0.2, 0.3, 0.4], [1.0, 0.0, 0.0, 0.0]] {
            let gradients = tet10_gradients(&corner_gradients, point);
            let mut sum = [0.0; 3];
            let mut interpolated = [0.0; 3];
            for (node, gradient) in gradients.iter().enumerate() {
                for axis in 0..3 {
                    sum[axis] += gradient[axis];
                    interpolated[axis] += nodal[3 * node] * gradient[axis];
                }
            }
            let at = [0, 1, 2].map(|axis| {
                (0..4)
                    .map(|corner| point[corner] * corners[corner][axis])
                    .sum::<f64>()
            });
            let exact = [2.0 * at[0] - 3.0, 2.0 * at[2], 2.0 * at[1]];
            for axis in 0..3 {
                assert!(sum[axis].abs() < 1e-12, "partition of unity: {sum:?}");
                assert!(
                    (interpolated[axis] - exact[axis]).abs() < 1e-12,
                    "gradient {interpolated:?} vs {exact:?}"
                );
            }
        }
    }

    #[test]
    fn tet10_stiffness_is_symmetric_with_six_rigid_modes() {
        let corners = skewed_tet();
        let stiffness = tet10_stiffness(&corners, &steel());
        let scale = stiffness[0][0].abs();
        for (row, entries) in stiffness.iter().enumerate() {
            for (col, entry) in entries.iter().enumerate() {
                assert!((entry - stiffness[col][row]).abs() <= 1e-12 * scale);
            }
        }
        for axis in 0..3 {
            let mut omega = [0.0; 3];
            omega[axis] = 1.0;
            let translation = tet10_nodal(&corners, |_| omega);
            let rotation = tet10_nodal(&corners, |point| cross(omega, point));
            for mode in [translation, rotation] {
                for row in &stiffness {
                    let force: f64 = row
                        .iter()
                        .zip(&mode)
                        .map(|(entry, value)| entry * value)
                        .sum();
                    assert!(
                        force.abs() <= 1e-10 * scale,
                        "rigid mode produced force {force}"
                    );
                }
            }
        }
    }

    #[test]
    fn tet10_strain_energy_matches_continuum_for_a_quadratic_field() {
        // u_x = ε·x², so ε_xx = 2εx: energy = ½·(λ+2μ)·∫(2εx)² dV, and on the
        // unit right tet ∫x² dV = 1/60.
        let corners = [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ];
        let material = steel();
        let stiffness = tet10_stiffness(&corners, &material);
        let strain = 1e-3;
        let nodal = tet10_nodal(&corners, |point| [strain * point[0] * point[0], 0.0, 0.0]);
        let energy: f64 = 0.5
            * stiffness
                .iter()
                .zip(&nodal)
                .map(|(row, motion)| {
                    motion
                        * row
                            .iter()
                            .zip(&nodal)
                            .map(|(entry, value)| entry * value)
                            .sum::<f64>()
                })
                .sum::<f64>();
        let (lambda, mu) = material.lame();
        // ½·(λ+2μ)·4ε²/60, with the ½·4 folded.
        let expected = 2.0 * (lambda + 2.0 * mu) * strain * strain / 60.0;
        assert!((energy - expected).abs() <= 1e-12 * expected.max(1.0));
    }

    #[test]
    fn uniaxial_strain_energy_matches_continuum() {
        // u_x = ε·x on a unit right tet: energy = ½·(λ+2μ)·ε²·V.
        let corners = [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ];
        let material = steel();
        let stiffness = tet4_stiffness(&corners, &material);
        let strain = 1e-3;
        let mut displacement = [0.0; 12];
        for (node, corner) in corners.iter().enumerate() {
            displacement[3 * node] = strain * corner[0];
        }
        let force = apply(&stiffness, &displacement);
        let energy: f64 = 0.5
            * force
                .iter()
                .zip(&displacement)
                .map(|(force, motion)| force * motion)
                .sum::<f64>();
        let (lambda, mu) = material.lame();
        // ½·(λ+2μ)·ε²·V with V = 1/6.
        let expected = (lambda + 2.0 * mu) * strain * strain / 12.0;
        assert!((energy - expected).abs() <= 1e-12 * expected.max(1.0));
    }

    /// A hex that is not a parallelepiped: its Jacobian varies.
    fn distorted_hex() -> [[f64; 3]; 8] {
        [
            [0.0, 0.0, 0.0],
            [1.2, 0.1, -0.1],
            [1.1, 1.0, 0.1],
            [-0.1, 0.9, 0.0],
            [0.1, -0.1, 1.0],
            [1.0, 0.0, 1.2],
            [1.3, 1.2, 0.9],
            [0.0, 1.0, 1.1],
        ]
    }

    /// Positions of the 27 nodes of a hex under its trilinear map.
    fn hex27_points(corners: &[[f64; 3]; 8]) -> [[f64; 3]; 27] {
        hex27_half_positions().map(|half| {
            let reference = half.map(|value| f64::from(value) / 2.0);
            let (values, _) = tensor_shape(&HEX_CORNERS, linear_basis, reference);
            std::array::from_fn(|axis| {
                values
                    .iter()
                    .zip(corners)
                    .map(|(value, corner)| value * corner[axis])
                    .sum()
            })
        })
    }

    fn nodal<const N: usize, const DOFS: usize>(
        points: &[[f64; 3]; N],
        field: impl Fn([f64; 3]) -> [f64; 3],
    ) -> [f64; DOFS] {
        let mut values = [0.0; DOFS];
        for (node, point) in points.iter().enumerate() {
            values[3 * node..3 * node + 3].copy_from_slice(&field(*point));
        }
        values
    }

    fn quadratic_form<const DOFS: usize>(
        stiffness: &[[f64; DOFS]; DOFS],
        displacement: &[f64; DOFS],
    ) -> f64 {
        stiffness
            .iter()
            .zip(displacement)
            .map(|(row, motion)| {
                motion
                    * row
                        .iter()
                        .zip(displacement)
                        .map(|(entry, value)| entry * value)
                        .sum::<f64>()
            })
            .sum()
    }

    fn assert_symmetric_with_rigid_modes<const N: usize, const DOFS: usize>(
        stiffness: &[[f64; DOFS]; DOFS],
        points: &[[f64; 3]; N],
    ) {
        let scale = stiffness[0][0].abs();
        for (row, entries) in stiffness.iter().enumerate() {
            for (col, entry) in entries.iter().enumerate() {
                assert!((entry - stiffness[col][row]).abs() <= 1e-12 * scale);
            }
        }
        for axis in 0..3 {
            let mut omega = [0.0; 3];
            omega[axis] = 1.0;
            let translation: [f64; DOFS] = nodal(points, |_| omega);
            let rotation: [f64; DOFS] = nodal(points, |point| cross(omega, point));
            for mode in [translation, rotation] {
                for row in stiffness {
                    let force: f64 = row
                        .iter()
                        .zip(&mode)
                        .map(|(entry, value)| entry * value)
                        .sum();
                    assert!(
                        force.abs() <= 1e-10 * scale,
                        "rigid mode produced force {force}"
                    );
                }
            }
        }
    }

    #[test]
    fn hex_shape_functions_interpolate_their_nodes() {
        let half = hex27_half_positions();
        for (node, position) in half.iter().enumerate() {
            let point = position.map(|value| f64::from(value) / 2.0);
            let (values, gradients) = tensor_shape(&half, quadratic_basis, point);
            for (other, value) in values.iter().enumerate() {
                let expected = if other == node { 1.0 } else { 0.0 };
                assert!((value - expected).abs() < 1e-14);
            }
            let sum: [f64; 3] =
                std::array::from_fn(|axis| gradients.iter().map(|gradient| gradient[axis]).sum());
            assert!(sum.iter().all(|component| component.abs() < 1e-12));
        }
        // The 27 positions are distinct: every grid point of {0, ½, 1}³.
        let mut sorted = half.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), 27);
    }

    #[test]
    fn hex8_stiffness_is_symmetric_with_six_rigid_modes() {
        let corners = distorted_hex();
        assert_symmetric_with_rigid_modes(&hex8_stiffness(&corners, &steel()), &corners);
    }

    #[test]
    fn hex27_stiffness_is_symmetric_with_six_rigid_modes() {
        let corners = distorted_hex();
        assert_symmetric_with_rigid_modes(
            &hex27_stiffness(&corners, &steel()),
            &hex27_points(&corners),
        );
    }

    #[test]
    fn mirrored_hex_has_the_same_stiffness() {
        let corners = distorted_hex();
        // Swapping the bottom and top faces mirrors the reference cube.
        let perm = [4, 5, 6, 7, 0, 1, 2, 3];
        let mirrored = perm.map(|corner| corners[corner]);
        let forward = hex8_stiffness(&corners, &steel());
        let backward = hex8_stiffness(&mirrored, &steel());
        for node_a in 0..8 {
            for node_b in 0..8 {
                for row in 0..3 {
                    for col in 0..3 {
                        let lhs = forward[3 * perm[node_a] + row][3 * perm[node_b] + col];
                        let rhs = backward[3 * node_a + row][3 * node_b + col];
                        assert!((lhs - rhs).abs() <= 1e-9 * forward[0][0].abs());
                    }
                }
            }
        }
    }

    #[test]
    fn hex_strain_energy_matches_continuum() {
        // A 2 × 1 × 3 box: u_x = ε·x stores ½·(λ+2μ)·ε²·V on either element,
        // and u_x = ε·x² stores ½·(λ+2μ)·∫(2εx)² dV = 2(λ+2μ)ε²·(8/3)·3 on
        // the 27-node one.
        let size = [2.0, 1.0, 3.0];
        let corners = HEX_CORNERS
            .map(|corner| std::array::from_fn(|axis| size[axis] * f64::from(corner[axis])));
        let material = steel();
        let (lambda, mu) = material.lame();
        let strain = 1e-3;
        let volume = size[0] * size[1] * size[2];
        let expected = (lambda + 2.0 * mu) * strain * strain * volume / 2.0;
        let stretch = |point: [f64; 3]| [strain * point[0], 0.0, 0.0];
        let linear: [f64; 24] = nodal(&corners, stretch);
        let energy = 0.5 * quadratic_form(&hex8_stiffness(&corners, &material), &linear);
        assert!((energy - expected).abs() <= 1e-12 * expected);
        let points = hex27_points(&corners);
        let stiffness = hex27_stiffness(&corners, &material);
        let quadratic: [f64; 81] = nodal(&points, stretch);
        let energy = 0.5 * quadratic_form(&stiffness, &quadratic);
        assert!((energy - expected).abs() <= 1e-12 * expected);
        let curved: [f64; 81] = nodal(&points, |point| [strain * point[0] * point[0], 0.0, 0.0]);
        let energy = 0.5 * quadratic_form(&stiffness, &curved);
        // ∫x² dV over the box = (2³/3)·1·3 = 8.
        let expected = 2.0 * (lambda + 2.0 * mu) * strain * strain * 8.0;
        assert!((energy - expected).abs() <= 1e-12 * expected);
    }
}
