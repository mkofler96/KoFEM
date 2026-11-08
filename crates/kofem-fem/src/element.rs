// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Linear (4-node) tetrahedron. Its shape-function gradients are constant, so
//! the stiffness is exact with one evaluation:
//!
//! ```text
//! K_ab[i][j] = V · ( λ·g_a[i]·g_b[j] + μ·g_a[j]·g_b[i] + μ·δ_ij·(g_a · g_b) )
//! ```
//!
//! where `g_a` is the physical gradient of shape function `a` and `V` the volume.

use crate::material::Isotropic;
use crate::mesh::{cross, dot, signed_volume, sub};

/// Element stiffness, 12×12 with DOFs ordered (node, component): row
/// 3·a + i is component i of corner a.
pub type Tet4Stiffness = [[f64; 12]; 12];

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

#[must_use]
pub fn tet4_stiffness(corners: &[[f64; 3]; 4], material: &Isotropic) -> Tet4Stiffness {
    let (grads, volume) = tet4_gradients(corners);
    let (lambda, mu) = material.lame();
    let mut stiffness = [[0.0; 12]; 12];
    for (node_a, grad_a) in grads.iter().enumerate() {
        for (node_b, grad_b) in grads.iter().enumerate() {
            let shared = mu * dot(*grad_a, *grad_b);
            for row in 0..3 {
                for col in 0..3 {
                    let diagonal = if row == col { shared } else { 0.0 };
                    stiffness[3 * node_a + row][3 * node_b + col] = volume
                        * (lambda * grad_a[row] * grad_b[col] + mu * grad_a[col] * grad_b[row])
                        + volume * diagonal;
                }
            }
        }
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
        let expected = 0.5 * (lambda + 2.0 * mu) * strain * strain / 6.0;
        assert!((energy - expected).abs() <= 1e-12 * expected.max(1.0));
    }
}
