// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The shape quality of linear tetrahedra (KOF-456), to compare meshing
//! settings: the smallest dihedral angle, which slivers drive towards 0°, and
//! the aspect ratio, the longest edge over the inradius scaled by 2√6 so a
//! regular tetrahedron scores 1 and worse shapes score more.

use crate::error::FemError;
use crate::mesh::{cross, dot, sub};

/// One tetrahedron's shape quality.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TetQuality {
    /// The smallest of the six angles between two faces, in degrees; 70.53°
    /// for a regular tetrahedron.
    pub min_dihedral_deg: f64,
    /// Longest edge / (2√6 · inradius); 1 for a regular tetrahedron.
    pub aspect_ratio: f64,
}

/// Faces opposite each corner, so face `i` excludes corner `i`.
const FACES: [[usize; 3]; 4] = [[1, 2, 3], [0, 2, 3], [0, 1, 3], [0, 1, 2]];

/// Below this volume relative to the longest edge cubed a tetrahedron is
/// flat: its angles and inradius are rounding noise.
const FLAT: f64 = 1e-14;

/// The quality of each tetrahedron in `tets` (four vertex indices each) over
/// `points` (x, y, z per vertex), in element order.
///
/// # Errors
/// [`FemError::VertexArrayLength`] or [`FemError::TetArrayLength`] for a
/// ragged array, [`FemError::VertexOutOfRange`] for an index past the
/// vertices, and [`FemError::DegenerateTet`] for a flat tetrahedron, which has
/// no shape to measure.
pub fn tet_quality(points: &[f64], tets: &[u32]) -> Result<Vec<TetQuality>, FemError> {
    if !points.len().is_multiple_of(3) {
        return Err(FemError::VertexArrayLength { len: points.len() });
    }
    if !tets.len().is_multiple_of(4) {
        return Err(FemError::TetArrayLength { len: tets.len() });
    }
    let vertices = points.as_chunks::<3>().0;
    tets.as_chunks::<4>()
        .0
        .iter()
        .enumerate()
        .map(|(tet, corners)| {
            let mut corner_points = [[0.0; 3]; 4];
            for (slot, &vertex) in corner_points.iter_mut().zip(corners) {
                *slot = *vertices
                    .get(vertex as usize)
                    .ok_or(FemError::VertexOutOfRange {
                        tet,
                        vertex,
                        count: vertices.len(),
                    })?;
            }
            shape_quality(&corner_points).ok_or(FemError::DegenerateTet { tet })
        })
        .collect()
}

fn shape_quality(corners: &[[f64; 3]; 4]) -> Option<TetQuality> {
    let mut longest: f64 = 0.0;
    for i in 0..4 {
        for j in i + 1..4 {
            let edge = sub(corners[i], corners[j]);
            longest = longest.max(dot(edge, edge).sqrt());
        }
    }
    let six_volume = dot(
        sub(corners[1], corners[0]),
        cross(sub(corners[2], corners[0]), sub(corners[3], corners[0])),
    )
    .abs();
    if six_volume <= 6.0 * FLAT * longest.powi(3) {
        return None;
    }
    // Turn each face normal away from the corner opposite it: the angle
    // between two faces is then π minus the angle between their normals.
    let mut normals = [[0.0; 3]; 4];
    for (opposite, (&[first, second, third], normal)) in
        FACES.iter().zip(normals.iter_mut()).enumerate()
    {
        let origin = corners[first];
        let face_normal = cross(sub(corners[second], origin), sub(corners[third], origin));
        *normal = if dot(face_normal, sub(corners[opposite], origin)) > 0.0 {
            face_normal.map(|component| -component)
        } else {
            face_normal
        };
    }
    let lengths = normals.map(|normal| dot(normal, normal).sqrt());
    let mut min_dihedral = std::f64::consts::PI;
    for i in 0..4 {
        for j in i + 1..4 {
            let cosine = -dot(normals[i], normals[j]) / (lengths[i] * lengths[j]);
            min_dihedral = min_dihedral.min(cosine.clamp(-1.0, 1.0).acos());
        }
    }
    // Inradius = 3V / surface area; each normal's length is twice its face's area.
    let area: f64 = lengths.iter().sum::<f64>() / 2.0;
    let inradius = six_volume / 2.0 / area;
    Some(TetQuality {
        min_dihedral_deg: min_dihedral.to_degrees(),
        aspect_ratio: longest / (2.0 * 6.0_f64.sqrt() * inradius),
    })
}
