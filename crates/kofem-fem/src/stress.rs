// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Element stress recovery. Von Mises is read at the element centre — the
//! point where the MFEM engine's `compute_von_mises` evaluates it (the
//! one-point rule). The strain of a linear tet is constant, so its centre value
//! is the whole field; a quadratic tet's strain is linear, and a hex's varies,
//! and both are sampled at the centre as well. The stress tensor is also
//! recovered at each element's corners, where a quadratic element's own field
//! reaches a surface: the centre lies inside, away from a peak on the surface.
//! A transition element ([`crate::transition`]) gives the volume mean of its
//! pieces' centre values, and at a corner the mean of the pieces meeting there.

use crate::error::FemError;
use crate::mesh::{ElementShape, TetMesh};
use crate::piece::{centre_samples, corner_samples};

/// Where in an element its displacement gradient is read.
#[derive(Clone, Copy)]
pub(crate) enum Location {
    /// The centre; for a transition element, the mean over its pieces.
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

/// The displacement gradient `∇u[i][j] = ∂u_i/∂x_j` of `element` at `location`.
pub(crate) fn displacement_gradient(
    mesh: &TetMesh,
    element: usize,
    location: Location,
    displacements: &[f64],
) -> [[f64; 3]; 3] {
    let samples = match location {
        Location::Centre => centre_samples(mesh, element),
        Location::Corner(corner) => corner_samples(mesh, element, corner),
    };
    let mut gradient = [[0.0; 3]; 3];
    for (piece, point, weight) in samples {
        let at_point = piece.displacement_gradient(point, displacements);
        for (row, entries) in gradient.iter_mut().enumerate() {
            for (col, entry) in entries.iter_mut().enumerate() {
                *entry += weight * at_point[row][col];
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
