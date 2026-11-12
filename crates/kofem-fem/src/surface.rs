// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Surface loads on the boundary of a solid mesh, turned into work-equivalent
//! nodal forces: `f_a = ∫_S N_a·t dS`, on the triangles of tetrahedra and the
//! quadrilaterals of hexahedra.
//!
//! For a constant traction t on a flat triangle of area A that is exactly
//! t·A/3 per corner of a 3-node (linear) face. On a 6-node (quadratic) face
//! the corner shape functions integrate to zero and each mid-edge function to
//! A/3, so the corners get nothing and each edge node t·A/3 — what MFEM's
//! boundary integrator gives on order-2 faces.
//!
//! A quadrilateral is the bilinear patch through its four corners, and need
//! not be flat. Its 4 (bilinear) or 9 (biquadratic) shape functions are
//! integrated with the rule MFEM's `VectorBoundaryLFIntegrator` uses, the
//! tensor Gauss–Legendre rule of order 2·order (2² or 3² points), with the
//! pressure along the local normal at each point. On a flat parallelogram that
//! gives A/4 per corner, or A/36 per corner, A/9 per edge node and 4A/9 at
//! the centre.
//!
//! The semantics follow the MFEM engine's `apply_surface_loads`
//! (`engine/cpp/fem_bc_io.cpp`), so both solvers load a model identically:
//!
//! * a selected face matches a boundary face by its (sorted) vertex triple or
//!   quadruple; duplicates count once, and faces that match nothing are
//!   reported;
//! * a load that matches no boundary face at all is refused;
//! * pressure p acts as the traction −p·n with n the outward unit normal;
//! * a total force F is spread as the uniform traction F / A over the matched
//!   area A, which must be positive (a quadrilateral's area integrated, as in
//!   MFEM, with the order-4 rule: 3² points);
//! * overlapping loads simply add up.

use crate::element::{quad_face_shape, square_rule};
use crate::error::FemError;
use crate::mesh::{
    cross, dot, local_edge, local_hex_edge, sub, ElementOrder, TetMesh, FACES_OF_HEX,
};

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

/// One boundary triangle: corners in the owning tet's order, outward
/// orientation not yet applied, and the tet's fourth vertex to orient it.
#[derive(Debug, Clone, Copy)]
struct TriangleFace {
    key: [u32; 3],
    corners: [u32; 3],
    opposite: u32,
    /// The nodes that carry the face's load: its corners on a linear mesh,
    /// its three edge nodes on a quadratic one (see the module notes).
    loaded: [u32; 3],
}

/// One boundary quadrilateral: corners in cyclic order, the owning hex's
/// centre to orient it, and the nodes its shape functions belong to.
#[derive(Debug, Clone, Copy)]
struct QuadFace {
    key: [u32; 4],
    corners: [u32; 4],
    inside: [f64; 3],
    /// Corners, then (quadratic) the edge nodes between consecutive corners
    /// and the face node — the order of `quad_face_shape`.
    nodes: [u32; 9],
}

/// The exterior faces of a solid mesh (faces used by exactly one element),
/// sorted by their vertices for lookup. Interfaces between bodies that share
/// nodes are interior, exactly as in the MFEM mesh. A hex face against two
/// tet triangles shares no face with them, so all three stay on the boundary,
/// as in MFEM.
#[derive(Debug, Clone)]
pub struct BoundaryFaces {
    triangles: Vec<TriangleFace>,
    quads: Vec<QuadFace>,
}

/// Local face k of a tet is the three corners other than k.
const FACES_OF_TET: [[usize; 3]; 4] = [[1, 2, 3], [0, 2, 3], [0, 1, 3], [0, 1, 2]];

fn sorted<const N: usize>(mut vertices: [u32; N]) -> [u32; N] {
    vertices.sort_unstable();
    vertices
}

/// The entries whose key occurs exactly once, sorted by key.
fn unique_by_key<T, K: Ord + Copy>(mut all: Vec<T>, key: impl Fn(&T) -> K) -> Vec<T> {
    all.sort_unstable_by_key(|entry| key(entry));
    let mut kept = Vec::new();
    let mut entries = all.into_iter().peekable();
    while let Some(entry) = entries.next() {
        let mut repeated = false;
        while entries.peek().is_some_and(|next| key(next) == key(&entry)) {
            entries.next();
            repeated = true;
        }
        if !repeated {
            kept.push(entry);
        }
    }
    kept
}

