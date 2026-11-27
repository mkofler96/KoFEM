// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The displacement one element gives at a point inside it, from its own
//! shape functions. Two elements that share a face give the same value there
//! exactly when the field is continuous across that face, so this is how a
//! test sees a jump that the shared vertices hide.

use crate::element::{hex8_reference_gradients, hex8_shape, hex_jacobian};
use crate::error::FemError;
use crate::mesh::{cross, determinant, dot, sub, TetMesh};
use crate::piece::{PieceGeometry, PiecePoint};
use crate::stress::check_length;

/// How far outside its element, in local coordinates, a point may lie and
/// still count as inside: round-off of a point on a face.
const INSIDE_TOLERANCE: f64 = 1e-9;

/// The displacement of `element` at `point`, interpolated with the element's
/// shape functions from `displacements` (3 per node) — for a transition
/// element, those of the piece that holds the point.
///
/// # Errors
/// [`FemError::DisplacementLength`] when `displacements` is not 3 per node,
/// [`FemError::ElementOutOfRange`] for an element the mesh does not have,
/// [`FemError::PointOutsideElement`] when the point is not inside it.
pub fn displacement_at(
    mesh: &TetMesh,
    element: usize,
    point: [f64; 3],
    displacements: &[f64],
) -> Result<[f64; 3], FemError> {
    check_length(mesh, displacements)?;
    if element >= mesh.element_count() {
        return Err(FemError::ElementOutOfRange {
            element,
            count: mesh.element_count(),
        });
    }
    for piece in mesh.pieces(element) {
        let local = match piece.geometry {
            PieceGeometry::Tetrahedron(corners) => {
                barycentric(&corners, point).map(PiecePoint::Tetrahedron)
            }
            PieceGeometry::Hexahedron(corners) => {
                hex_local(&corners, point).map(PiecePoint::Hexahedron)
            }
        };
        let Some(local) = local else {
            continue;
        };
        let values = piece.local_values(displacements, 3);
        let mut value = [0.0; 3];
        for (weight, motion) in piece
            .shape_values(local)
            .iter()
            .zip(values.as_chunks::<3>().0)
        {
            for (axis, entry) in value.iter_mut().enumerate() {
                *entry += weight * motion[axis];
            }
        }
        return Ok(value);
    }
    Err(FemError::PointOutsideElement { element, point })
}

/// Barycentric coordinates of `point` in the tetrahedron, or `None` when it
/// lies outside.
pub(crate) fn barycentric(corners: &[[f64; 3]; 4], point: [f64; 3]) -> Option<[f64; 4]> {
    let [first, second, third] = [1, 2, 3].map(|corner| sub(corners[corner], corners[0]));
    let offset = sub(point, corners[0]);
    let volume = dot(first, cross(second, third));
    let along = [
        dot(offset, cross(second, third)) / volume,
        dot(first, cross(offset, third)) / volume,
        dot(first, cross(second, offset)) / volume,
    ];
    let local = [
        1.0 - along[0] - along[1] - along[2],
        along[0],
        along[1],
        along[2],
    ];
    local
        .iter()
        .all(|&coordinate| coordinate >= -INSIDE_TOLERANCE)
        .then_some(local)
}

/// Unit-cube coordinates of `point` under the trilinear map of the hex, by
/// Newton's method from the centre, or `None` when it lies outside (or the
/// iteration does not settle, which a point inside a valid hex always does).
pub(crate) fn hex_local(corners: &[[f64; 3]; 8], point: [f64; 3]) -> Option<[f64; 3]> {
    let scale = corners
        .iter()
        .map(|corner| dot(sub(*corner, corners[0]), sub(*corner, corners[0])).sqrt())
        .fold(0.0, f64::max);
    let mut local = [0.5; 3];
    for _ in 0..50 {
        let mapped = hex8_shape(local)
            .iter()
            .zip(corners)
            .fold([0.0; 3], |sum, (&weight, corner)| {
                std::array::from_fn(|axis| sum[axis] + weight * corner[axis])
            });
        let residual = sub(point, mapped);
        if dot(residual, residual).sqrt() <= 1e-13 * scale {
            return local
                .iter()
                .all(|&coordinate| {
                    (-INSIDE_TOLERANCE..=1.0 + INSIDE_TOLERANCE).contains(&coordinate)
                })
                .then_some(local);
        }
        let jacobian = hex_jacobian(corners, &hex8_reference_gradients(local));
        let det = determinant(&jacobian);
        if det == 0.0 {
            return None;
        }
        // Cramer's rule for J·step = residual.
        let column = |axis: usize| [jacobian[0][axis], jacobian[1][axis], jacobian[2][axis]];
        let step = [
            dot(residual, cross(column(1), column(2))) / det,
            dot(column(0), cross(residual, column(2))) / det,
            dot(column(0), cross(column(1), residual)) / det,
        ];
        local = std::array::from_fn(|axis| local[axis] + step[axis]);
    }
    None
}
