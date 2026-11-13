// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Element stress recovery at the element centre — the point where the MFEM
//! engine's `compute_von_mises` evaluates it (the one-point rule). The strain
//! of a linear tet is constant, so its centre value is the whole field; a
//! quadratic tet's strain is linear, and a hex's varies, and both are sampled
//! at the centre as well.

use crate::element::{
    hex27_reference_gradients, hex8_reference_gradients, hex_gradients, tet10_gradients,
    tet4_gradients, CENTROID, HEX_CENTRE,
};
use crate::error::FemError;
use crate::mesh::{ElementOrder, ElementShape, TetMesh};

/// Physical shape-function gradients of `element` at its centre, in its node
/// order, written to the front of `gradients`; returns how many there are.
fn centre_gradients(mesh: &TetMesh, element: usize, gradients: &mut [[f64; 3]; 27]) -> usize {
    match mesh.shape(element) {
        ElementShape::Tetrahedron => {
            let (corner_gradients, _) = tet4_gradients(&mesh.corners(element));
            match mesh.order() {
                ElementOrder::Linear => {
                    gradients[..4].copy_from_slice(&corner_gradients);
                    4
                }
                ElementOrder::Quadratic => {
                    gradients[..10].copy_from_slice(&tet10_gradients(&corner_gradients, CENTROID));
                    10
                }
            }
        }
        ElementShape::Hexahedron => {
            let corners = mesh.hex_corners(element - mesh.tets().len());
            match mesh.order() {
                ElementOrder::Linear => {
                    let reference = hex8_reference_gradients(HEX_CENTRE);
                    gradients[..8]
                        .copy_from_slice(&hex_gradients(&corners, &reference, HEX_CENTRE).0);
                    8
                }
                ElementOrder::Quadratic => {
                    let reference = hex27_reference_gradients(HEX_CENTRE);
                    *gradients = hex_gradients(&corners, &reference, HEX_CENTRE).0;
                    27
                }
            }
        }
    }
}

/// Von Mises stress √(3/2·s:s) of every element (tets first, then hexes) at
/// its centre, with s the deviatoric part of σ = λ·tr(ε)·I + 2μ·ε of the
/// element's material.
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
    let stresses = (0..mesh.element_count())
        .map(|element| {
            let mut gradients = [[0.0; 3]; 27];
            let used = centre_gradients(mesh, element, &mut gradients);
            // ∇u[i][j] = ∂u_i/∂x_j = Σ_a u_a[i]·g_a[j].
            let mut gradient = [[0.0; 3]; 3];
            for (node, shape_gradient) in mesh.element_nodes(element).iter().zip(&gradients[..used])
            {
                let base = 3 * *node as usize;
                for (row, entries) in gradient.iter_mut().enumerate() {
                    for (col, entry) in entries.iter_mut().enumerate() {
                        *entry += displacements[base + row] * shape_gradient[col];
                    }
                }
            }
            // λ multiplies tr(ε)·I, which is purely spherical: only μ remains.
            let (_, mu) = mesh.material(element).lame();
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