impl BoundaryFaces {
    #[must_use]
    pub fn new(mesh: &TetMesh) -> Self {
        let mut triangles = Vec::with_capacity(4 * mesh.tets().len());
        for (index, tet) in mesh.tets().iter().enumerate() {
            let nodes = mesh.element_nodes(index);
            for (opposite, local) in FACES_OF_TET.iter().enumerate() {
                let corners = local.map(|corner| tet[corner]);
                let loaded = match mesh.order() {
                    ElementOrder::Linear => corners,
                    ElementOrder::Quadratic => [[0, 1], [1, 2], [0, 2]]
                        .map(|[first, second]| nodes[4 + local_edge(local[first], local[second])]),
                };
                triangles.push(TriangleFace {
                    key: sorted(corners),
                    corners,
                    opposite: tet[opposite],
                    loaded,
                });
            }
        }
        let mut quads = Vec::with_capacity(6 * mesh.hexes().len());
        for (index, hex) in mesh.hexes().iter().enumerate() {
            let nodes = mesh.element_nodes(mesh.tets().len() + index);
            let points = mesh.hex_corners(index);
            let inside =
                [0, 1, 2].map(|axis| points.iter().map(|point| point[axis]).sum::<f64>() / 8.0);
            for (face, local) in FACES_OF_HEX.iter().enumerate() {
                let corners = local.map(|corner| hex[corner]);
                let mut face_nodes = [0; 9];
                face_nodes[..4].copy_from_slice(&corners);
                if mesh.order() == ElementOrder::Quadratic {
                    for side in 0..4 {
                        let edge = local_hex_edge(local[side], local[(side + 1) % 4]);
                        face_nodes[4 + side] = nodes[8 + edge];
                    }
                    face_nodes[8] = nodes[20 + face];
                }
                quads.push(QuadFace {
                    key: sorted(corners),
                    corners,
                    inside,
                    nodes: face_nodes,
                });
            }
        }
        Self {
            triangles: unique_by_key(triangles, |face| face.key),
            quads: unique_by_key(quads, |face| face.key),
        }
    }

    /// Boundary triangles plus boundary quadrilaterals.
    #[must_use]
    pub fn len(&self) -> usize {
        self.triangles.len() + self.quads.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.triangles.is_empty() && self.quads.is_empty()
    }

    fn find_triangle(&self, vertices: [u32; 3]) -> Option<usize> {
        let key = sorted(vertices);
        self.triangles
            .binary_search_by_key(&key, |face| face.key)
            .ok()
    }

    fn find_quad(&self, vertices: [u32; 4]) -> Option<usize> {
        let key = sorted(vertices);
        self.quads.binary_search_by_key(&key, |face| face.key).ok()
    }

    /// Outward area vector (normal × area) of boundary triangle `index`.
    fn area_vector(&self, mesh: &TetMesh, index: usize) -> [f64; 3] {
        let face = self.triangles[index];
        let points = mesh.vertices();
        let [first, second, third] = face.corners.map(|vertex| points[vertex as usize]);
        let doubled = cross(sub(second, first), sub(third, first));
        let inward = dot(doubled, sub(points[face.opposite as usize], first)) > 0.0;
        doubled.map(|component| if inward { -0.5 } else { 0.5 } * component)
    }

    /// Area of boundary quadrilateral `index`, integrated with the 3²-point
    /// rule MFEM uses for a force load's area.
    fn quad_area(&self, mesh: &TetMesh, index: usize) -> f64 {
        let patch = QuadPatch::new(mesh, &self.quads[index]);
        square_rule(3)
            .into_iter()
            .map(|(point, weight)| {
                let normal = patch.normal(point);
                weight * dot(normal, normal).sqrt()
            })
            .sum()
    }

