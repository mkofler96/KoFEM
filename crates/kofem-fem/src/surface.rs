// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Surface loads on the boundary of a tet mesh, turned into work-equivalent
//! nodal forces: `f_a = ∫_S N_a·t dS`. For a constant traction t on a flat
//! triangle of area A that is exactly t·A/3 per corner of a 3-node (linear)
//! face. On a 6-node (quadratic) face the corner shape functions integrate to
//! zero and each mid-edge function to A/3, so the corners get nothing and each
//! edge node t·A/3 — what MFEM's boundary integrator gives on order-2 faces.
//!
//! The semantics follow the MFEM engine's `apply_surface_loads`
//! (`engine/cpp/fem_bc_io.cpp`), so both solvers load a model identically:
//!
//! * a selected face matches a boundary face by its (sorted) vertex triple;
//!   duplicates count once, and faces that match nothing are reported;
//! * a load that matches no boundary face at all is refused;
//! * pressure p acts as the traction −p·n with n the outward unit normal;
//! * a total force F is spread as the uniform traction F / A over the matched
//!   area A, which must be positive;
//! * overlapping loads simply add up.

use crate::error::FemError;
use crate::mesh::{cross, dot, local_edge, sub, ElementOrder, TetMesh};

/// What one surface load applies.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SurfaceLoadKind {
    /// Normal pressure, positive pushing into the body.
    Pressure(f64),
    /// Force per unit area, constant over the faces.
    Traction([f64; 3]),
    /// Total force, spread uniformly over the faces' area.
    Force([f64; 3]),
}

/// How a load's face selection matched the mesh boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SurfaceLoadReport {
    /// Distinct boundary faces the load acts on.
    pub matched: usize,
    /// Selected faces that are not on the boundary (stale or interior).
    pub unmatched: usize,
}

/// One boundary face: corners in the owning tet's order, outward orientation
/// not yet applied, and the tet's fourth vertex to orient it.
#[derive(Debug, Clone, Copy)]
struct BoundaryFace {
    key: [u32; 3],
    corners: [u32; 3],
    opposite: u32,
    /// The nodes that carry the face's load: its corners on a linear mesh,
    /// its three edge nodes on a quadratic one (see the module notes).
    loaded: [u32; 3],
}

/// The exterior faces of a tet mesh (faces used by exactly one tet), sorted by
/// their vertex triple for lookup. Interfaces between bodies that share nodes
/// are interior, exactly as in the MFEM mesh.
#[derive(Debug, Clone)]
pub struct BoundaryFaces {
    faces: Vec<BoundaryFace>,
}

/// Local face k of a tet is the three corners other than k.
const FACES_OF_TET: [[usize; 3]; 4] = [[1, 2, 3], [0, 2, 3], [0, 1, 3], [0, 1, 2]];

fn sorted(mut triple: [u32; 3]) -> [u32; 3] {
    triple.sort_unstable();
    triple
}

impl BoundaryFaces {
    #[must_use]
    pub fn new(mesh: &TetMesh) -> Self {
        let mut all: Vec<BoundaryFace> = Vec::with_capacity(4 * mesh.tets().len());
        for (index, tet) in mesh.tets().iter().enumerate() {
            let nodes = mesh.element_nodes(index);
            for (opposite, local) in FACES_OF_TET.iter().enumerate() {
                let corners = local.map(|corner| tet[corner]);
                let loaded = match mesh.order() {
                    ElementOrder::Linear => corners,
                    ElementOrder::Quadratic => [[0, 1], [1, 2], [0, 2]]
                        .map(|[first, second]| nodes[4 + local_edge(local[first], local[second])]),
                };
                all.push(BoundaryFace {
                    key: sorted(corners),
                    corners,
                    opposite: tet[opposite],
                    loaded,
                });
            }
        }
        all.sort_unstable_by_key(|face| face.key);
        // Keep the faces whose key occurs exactly once.
        let mut faces = Vec::new();
        let mut start = 0;
        while start < all.len() {
            let mut end = start + 1;
            while end < all.len() && all[end].key == all[start].key {
                end += 1;
            }
            if end - start == 1 {
                faces.push(all[start]);
            }
            start = end;
        }
        Self { faces }
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.faces.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.faces.is_empty()
    }

