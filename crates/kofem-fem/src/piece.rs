// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The pieces an element is solved as. Almost every element is one piece:
//! itself. A hexahedron that meets tetrahedra on a face is several
//! ([`crate::transition`]): tetrahedra, and pyramids written as hexahedra
//! whose four top corners meet at the apex. Element routines run on the
//! pieces and add up, so a split element keeps its number, its material and
//! its one result.
//!
//! A pyramid of a quadratic transition holds one node that is not free: the
//! centre of a side triangle it shares with a tetrahedron. The pyramid's
//! field on that triangle has one more node than the tetrahedron's quadratic
//! one, so the centre takes the value the tetrahedron's field has there, a
//! fixed combination of the triangle's six other nodes ([`Blend`]). Values
//! read at the pyramid's nodes expand the blend ([`PieceRef::local_values`]),
//! and what the pyramid puts on its nodes (forces, stiffness) folds back onto
//! the six ([`PieceRef::fold_rows`], [`PieceRef::fold_matrix`]).

use crate::element::{
    cube_rule, hex27_reference_gradients, hex27_shape, hex27_stiffness, hex8_reference_gradients,
    hex8_shape, hex8_stiffness, hex_gradients, tet10_gradients, tet10_shape, tet10_stiffness,
    tet4_gradients, tet4_stiffness, CENTROID, HEX27_RULE_POINTS, HEX8_RULE_POINTS, HEX_CENTRE,
    HEX_CORNERS,
};
use crate::material::Isotropic;
use crate::mesh::{signed_volume, ElementOrder, TetMesh};

/// The corners of a piece.
#[derive(Debug, Clone, Copy)]
pub enum PieceGeometry {
    Tetrahedron([[f64; 3]; 4]),
    /// In CHEXA order; a pyramid repeats its apex as corners 4 to 7.
    Hexahedron([[f64; 3]; 8]),
}

/// A node of a piece whose value is a combination of other nodes of the same
/// piece: node `slot` = Σ weight · node `source`.
#[derive(Debug, Clone, PartialEq)]
pub struct Blend {
    pub slot: usize,
    pub sources: Vec<(usize, f64)>,
}

/// A piece as the mesh stores it.
#[derive(Debug, Clone)]
pub(crate) struct Piece {
    pub(crate) geometry: PieceGeometry,
    /// One global node per shape function, in the element's local order (4,
    /// 10, 8 or 27); a pyramid repeats its apex, and a blended slot holds a
    /// node of the piece whose value it does not use.
    pub(crate) nodes: Vec<u32>,
    pub(crate) blends: Vec<Blend>,
}

/// A point of a piece: barycentric in a tetrahedron, unit-cube coordinates
/// in a hexahedron.
#[derive(Debug, Clone, Copy)]
pub enum PiecePoint {
    Tetrahedron([f64; 4]),
    Hexahedron([f64; 3]),
}

/// One piece of an element, ready for element routines.
#[derive(Debug, Clone, Copy)]
pub struct PieceRef<'a> {
    pub geometry: PieceGeometry,
    pub nodes: &'a [u32],
    pub order: ElementOrder,
    pub(crate) blends: &'a [Blend],
}

