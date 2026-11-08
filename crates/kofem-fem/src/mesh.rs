// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::error::FemError;
use crate::material::Isotropic;

/// Linear tetrahedral mesh with one material per element, validated on
/// construction: every index is in range and every element has volume.
#[derive(Debug, Clone)]
pub struct TetMesh {
    vertices: Vec<[f64; 3]>,
    tets: Vec<[u32; 4]>,
    material_of_tet: Vec<u32>,
    materials: Vec<Isotropic>,
}

impl TetMesh {
    /// Build from flat arrays: `vertices` as x,y,z triples, `tets` as four
    /// vertex indices each, `material_of_tet` as an index into `materials`.
    /// Vertex winding does not matter.
    ///
    /// # Errors
    /// A [`FemError`] naming the first malformed array, index or element.
    pub fn new(
        vertices: &[f64],
        tets: &[u32],
        material_of_tet: &[u32],
        materials: Vec<Isotropic>,
    ) -> Result<Self, FemError> {
        if !vertices.len().is_multiple_of(3) {
            return Err(FemError::VertexArrayLength {
                len: vertices.len(),
            });
        }
        if !tets.len().is_multiple_of(4) {
            return Err(FemError::TetArrayLength { len: tets.len() });
        }
        if tets.is_empty() {
            return Err(FemError::EmptyMesh);
        }
        if vertices.len() / 3 > MAX_VERTICES {
            return Err(FemError::TooManyVertices {
                count: vertices.len() / 3,
                max: MAX_VERTICES,
            });
        }
        if let Some(&value) = vertices.iter().find(|value| !value.is_finite()) {
            return Err(FemError::NonFinite {
                what: "a vertex coordinate",
                value,
            });
        }
        // The lengths were checked above, so there is no remainder to drop.
        let points: Vec<[f64; 3]> = vertices.as_chunks::<3>().0.to_vec();
        let elements: Vec<[u32; 4]> = tets.as_chunks::<4>().0.to_vec();
        if material_of_tet.len() != elements.len() {
            return Err(FemError::MaterialIdCount {
                count: material_of_tet.len(),
                tets: elements.len(),
            });
        }

        for (tet, ids) in elements.iter().enumerate() {
            for &vertex in ids {
                if vertex as usize >= points.len() {
                    return Err(FemError::VertexOutOfRange {
                        tet,
                        vertex,
                        count: points.len(),
                    });
                }
            }
            let material = material_of_tet[tet];
            if material as usize >= materials.len() {
                return Err(FemError::MaterialOutOfRange {
                    tet,
                    material,
                    count: materials.len(),
                });
            }
            let corners = ids.map(|vertex| points[vertex as usize]);
            if signed_volume(&corners).abs() <= degenerate_volume(&corners) {
                return Err(FemError::DegenerateTet { tet });
            }
        }

        Ok(Self {
            vertices: points,
            tets: elements,
            material_of_tet: material_of_tet.to_vec(),
            materials,
        })
    }

    #[must_use]
    pub fn vertex_count(&self) -> usize {
        self.vertices.len()
    }

    #[must_use]
    pub fn tets(&self) -> &[[u32; 4]] {
        &self.tets
    }

    /// Corner coordinates of element `tet`.
    #[must_use]
    pub fn corners(&self, tet: usize) -> [[f64; 3]; 4] {
        self.tets[tet].map(|vertex| self.vertices[vertex as usize])
    }

    #[must_use]
    pub fn material(&self, tet: usize) -> &Isotropic {
        &self.materials[self.material_of_tet[tet] as usize]
    }
}

/// Largest vertex count whose DOF numbers (3·vertex + component) fit in `u32`,
/// the index type of the sparse matrix columns and of the JS interface.
pub const MAX_VERTICES: usize = (u32::MAX / 3) as usize;

/// Signed volume of a tetrahedron (positive for right-handed winding).
#[must_use]
pub fn signed_volume(corners: &[[f64; 3]; 4]) -> f64 {
    let edge = |to: usize| sub(corners[to], corners[0]);
    let (first, second, third) = (edge(1), edge(2), edge(3));
    dot(first, cross(second, third)) / 6.0
}

/// Volume below which an element counts as flat: a relative tolerance on the
/// cube of its longest edge, so the test is independent of the model's units.
fn degenerate_volume(corners: &[[f64; 3]; 4]) -> f64 {
    let mut longest: f64 = 0.0;
    for first in 0..4 {
        for second in first + 1..4 {
            let edge = sub(corners[second], corners[first]);
            longest = longest.max(dot(edge, edge).sqrt());
        }
    }
    1e-12 * longest.powi(3)
}

pub(crate) fn sub(lhs: [f64; 3], rhs: [f64; 3]) -> [f64; 3] {
    [lhs[0] - rhs[0], lhs[1] - rhs[1], lhs[2] - rhs[2]]
}

pub(crate) fn dot(lhs: [f64; 3], rhs: [f64; 3]) -> f64 {
    lhs[0] * rhs[0] + lhs[1] * rhs[1] + lhs[2] * rhs[2]
}

pub(crate) fn cross(lhs: [f64; 3], rhs: [f64; 3]) -> [f64; 3] {
    [
        lhs[1] * rhs[2] - lhs[2] * rhs[1],
        lhs[2] * rhs[0] - lhs[0] * rhs[2],
        lhs[0] * rhs[1] - lhs[1] * rhs[0],
    ]
}
