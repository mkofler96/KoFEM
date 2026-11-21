// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The result section cut: a plane normal to x, y or z through the (deformed)
//! model, keeping the part below it (above it when flipped).
//!
//! * Solid elements are cut into a filled **cap** — marching tetrahedra, a
//!   hexahedron split into six tetrahedra about its 0–6 diagonal — with the
//!   nodal field interpolated linearly along each cut edge, as it varies over
//!   a linear tetrahedron. Every cap triangle faces the removed part, so the
//!   cap shades evenly.
//! * Shell facets have no inside; each crossing facet is cut into a **line**
//!   segment carrying the field the same way.
//!
//! The viewport clips the drawn surface at the same plane and draws the cap
//! and the lines over it.

use std::collections::HashMap;

use crate::error::FemError;

/// The model to cut: node coordinates (x, y, z per node, deformed as drawn),
/// one field value per node, and the element connectivities by node index.
#[derive(Debug, Clone, Copy)]
pub struct SectionMesh<'a> {
    pub points: &'a [f64],
    pub values: &'a [f64],
    /// Four nodes per tetrahedron (its corners).
    pub tets: &'a [u32],
    /// Eight nodes per hexahedron, bottom face then top face.
    pub hexes: &'a [u32],
    /// Three nodes per shell facet.
    pub shell_triangles: &'a [u32],
}

/// The plane: `axis` 0, 1 or 2 (x, y, z) at coordinate `level`. The part
/// below it is kept, or the part above it when `flipped`.
#[derive(Debug, Clone, Copy)]
pub struct SectionPlane {
    pub axis: usize,
    pub level: f64,
    pub flipped: bool,
}

/// The cut: the cap (points, a value per point, triangles) and the shell
/// lines (two points per segment, a value per point).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SectionCut {
    pub cap_points: Vec<f64>,
    pub cap_values: Vec<f64>,
    pub cap_triangles: Vec<u32>,
    pub line_points: Vec<f64>,
    pub line_values: Vec<f64>,
}

/// A hexahedron (CHEXA corner order) as six tetrahedra about its 0–6 diagonal.
const HEX_TETS: [[usize; 4]; 6] = [
    [0, 1, 2, 6],
    [0, 2, 3, 6],
    [0, 3, 7, 6],
    [0, 7, 4, 6],
    [0, 4, 5, 6],
    [0, 5, 1, 6],
];

fn invalid(reason: String) -> FemError {
    FemError::SectionInput { reason }
}

fn check_connectivity(
    what: &str,
    nodes: &[u32],
    per_element: usize,
    node_count: usize,
) -> Result<(), FemError> {
    if !nodes.len().is_multiple_of(per_element) {
        return Err(invalid(format!(
            "{what} array has {} indices, which is not a multiple of {per_element}",
            nodes.len()
        )));
    }
    if let Some(&node) = nodes.iter().find(|&&node| node as usize >= node_count) {
        return Err(invalid(format!(
            "a {what} references node {node}, but the model has {node_count} nodes"
        )));
    }
    Ok(())
}

/// Cut the model by the plane.
///
/// # Errors
/// [`FemError::SectionInput`] for an axis other than 0, 1 or 2, a non-finite
/// level, coordinates not in triples, a value count that differs from the
/// node count, or a connectivity with a ragged length or an unknown node.
pub fn section_cut(mesh: &SectionMesh<'_>, plane: SectionPlane) -> Result<SectionCut, FemError> {
    let SectionPlane { axis, level, .. } = plane;
    if axis > 2 {
        return Err(invalid(format!(
            "the section axis must be 0, 1 or 2, got {axis}"
        )));
    }
    if !level.is_finite() {
        return Err(invalid(format!(
            "the section position must be finite, got {level}"
        )));
    }
    if !mesh.points.len().is_multiple_of(3) {
        return Err(invalid(format!(
            "{} coordinates, which is not a multiple of 3",
            mesh.points.len()
        )));
    }
    let node_count = mesh.points.len() / 3;
    if mesh.values.len() != node_count {
        return Err(invalid(format!(
            "{} values for {node_count} nodes",
            mesh.values.len()
        )));
    }
    check_connectivity("tetrahedron", mesh.tets, 4, node_count)?;
    check_connectivity("hexahedron", mesh.hexes, 8, node_count)?;
    check_connectivity("shell facet", mesh.shell_triangles, 3, node_count)?;

    let mut cutter = Cutter::new(mesh, plane);
    for tet in mesh.tets.as_chunks::<4>().0 {
        cutter.cut_tet(*tet)?;
    }
    for hex in mesh.hexes.as_chunks::<8>().0 {
        for corners in HEX_TETS {
            cutter.cut_tet(corners.map(|corner| hex[corner]))?;
        }
    }
    for facet in mesh.shell_triangles.as_chunks::<3>().0 {
        cutter.cut_facet(*facet);
    }
    Ok(cutter.out)
}

