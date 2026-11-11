// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Element stress recovery at the element centre — the point where the MFEM
//! engine's `compute_von_mises` evaluates it (the one-point rule). The strain
//! of a linear tet is constant, so its centre value is the whole field; a
//! quadratic tet's strain is linear and is sampled at the centre as well.

use crate::element::{tet10_gradients, tet4_gradients, CENTROID};
use crate::error::FemError;
use crate::mesh::{ElementOrder, TetMesh};

/// Von Mises stress √(3/2·s:s) of every tet at its centre, with s the
/// deviatoric part of σ = λ·tr(ε)·I + 2μ·ε of the element's material.
///
/// # Errors
/// [`FemError::DisplacementLength`] when `displacements` is not 3 per node.
pub fn von_mises(mesh: &TetMesh, displacements: &[f64]) -> Result<Vec<f64>, FemError> {
    let count = mesh.dof_count();
    if displacements.len() != count {
        return Err(FemError::DisplacementLength {
            len: displacements.len(),
            count,
        });
    }
    let stresses = (0..mesh.tets().len())
        .map(|tet| {
            let (corner_gradients, _) = tet4_gradients(&mesh.corners(tet));
            let mut gradients = [[0.0; 3]; 10];
            let used = match mesh.order() {
                ElementOrder::Linear => {
                    gradients[..4].copy_from_slice(&corner_gradients);
                    4
                }
                ElementOrder::Quadratic => {
                    gradients = tet10_gradients(&corner_gradients, CENTROID);
                    10
                }
            };
            // ∇u[i][j] = ∂u_i/∂x_j = Σ_a u_a[i]·g_a[j].
            let mut gradient = [[0.0; 3]; 3];
            for (node, shape_gradient) in mesh.element_nodes(tet).iter().zip(&gradients[..used]) {
                let base = 3 * *node as usize;
                for (row, entries) in gradient.iter_mut().enumerate() {
                    for (col, entry) in entries.iter_mut().enumerate() {
                        *entry += displacements[base + row] * shape_gradient[col];
                    }
                }
            }
            // λ multiplies tr(ε)·I, which is purely spherical: only μ remains.
            let (_, mu) = mesh.material(tet).lame();
            let trace = gradient[0][0] + gradient[1][1] + gradient[2][2];
            // Deviatoric stress: 2μ·(ε − tr(ε)/3·I).
            let mut sum = 0.0;
            for (row, entries) in gradient.iter().enumerate() {
                for (col, _) in entries.iter().enumerate() {
                    let strain = f64::midpoint(gradient[row][col], gradient[col][row]);
                    let spherical = if row == col { trace / 3.0 } else { 0.0 };
                    let deviator = 2.0 * mu * (strain - spherical);
                    sum += deviator * deviator;
                }
            }
            (1.5 * sum).sqrt()
        })
        .collect();
    Ok(stresses)
}