    fn find(&self, triple: [u32; 3]) -> Option<usize> {
        let key = sorted(triple);
        self.faces.binary_search_by_key(&key, |face| face.key).ok()
    }

    /// Outward area vector (normal × area) of boundary face `index`.
    fn area_vector(&self, mesh: &TetMesh, index: usize) -> [f64; 3] {
        let face = self.faces[index];
        let points = mesh.vertices();
        let [first, second, third] = face.corners.map(|vertex| points[vertex as usize]);
        let doubled = cross(sub(second, first), sub(third, first));
        let inward = dot(doubled, sub(points[face.opposite as usize], first)) > 0.0;
        doubled.map(|component| if inward { -0.5 } else { 0.5 } * component)
    }

    /// Add the nodal forces of one surface load to `forces` (3 per node).
    /// `faces` holds the selected triangles as vertex triples; `load` names the
    /// load in errors.
    ///
    /// # Errors
    /// [`FemError::SurfaceLoadUnmatched`] when no selected face is on the
    /// boundary, [`FemError::SurfaceLoadArea`] for a total force over zero
    /// area, [`FemError::NonFinite`] for a non-finite load value,
    /// [`FemError::ForceLength`] when `forces` does not fit the mesh.
    pub fn apply(
        &self,
        mesh: &TetMesh,
        load: usize,
        faces: &[[u32; 3]],
        kind: SurfaceLoadKind,
        forces: &mut [f64],
    ) -> Result<SurfaceLoadReport, FemError> {
        let count = mesh.dof_count();
        if forces.len() != count {
            return Err(FemError::ForceLength {
                len: forces.len(),
                count,
            });
        }
        let values: &[f64] = match &kind {
            SurfaceLoadKind::Pressure(pressure) => std::slice::from_ref(pressure),
            SurfaceLoadKind::Traction(vector) | SurfaceLoadKind::Force(vector) => vector,
        };
        if let Some(&value) = values.iter().find(|value| !value.is_finite()) {
            return Err(FemError::NonFinite {
                what: "a surface load value",
                value,
            });
        }
        let mut matched: Vec<usize> = faces
            .iter()
            .filter_map(|&triple| self.find(triple))
            .collect();
        let unmatched = faces.len() - matched.len();
        matched.sort_unstable();
        matched.dedup();
        if matched.is_empty() {
            return Err(FemError::SurfaceLoadUnmatched {
                load,
                faces: faces.len(),
            });
        }
        let area_vectors: Vec<[f64; 3]> = matched
            .iter()
            .map(|&index| self.area_vector(mesh, index))
            .collect();
        let total_area: f64 = area_vectors
            .iter()
            .map(|vector| dot(*vector, *vector).sqrt())
            .sum();
        if matches!(kind, SurfaceLoadKind::Force(_)) && total_area <= 0.0 {
            return Err(FemError::SurfaceLoadArea {
                load,
                area: total_area,
            });
        }
        for (&index, area_vector) in matched.iter().zip(&area_vectors) {
            let area = dot(*area_vector, *area_vector).sqrt();
            // Force on the whole face, a third to each loaded node.
            let face_force = match kind {
                // −p·n·A = −p·(outward area vector).
                SurfaceLoadKind::Pressure(pressure) => {
                    area_vector.map(|component| -pressure * component)
                }
                SurfaceLoadKind::Traction(traction) => traction.map(|component| component * area),
                SurfaceLoadKind::Force(force) => {
                    force.map(|component| component * area / total_area)
                }
            };
            for node in self.faces[index].loaded {
                for axis in 0..3 {
                    forces[3 * node as usize + axis] += face_force[axis] / 3.0;
                }
            }
        }
        Ok(SurfaceLoadReport {
            matched: matched.len(),
            unmatched,
        })
    }
}