struct Cutter<'a> {
    mesh: &'a SectionMesh<'a>,
    axis: usize,
    level: f64,
    /// +1 when the part below is kept (the cap faces +axis), −1 when flipped.
    side: f64,
    /// The cap point of each cut edge, shared by the triangles that use it.
    crossings: HashMap<(u32, u32), u32>,
    out: SectionCut,
}

impl<'a> Cutter<'a> {
    fn new(mesh: &'a SectionMesh<'a>, plane: SectionPlane) -> Self {
        Self {
            mesh,
            axis: plane.axis,
            level: plane.level,
            side: if plane.flipped { -1.0 } else { 1.0 },
            crossings: HashMap::new(),
            out: SectionCut::default(),
        }
    }

    fn coordinate(&self, node: u32, component: usize) -> f64 {
        self.mesh.points[3 * node as usize + component]
    }

    /// Signed distance from the plane, positive on the removed side.
    fn distance(&self, node: u32) -> f64 {
        self.side * (self.coordinate(node, self.axis) - self.level)
    }

    /// Where the edge `from`–`to` crosses the plane: its point and value.
    fn crossing(&self, from: u32, to: u32) -> ([f64; 3], f64) {
        let (near, far) = (self.distance(from), self.distance(to));
        let fraction = near / (near - far);
        let point = [0, 1, 2].map(|component| {
            let start = self.coordinate(from, component);
            start + fraction * (self.coordinate(to, component) - start)
        });
        let start = self.mesh.values[from as usize];
        let end = self.mesh.values[to as usize];
        (point, start + fraction * (end - start))
    }

    fn cap_point(&mut self, from: u32, to: u32) -> Result<u32, FemError> {
        let key = if from < to { (from, to) } else { (to, from) };
        if let Some(&id) = self.crossings.get(&key) {
            return Ok(id);
        }
        let (point, value) = self.crossing(key.0, key.1);
        let id = u32::try_from(self.out.cap_values.len()).map_err(|_| {
            invalid("the cap has more points than a 32-bit index can number".into())
        })?;
        self.out.cap_points.extend_from_slice(&point);
        self.out.cap_values.push(value);
        self.crossings.insert(key, id);
        Ok(id)
    }

    /// Add a cap triangle wound so its normal points to the removed side.
    fn cap_triangle(&mut self, corners: [u32; 3]) {
        let at = |corner: usize, component: usize| {
            self.out.cap_points[3 * corners[corner] as usize + component]
        };
        let (first, second) = ((self.axis + 1) % 3, (self.axis + 2) % 3);
        let normal = (at(1, first) - at(0, first)) * (at(2, second) - at(0, second))
            - (at(1, second) - at(0, second)) * (at(2, first) - at(0, first));
        let [one, two, three] = corners;
        if normal * self.side >= 0.0 {
            self.out.cap_triangles.extend_from_slice(&[one, two, three]);
        } else {
            self.out.cap_triangles.extend_from_slice(&[one, three, two]);
        }
    }

    fn cut_tet(&mut self, corners: [u32; 4]) -> Result<(), FemError> {
        let (kept, removed): (Vec<u32>, Vec<u32>) =
            corners.iter().partition(|&&node| self.distance(node) < 0.0);
        match (kept.len(), removed.len()) {
            (1, 3) | (3, 1) => {
                let (lone, others) = if kept.len() == 1 {
                    (kept[0], &removed)
                } else {
                    (removed[0], &kept)
                };
                let triangle = [
                    self.cap_point(lone, others[0])?,
                    self.cap_point(lone, others[1])?,
                    self.cap_point(lone, others[2])?,
                ];
                self.cap_triangle(triangle);
            }
            (2, 2) => {
                let ring = [
                    self.cap_point(kept[0], removed[0])?,
                    self.cap_point(kept[0], removed[1])?,
                    self.cap_point(kept[1], removed[1])?,
                    self.cap_point(kept[1], removed[0])?,
                ];
                self.cap_triangle([ring[0], ring[1], ring[2]]);
                self.cap_triangle([ring[0], ring[2], ring[3]]);
            }
            _ => {}
        }
        Ok(())
    }

    fn cut_facet(&mut self, corners: [u32; 3]) {
        let mut ends = Vec::with_capacity(2);
        for edge in 0..3 {
            let (from, to) = (corners[edge], corners[(edge + 1) % 3]);
            if (self.distance(from) < 0.0) != (self.distance(to) < 0.0) {
                ends.push(self.crossing(from, to));
            }
        }
        if let [(start, start_value), (end, end_value)] = ends[..] {
            self.out.line_points.extend_from_slice(&start);
            self.out.line_points.extend_from_slice(&end);
            self.out
                .line_values
                .extend_from_slice(&[start_value, end_value]);
        }
    }
}
