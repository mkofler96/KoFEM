// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::error::FemError;
use crate::material::Isotropic;
use crate::mesh::{cross, dot, sub};

/// Largest vertex count whose shell DOF numbers (6·vertex + component) fit in
/// `u32`, the index type of the sparse matrix columns and of the JS interface.
pub const MAX_SHELL_VERTICES: usize = (u32::MAX / 6) as usize;

/// Flat triangular shell mesh with a thickness and a material per facet,
/// validated on construction: every index is in range, every facet has area,
/// every thickness is positive.
#[derive(Debug, Clone)]
pub struct ShellMesh {
    vertices: Vec<[f64; 3]>,
    triangles: Vec<[u32; 3]>,
    thickness_of_triangle: Vec<f64>,
    material_of_triangle: Vec<u32>,
    materials: Vec<Isotropic>,
    used: Vec<bool>,
}

impl ShellMesh {
    /// Build from flat arrays: `vertices` as x,y,z triples, `triangles` as
    /// three vertex indices each, one thickness per triangle, and
    /// `material_of_triangle` as an index into `materials`. Shell bodies of
    /// different gauge or material share one mesh this way.
    ///
    /// # Errors
    /// A [`FemError`] naming the first malformed array, index, facet,
    /// thickness or material reference.
    pub fn new(
        vertices: &[f64],
        triangles: &[u32],
        thickness_of_triangle: &[f64],
        material_of_triangle: &[u32],
        materials: Vec<Isotropic>,
    ) -> Result<Self, FemError> {
        if !vertices.len().is_multiple_of(3) {
            return Err(FemError::VertexArrayLength {
                len: vertices.len(),
            });
        }
        if !triangles.len().is_multiple_of(3) {
            return Err(FemError::TriangleArrayLength {
                len: triangles.len(),
            });
        }
        if triangles.is_empty() {
            return Err(FemError::EmptyShellMesh);
        }
        if vertices.len() / 3 > MAX_SHELL_VERTICES {
            return Err(FemError::TooManyNodes {
                count: vertices.len() / 3,
                max: MAX_SHELL_VERTICES,
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
        let elements: Vec<[u32; 3]> = triangles.as_chunks::<3>().0.to_vec();
        if thickness_of_triangle.len() != elements.len() {
            return Err(FemError::ThicknessCount {
                count: thickness_of_triangle.len(),
                triangles: elements.len(),
            });
        }
        if material_of_triangle.len() != elements.len() {
            return Err(FemError::ShellMaterialIdCount {
                count: material_of_triangle.len(),
                triangles: elements.len(),
            });
        }

        for (triangle, ids) in elements.iter().enumerate() {
            for &vertex in ids {
                if vertex as usize >= points.len() {
                    return Err(FemError::TriangleVertexOutOfRange {
                        triangle,
                        vertex,
                        count: points.len(),
                    });
                }
            }
            let thickness = thickness_of_triangle[triangle];
            if !(thickness.is_finite() && thickness > 0.0) {
                return Err(FemError::Thickness {
                    triangle,
                    value: thickness,
                });
            }
            let material = material_of_triangle[triangle];
            if material as usize >= materials.len() {
                return Err(FemError::ShellMaterialOutOfRange {
                    triangle,
                    material,
                    count: materials.len(),
                });
            }
            if is_degenerate(&ids.map(|vertex| points[vertex as usize])) {
                return Err(FemError::DegenerateTriangle { triangle });
            }
        }

        // A vertex no facet uses carries no stiffness, so the solve holds it.
        let mut used = vec![false; points.len()];
        for ids in &elements {
            for &vertex in ids {
                used[vertex as usize] = true;
            }
        }

        Ok(Self {
            vertices: points,
            triangles: elements,
            thickness_of_triangle: thickness_of_triangle.to_vec(),
            material_of_triangle: material_of_triangle.to_vec(),
            materials,
            used,
        })
    }

    #[must_use]
    pub fn vertex_count(&self) -> usize {
        self.vertices.len()
    }

    #[must_use]
    pub fn vertices(&self) -> &[[f64; 3]] {
        &self.vertices
    }

    /// Whether any facet uses `vertex`.
    #[must_use]
    pub fn is_used(&self, vertex: usize) -> bool {
        self.used[vertex]
    }

    /// Vertices that no facet uses.
    #[must_use]
    pub fn unused_vertex_count(&self) -> usize {
        self.used.iter().filter(|&&used| !used).count()
    }

    #[must_use]
    pub fn triangles(&self) -> &[[u32; 3]] {
        &self.triangles
    }

    /// Corner coordinates of facet `triangle`.
    #[must_use]
    pub fn corners(&self, triangle: usize) -> [[f64; 3]; 3] {
        self.triangles[triangle].map(|vertex| self.vertices[vertex as usize])
    }

    #[must_use]
    pub fn thickness(&self, triangle: usize) -> f64 {
        self.thickness_of_triangle[triangle]
    }

    #[must_use]
    pub fn material(&self, triangle: usize) -> &Isotropic {
        &self.materials[self.material_of_triangle[triangle] as usize]
    }
}

/// Whether a facet's area is negligible against the square of its longest
/// edge — a relative test, so it does not depend on the model's units.
fn is_degenerate(corners: &[[f64; 3]; 3]) -> bool {
    let first = sub(corners[1], corners[0]);
    let second = sub(corners[2], corners[0]);
    let third = sub(corners[2], corners[1]);
    let normal = cross(first, second);
    let twice_area = dot(normal, normal).sqrt();
    let longest = dot(first, first)
        .max(dot(second, second))
        .max(dot(third, third));
    // A NaN area counts as degenerate too.
    twice_area.partial_cmp(&(1e-12 * longest)) != Some(std::cmp::Ordering::Greater)
}
