// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Shell stress recovery, as the C++ engine's `shell_von_mises` reports it.

use crate::error::FemError;
use crate::mesh::dot;
use crate::shell::assembly::SHELL_NODE_DOFS;
use crate::shell::element::{constitutive, dkt_curvature_b, membrane_b, FacetFrame};
use crate::shell::mesh::ShellMesh;

/// One value per facet: plane-stress von Mises at the worse of the two
/// surfaces z = ±t/2, from the CST membrane strain and the DKT curvature at
/// the facet centroid, σ(z) = D·(`ε_m` + z·κ), with each facet's own (E, ν).
/// Taking the worse surface makes the result independent of the curvature's
/// sign convention.
///
/// # Errors
/// [`FemError::DisplacementLength`] when `dofs` is not 6 per vertex.
pub fn shell_von_mises(mesh: &ShellMesh, dofs: &[f64]) -> Result<Vec<f64>, FemError> {
    let count = SHELL_NODE_DOFS * mesh.vertex_count();
    if dofs.len() != count {
        return Err(FemError::DisplacementLength {
            len: dofs.len(),
            count,
        });
    }
    let stresses = mesh
        .triangles()
        .iter()
        .enumerate()
        .map(|(triangle, nodes)| {
            let frame = FacetFrame::new(&mesh.corners(triangle));
            let [e1, e2, e3] = frame.axes;
            // Nodal DOFs in the facet frame: (u, v) for the membrane, (w, θx,
            // θy) for bending.
            let mut membrane_dofs = [0.0; 6];
            let mut bending_dofs = [0.0; 9];
            for (local, &node) in nodes.iter().enumerate() {
                let base = SHELL_NODE_DOFS * node as usize;
                let translation = [dofs[base], dofs[base + 1], dofs[base + 2]];
                let rotation = [dofs[base + 3], dofs[base + 4], dofs[base + 5]];
                membrane_dofs[2 * local] = dot(e1, translation);
                membrane_dofs[2 * local + 1] = dot(e2, translation);
                bending_dofs[3 * local] = dot(e3, translation);
                bending_dofs[3 * local + 1] = dot(e1, rotation);
                bending_dofs[3 * local + 2] = dot(e2, rotation);
            }
            let membrane_strain = apply(&membrane_b(&frame), &membrane_dofs);
            let curvature = apply(
                &dkt_curvature_b(&frame, 1.0 / 3.0, 1.0 / 3.0),
                &bending_dofs,
            );

            let material = mesh.material(triangle);
            let poisson = material.poisson();
            let law = constitutive(material.young() / (1.0 - poisson * poisson), poisson);
            let half = 0.5 * mesh.thickness(triangle);
            [half, -half]
                .into_iter()
                .map(|depth| {
                    let strain: [f64; 3] =
                        std::array::from_fn(|i| membrane_strain[i] + depth * curvature[i]);
                    let [sx, sy, txy] = apply(&law, &strain);
                    (sx * sx - sx * sy + sy * sy + 3.0 * txy * txy).sqrt()
                })
                .fold(0.0, f64::max)
        })
        .collect();
    Ok(stresses)
}

/// matrix · vector for a 3-row matrix.
fn apply<const N: usize>(matrix: &[[f64; N]; 3], vector: &[f64; N]) -> [f64; 3] {
    matrix.map(|row| {
        row.iter()
            .zip(vector)
            .map(|(entry, value)| entry * value)
            .sum()
    })
}
