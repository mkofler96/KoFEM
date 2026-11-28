// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Element stress recovery. Von Mises is read at the element centre — the
//! point where the MFEM engine's `compute_von_mises` evaluates it (the
//! one-point rule). The strain of a linear tet is constant, so its centre value
//! is the whole field; a quadratic tet's strain is linear, and a hex's varies,
//! and both are sampled at the centre as well. The stress tensor is also
//! recovered at each element's corners, where a quadratic element's own field
//! reaches a surface: the centre lies inside, away from a peak on the surface.

use crate::element::{
    hex27_reference_gradients, hex8_reference_gradients, hex_gradients, tet10_gradients,
    tet4_gradients, CENTROID, HEX_CENTRE, HEX_CORNERS,
};
use crate::error::FemError;
use crate::mesh::{ElementOrder, ElementShape, TetMesh};

/// Where in an element its shape-function gradients are taken.
#[derive(Clone, Copy)]
pub(crate) enum Location {
    Centre,
    /// One of the element's corner vertices, in its node order.
    Corner(usize),
}

/// The number of corner vertices of `element`.
pub(crate) fn corner_count(mesh: &TetMesh, element: usize) -> usize {
    match mesh.shape(element) {
        ElementShape::Tetrahedron => 4,
        ElementShape::Hexahedron => 8,
    }
}

/// Physical shape-function gradients of `element` at `location`, in its node
/// order, written to the front of `gradients`; returns how many there are.
fn gradients_at(
    mesh: &TetMesh,
    element: usize,
    location: Location,
    gradients: &mut [[f64; 3]; 27],
) -> usize {
    match mesh.shape(element) {
        ElementShape::Tetrahedron => {
            let tet_point = match location {
                Location::Centre => CENTROID,
                Location::Corner(corner) => {
                    let mut point = [0.0; 4];
                    point[corner] = 1.0;
                    point
                }
            };
            let (corner_gradients, _) = tet4_gradients(&mesh.corners(element));
            match mesh.order() {
                ElementOrder::Linear => {
                    gradients[..4].copy_from_slice(&corner_gradients);
                    4
                }
                ElementOrder::Quadratic => {
                    gradients[..10].copy_from_slice(&tet10_gradients(&corner_gradients, tet_point));
                    10
                }
            }
        }
        ElementShape::Hexahedron => {
            let hex_point = match location {
                Location::Centre => HEX_CENTRE,
                Location::Corner(corner) => HEX_CORNERS[corner].map(f64::from),
            };
            let corners = mesh.hex_corners(element - mesh.tets().len());
            match mesh.order() {
                ElementOrder::Linear => {
                    let reference = hex8_reference_gradients(hex_point);
                    gradients[..8]
                        .copy_from_slice(&hex_gradients(&corners, &reference, hex_point).0);
                    8
                }
                ElementOrder::Quadratic => {
                    let reference = hex27_reference_gradients(hex_point);
                    *gradients = hex_gradients(&corners, &reference, hex_point).0;
                    27
                }
            }
        }
    }
}

/// The displacement gradient `∇u[i][j] = ∂u_i/∂x_j` of `element` at `location`.
pub(crate) fn displacement_gradient(
    mesh: &TetMesh,
    element: usize,
    location: Location,
    displacements: &[f64],
) -> [[f64; 3]; 3] {
    let mut gradients = [[0.0; 3]; 27];
    let used = gradients_at(mesh, element, location, &mut gradients);
    // ∇u[i][j] = Σ_a u_a[i]·g_a[j].
    let mut gradient = [[0.0; 3]; 3];
    for (node, shape_gradient) in mesh.element_nodes(element).iter().zip(&gradients[..used]) {
        let base = 3 * *node as usize;
        for (row, entries) in gradient.iter_mut().enumerate() {
            for (col, entry) in entries.iter_mut().enumerate() {
                *entry += displacements[base + row] * shape_gradient[col];
            }
        }
    }
    gradient
}

pub(crate) fn check_length(mesh: &TetMesh, displacements: &[f64]) -> Result<(), FemError> {
    let count = mesh.dof_count();
    if displacements.len() == count {
        Ok(())
    } else {
        Err(FemError::DisplacementLength {
            len: displacements.len(),
            count,
        })
    }
}

/// Von Mises stress √(3/2·s:s) of every element (tets first, then hexes) at
/// its centre, with s the deviatoric part of σ = λ·tr(ε)·I + 2μ·ε of the
/// element's material.
///
/// # Errors
/// [`FemError::DisplacementLength`] when `displacements` is not 3 per node.
pub fn von_mises(mesh: &TetMesh, displacements: &[f64]) -> Result<Vec<f64>, FemError> {
    check_length(mesh, displacements)?;
    let stresses = (0..mesh.element_count())
        .map(|element| {
            let gradient = displacement_gradient(mesh, element, Location::Centre, displacements);
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

/// The stress tensor σ = λ·tr(ε)·I + 2μ·ε of every element (tets first, then
/// hexes) at its centre, the point von Mises is recovered at, in global axes
/// as `[σxx, σyy, σzz, τxy, τyz, τzx]`.
///
/// # Errors
/// [`FemError::DisplacementLength`] when `displacements` is not 3 per node.
pub fn stress_tensors(mesh: &TetMesh, displacements: &[f64]) -> Result<Vec<[f64; 6]>, FemError> {
    check_length(mesh, displacements)?;
    Ok((0..mesh.element_count())
        .map(|element| tensor_at(mesh, element, Location::Centre, displacements))
        .collect())
}

/// The stress tensor of every element at each of its corner vertices, in its
/// node order (four per tet, eight per hex; tets first, then hexes), from the
/// element's own field, as `[σxx, σyy, σzz, τxy, τyz, τzx]`. A quadratic
/// element's stress varies inside it, so its corners carry the values it
/// reaches on the surface, where the centre lies inside.
///
/// # Errors
/// [`FemError::DisplacementLength`] when `displacements` is not 3 per node.
pub fn corner_stress_tensors(
    mesh: &TetMesh,
    displacements: &[f64],
) -> Result<Vec<[f64; 6]>, FemError> {
    check_length(mesh, displacements)?;
    Ok((0..mesh.element_count())
        .flat_map(|element| {
            (0..corner_count(mesh, element)).map(move |corner| {
                tensor_at(mesh, element, Location::Corner(corner), displacements)
            })
        })
        .collect())
}

/// σ = λ·tr(ε)·I + 2μ·ε of `element` at `location`.
fn tensor_at(
    mesh: &TetMesh,
    element: usize,
    location: Location,
    displacements: &[f64],
) -> [f64; 6] {
    let grad = displacement_gradient(mesh, element, location, displacements);
    let (lambda, mu) = mesh.material(element).lame();
    let spherical = lambda * (grad[0][0] + grad[1][1] + grad[2][2]);
    [
        spherical + 2.0 * mu * grad[0][0],
        spherical + 2.0 * mu * grad[1][1],
        spherical + 2.0 * mu * grad[2][2],
        mu * (grad[0][1] + grad[1][0]),
        mu * (grad[1][2] + grad[2][1]),
        mu * (grad[2][0] + grad[0][2]),
    ]
}