    /// Add the nodal forces of one surface load to `forces` (3 per node).
    /// `triangles` and `quadrilaterals` hold the selected faces as vertex
    /// triples and quadruples; `load` names the load in errors.
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
        triangles: &[[u32; 3]],
        quadrilaterals: &[[u32; 4]],
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
        let selected = triangles.len() + quadrilaterals.len();
        let mut matched_triangles: Vec<usize> = triangles
            .iter()
            .filter_map(|&vertices| self.find_triangle(vertices))
            .collect();
        let mut matched_quads: Vec<usize> = quadrilaterals
            .iter()
            .filter_map(|&vertices| self.find_quad(vertices))
            .collect();
        let unmatched = selected - matched_triangles.len() - matched_quads.len();
        matched_triangles.sort_unstable();
        matched_triangles.dedup();
        matched_quads.sort_unstable();
        matched_quads.dedup();
        if matched_triangles.is_empty() && matched_quads.is_empty() {
            return Err(FemError::SurfaceLoadUnmatched {
                load,
                faces: selected,
            });
        }
        let area_vectors: Vec<[f64; 3]> = matched_triangles
            .iter()
            .map(|&index| self.area_vector(mesh, index))
            .collect();
        let total_area: f64 = area_vectors
            .iter()
            .map(|vector| dot(*vector, *vector).sqrt())
            .sum::<f64>()
            + matched_quads
                .iter()
                .map(|&index| self.quad_area(mesh, index))
                .sum::<f64>();
        if matches!(kind, SurfaceLoadKind::Force(_)) && total_area <= 0.0 {
            return Err(FemError::SurfaceLoadArea {
                load,
                area: total_area,
            });
        }
        // Force per unit area along the outward unit normal `unit`.
        let traction = |unit: [f64; 3]| -> [f64; 3] {
            match kind {
                SurfaceLoadKind::Pressure(pressure) => unit.map(|component| -pressure * component),
                SurfaceLoadKind::Traction(traction) => traction,
                SurfaceLoadKind::Force(force) => force.map(|component| component / total_area),
            }
        };
        for (&index, area_vector) in matched_triangles.iter().zip(&area_vectors) {
            let area = dot(*area_vector, *area_vector).sqrt();
            // Force on the whole face, a third to each loaded node.
            let face_force = traction(area_vector.map(|component| component / area))
                .map(|component| component * area);
            for node in self.triangles[index].loaded {
                for axis in 0..3 {
                    forces[3 * node as usize + axis] += face_force[axis] / 3.0;
                }
            }
        }
        let quadratic = mesh.order() == ElementOrder::Quadratic;
        let rule = square_rule(if quadratic { 3 } else { 2 });
        for &index in &matched_quads {
            let face = &self.quads[index];
            let patch = QuadPatch::new(mesh, face);
            let nodes = if quadratic {
                &face.nodes[..]
            } else {
                &face.nodes[..4]
            };
            for &(point, weight) in &rule {
                let normal = patch.normal(point);
                let scale = dot(normal, normal).sqrt();
                let density = traction(normal.map(|component| component / scale))
                    .map(|component| component * scale * weight);
                for (&node, shape) in nodes.iter().zip(quad_face_shape(quadratic, point)) {
                    for axis in 0..3 {
                        forces[3 * node as usize + axis] += shape * density[axis];
                    }
                }
            }
        }
        Ok(SurfaceLoadReport {
            matched: matched_triangles.len() + matched_quads.len(),
            unmatched,
        })
    }
}

/// The bilinear patch of a boundary quadrilateral, oriented outward.
struct QuadPatch {
    corners: [[f64; 3]; 4],
    /// +1 when the corners' cyclic order already points outward, −1 if not.
    sign: f64,
}

impl QuadPatch {
    fn new(mesh: &TetMesh, face: &QuadFace) -> Self {
        let points = mesh.vertices();
        let corners = face.corners.map(|vertex| points[vertex as usize]);
        let mut patch = Self { corners, sign: 1.0 };
        let centre =
            [0, 1, 2].map(|axis| corners.iter().map(|point| point[axis]).sum::<f64>() / 4.0);
        if dot(patch.normal([0.5, 0.5]), sub(face.inside, centre)) > 0.0 {
            patch.sign = -1.0;
        }
        patch
    }

    /// Outward normal scaled by the area element, `x_s × x_t`, at `point` of the
    /// unit square (corners at (0,0), (1,0), (1,1), (0,1)).
    fn normal(&self, point: [f64; 2]) -> [f64; 3] {
        let [first, second, third, fourth] = self.corners;
        let [along_s, along_t] = point;
        let tangent_s: [f64; 3] = std::array::from_fn(|axis| {
            (1.0 - along_t) * (second[axis] - first[axis]) + along_t * (third[axis] - fourth[axis])
        });
        let tangent_t: [f64; 3] = std::array::from_fn(|axis| {
            (1.0 - along_s) * (fourth[axis] - first[axis]) + along_s * (third[axis] - second[axis])
        });
        cross(tangent_s, tangent_t).map(|component| self.sign * component)
    }
}