impl PieceRef<'_> {
    /// Shape-function values at `point`, in node order.
    #[must_use]
    pub fn shape_values(&self, point: PiecePoint) -> Vec<f64> {
        match (point, self.order) {
            (PiecePoint::Tetrahedron(local), ElementOrder::Linear) => local.to_vec(),
            (PiecePoint::Tetrahedron(local), ElementOrder::Quadratic) => {
                tet10_shape(local).to_vec()
            }
            (PiecePoint::Hexahedron(local), ElementOrder::Linear) => hex8_shape(local).to_vec(),
            (PiecePoint::Hexahedron(local), ElementOrder::Quadratic) => hex27_shape(local).to_vec(),
        }
    }

    /// Physical shape-function gradients at `point`, in node order, and the
    /// volume scale there (the tet's volume, |det J| of a hex).
    #[must_use]
    pub fn gradients(&self, point: PiecePoint) -> (Vec<[f64; 3]>, f64) {
        match (self.geometry, point) {
            (PieceGeometry::Tetrahedron(corners), PiecePoint::Tetrahedron(local)) => {
                let (corner_gradients, volume) = tet4_gradients(&corners);
                match self.order {
                    ElementOrder::Linear => (corner_gradients.to_vec(), volume),
                    ElementOrder::Quadratic => {
                        (tet10_gradients(&corner_gradients, local).to_vec(), volume)
                    }
                }
            }
            (PieceGeometry::Hexahedron(corners), PiecePoint::Hexahedron(local)) => {
                match self.order {
                    ElementOrder::Linear => {
                        let (gradients, scale) =
                            hex_gradients(&corners, &hex8_reference_gradients(local), local);
                        (gradients.to_vec(), scale)
                    }
                    ElementOrder::Quadratic => {
                        let (gradients, scale) =
                            hex_gradients(&corners, &hex27_reference_gradients(local), local);
                        (gradients.to_vec(), scale)
                    }
                }
            }
            _ => unreachable!("a piece is sampled at its own kind of point"),
        }
    }

    /// The points and weights (times the volume scale) of the rule that
    /// integrates the piece's stiffness, with the gradients there.
    #[must_use]
    pub fn stiffness_points(&self) -> Vec<(PiecePoint, Vec<[f64; 3]>, f64)> {
        match self.geometry {
            PieceGeometry::Tetrahedron(_) => match self.order {
                ElementOrder::Linear => {
                    let point = PiecePoint::Tetrahedron(CENTROID);
                    let (gradients, volume) = self.gradients(point);
                    vec![(point, gradients, volume)]
                }
                ElementOrder::Quadratic => crate::element::degree_two_points()
                    .into_iter()
                    .map(|local| {
                        let point = PiecePoint::Tetrahedron(local);
                        let (gradients, volume) = self.gradients(point);
                        (point, gradients, 0.25 * volume)
                    })
                    .collect(),
            },
            PieceGeometry::Hexahedron(_) => {
                let points_per_axis = match self.order {
                    ElementOrder::Linear => HEX8_RULE_POINTS,
                    ElementOrder::Quadratic => HEX27_RULE_POINTS,
                };
                cube_rule(points_per_axis)
                    .into_iter()
                    .map(|(local, weight)| {
                        let point = PiecePoint::Hexahedron(local);
                        let (gradients, scale) = self.gradients(point);
                        (point, gradients, weight * scale)
                    })
                    .collect()
            }
        }
    }

    /// The stiffness of the piece over its nodes, row-major (3·node +
    /// component), blends folded in.
    #[must_use]
    pub fn stiffness(&self, material: &Isotropic) -> Vec<f64> {
        let mut matrix = match (self.geometry, self.order) {
            (PieceGeometry::Tetrahedron(corners), ElementOrder::Linear) => {
                tet4_stiffness(&corners, material).as_flattened().to_vec()
            }
            (PieceGeometry::Tetrahedron(corners), ElementOrder::Quadratic) => {
                tet10_stiffness(&corners, material).as_flattened().to_vec()
            }
            (PieceGeometry::Hexahedron(corners), ElementOrder::Linear) => {
                hex8_stiffness(&corners, material).as_flattened().to_vec()
            }
            (PieceGeometry::Hexahedron(corners), ElementOrder::Quadratic) => {
                hex27_stiffness(&corners, material).as_flattened().to_vec()
            }
        };
        self.fold_matrix(&mut matrix);
        matrix
    }

    /// The volume of the piece.
    #[must_use]
    pub fn volume(&self) -> f64 {
        match self.geometry {
            PieceGeometry::Tetrahedron(corners) => signed_volume(&corners).abs(),
            // det J of a trilinear map is of degree two in each coordinate.
            PieceGeometry::Hexahedron(corners) => cube_rule(2)
                .into_iter()
                .map(|(local, weight)| {
                    weight * hex_gradients(&corners, &hex8_reference_gradients(local), local).1
                })
                .sum(),
        }
    }

    /// The reference centre of the piece.
    #[must_use]
    pub fn centre(&self) -> PiecePoint {
        match self.geometry {
            PieceGeometry::Tetrahedron(_) => PiecePoint::Tetrahedron(CENTROID),
            PieceGeometry::Hexahedron(_) => PiecePoint::Hexahedron(HEX_CENTRE),
        }
    }

    /// The reference point of corner `corner` (in node order).
    #[must_use]
    pub fn corner(&self, corner: usize) -> PiecePoint {
        match self.geometry {
            PieceGeometry::Tetrahedron(_) => {
                let mut local = [0.0; 4];
                local[corner] = 1.0;
                PiecePoint::Tetrahedron(local)
            }
            PieceGeometry::Hexahedron(_) => {
                PiecePoint::Hexahedron(HEX_CORNERS[corner].map(f64::from))
            }
        }
    }

    /// The values of a nodal field (`width` per node) at the piece's nodes,
    /// blends expanded.
    #[must_use]
    pub fn local_values(&self, field: &[f64], width: usize) -> Vec<f64> {
        let mut values: Vec<f64> = self
            .nodes
            .iter()
            .flat_map(|&node| {
                let base = width * node as usize;
                field[base..base + width].iter().copied()
            })
            .collect();
        for blend in self.blends {
            for component in 0..width {
                values[width * blend.slot + component] = blend
                    .sources
                    .iter()
                    .map(|&(source, weight)| weight * values[width * source + component])
                    .sum();
            }
        }
        values
    }

    /// Fold what the piece puts on a blended slot onto its sources: `data`
    /// holds `width` values per node, in node order.
    pub fn fold_rows(&self, data: &mut [f64], width: usize) {
        for blend in self.blends {
            for component in 0..width {
                let value = std::mem::take(&mut data[width * blend.slot + component]);
                for &(source, weight) in &blend.sources {
                    data[width * source + component] += weight * value;
                }
            }
        }
    }

    /// Fold a square matrix over the piece's DOFs (3 per node, row-major) on
    /// both sides: `Tᵀ·K·T` with T the blends.
    pub fn fold_matrix(&self, matrix: &mut [f64]) {
        if self.blends.is_empty() {
            return;
        }
        let width = 3 * self.nodes.len();
        debug_assert_eq!(matrix.len(), width * width);
        // Rows: each row is one DOF, so a node is 3 rows of `width` values.
        self.fold_rows(matrix, 3 * width);
        // Columns: within each row, 3 values per node.
        for row in matrix.chunks_exact_mut(width) {
            self.fold_rows(row, 3);
        }
    }

    /// The displacement gradient `∇u[i][j] = ∂u_i/∂x_j` at `point`.
    #[must_use]
    pub fn displacement_gradient(&self, point: PiecePoint, displacements: &[f64]) -> [[f64; 3]; 3] {
        let (gradients, _) = self.gradients(point);
        let values = self.local_values(displacements, 3);
        let mut gradient = [[0.0; 3]; 3];
        for (motion, shape) in values.as_chunks::<3>().0.iter().zip(&gradients) {
            for (row, entries) in gradient.iter_mut().enumerate() {
                for (col, entry) in entries.iter_mut().enumerate() {
                    *entry += motion[row] * shape[col];
                }
            }
        }
        gradient
    }
}

