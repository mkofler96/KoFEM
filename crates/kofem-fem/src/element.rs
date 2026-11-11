// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-FileCopyrightText: 2010-2024 Lawrence Livermore National Security, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later AND BSD-3-Clause

//! Linear (4-node) and quadratic (10-node) tetrahedra. The stiffness of
//! either is
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
//! MFEM reference: `ElasticityIntegrator::AssembleElementMatrix` in
//! `fem/bilininteg.cpp` (MFEM v4.7), specialized here to tetrahedra, and the
//! order-2 `H1_TetrahedronElement` nodal basis (corners and edge midpoints).
//! MFEM copyright (c) 2010-2024, Lawrence Livermore National Security, LLC.
//! All rights reserved. See `../NOTICE.md` and `../LICENSE-MFEM` (BSD-3-Clause).

use crate::material::Isotropic;
use crate::mesh::{cross, dot, signed_volume, sub, EDGES_OF_TET};

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
}