/// Where an element's value at its centre is read: its own centre, or for a
/// transition element the centre of each piece, weighted by its share of
/// the volume — the element's mean.
pub(crate) fn centre_samples(
    mesh: &TetMesh,
    element: usize,
) -> Vec<(PieceRef<'_>, PiecePoint, f64)> {
    let mut samples: Vec<(PieceRef<'_>, PiecePoint, f64)> = mesh
        .pieces(element)
        .map(|piece| (piece, piece.centre(), piece.volume()))
        .collect();
    let total: f64 = samples.iter().map(|sample| sample.2).sum();
    for sample in &mut samples {
        sample.2 /= total;
    }
    samples
}

/// Where an element's value at its corner `corner` (in its node order) is
/// read: that corner of every piece it is a corner of, weighted alike.
pub(crate) fn corner_samples(
    mesh: &TetMesh,
    element: usize,
    corner: usize,
) -> Vec<(PieceRef<'_>, PiecePoint, f64)> {
    let node = mesh.element_corners(element)[corner];
    let mut samples: Vec<(PieceRef<'_>, PiecePoint, f64)> = mesh
        .pieces(element)
        .filter_map(|piece| {
            let corners = match piece.geometry {
                PieceGeometry::Tetrahedron(_) => 4,
                PieceGeometry::Hexahedron(_) => 8,
            };
            piece.nodes[..corners]
                .iter()
                .position(|&candidate| candidate == node)
                .map(|slot| (piece, piece.corner(slot), 1.0))
        })
        .collect();
    let share = 1.0 / crate::count::count_as_f64(samples.len());
    for sample in &mut samples {
        sample.2 = share;
    }
    samples
}

/// The stiffness of `element` over [`TetMesh::element_nodes`], row-major
/// (3·node + component): its pieces' stiffnesses added up.
#[must_use]
pub fn element_stiffness(mesh: &TetMesh, element: usize) -> Vec<f64> {
    let material = mesh.material(element);
    let nodes = mesh.element_nodes(element);
    let width = 3 * nodes.len();
    let mut matrix = vec![0.0; width * width];
    for piece in mesh.pieces(element) {
        let local = piece.stiffness(material);
        let slots: Vec<usize> = piece
            .nodes
            .iter()
            .map(|node| {
                nodes
                    .iter()
                    .position(|candidate| candidate == node)
                    .unwrap_or_else(|| unreachable!("a piece uses the element's nodes"))
            })
            .collect();
        let piece_width = 3 * slots.len();
        for (row_local, &row_slot) in slots.iter().enumerate() {
            for (col_local, &col_slot) in slots.iter().enumerate() {
                for row in 0..3 {
                    for col in 0..3 {
                        matrix[width * (3 * row_slot + row) + 3 * col_slot + col] +=
                            local[piece_width * (3 * row_local + row) + 3 * col_local + col];
                    }
                }
            }
        }
    }
    matrix
}

/// The shape-function gradients of `element` at its centre, over
/// [`TetMesh::element_nodes`]: for a transition element, the volume mean of
/// its pieces' gradients at their centres, so that `∇u = Σ u_a ⊗ g_a` is the
/// mean gradient [`centre_samples`] gives.
#[must_use]
pub fn centre_gradients(mesh: &TetMesh, element: usize) -> Vec<[f64; 3]> {
    let nodes = mesh.element_nodes(element);
    let mut gradients = vec![[0.0; 3]; nodes.len()];
    for (piece, point, weight) in centre_samples(mesh, element) {
        let mut local: Vec<f64> = piece.gradients(point).0.into_iter().flatten().collect();
        piece.fold_rows(&mut local, 3);
        for (node, gradient) in piece.nodes.iter().zip(local.as_chunks::<3>().0) {
            let slot = nodes
                .iter()
                .position(|candidate| candidate == node)
                .unwrap_or_else(|| unreachable!("a piece uses the element's nodes"));
            for axis in 0..3 {
                gradients[slot][axis] += weight * gradient[axis];
            }
        }
    }
    gradients
}
