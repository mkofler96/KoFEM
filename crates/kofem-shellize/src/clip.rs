// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Plane clipping of the solid tets, the solid surface and the shell facets at
//! the shell/solid transition planes.

use std::collections::{BTreeSet, HashMap, HashSet};

use crate::error::ShellizeError;
use crate::geometry::{
    add, cross, dot, norm, scale, sub, unique_in_order, ShellizeMesh, Vec3, TET_FACES,
};
use crate::mid_surface::ShellExtraction;

/// A transition plane: the retained solid lies on its negative side.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TransitionPlane {
    pub origin: Vec3,
    pub normal: Vec3,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Side {
    Negative,
    Straddles,
    Positive,
}

/// Fan-triangulate a convex polygon from its lowest vertex index, so the two
/// elements sharing a face triangulate it the same way (conformity).
fn triangulate(polygon: &[usize]) -> Vec<[usize; 3]> {
    if polygon.len() < 3 {
        return Vec::new();
    }
    let start = polygon
        .iter()
        .enumerate()
        .min_by_key(|&(_, &vertex)| vertex)
        .map_or(0, |(position, _)| position);
    let ordered: Vec<usize> = polygon[start..]
        .iter()
        .chain(&polygon[..start])
        .copied()
        .collect();
    (1..ordered.len() - 1)
        .map(|i| [ordered[0], ordered[i], ordered[i + 1]])
        .collect()
}

#[derive(Debug, Clone)]
struct VolumePiece {
    faces: Vec<Vec<usize>>,
    retained: bool,
}

#[derive(Debug, Clone)]
struct SurfacePiece {
    polygon: Vec<usize>,
    retained: bool,
}

/// One clipper per node pool shares each edge/plane intersection between all
/// the elements that cut that edge; canonical face fans then keep the solid
/// mesh conforming.
struct PlaneClipper<'planes> {
    vertices: Vec<Vec3>,
    planes: &'planes [TransitionPlane],
    tolerance: f64,
    intersections: HashMap<(usize, usize, usize), usize>,
}

impl<'planes> PlaneClipper<'planes> {
    fn new(vertices: Vec<Vec3>, planes: &'planes [TransitionPlane], tolerance: f64) -> Self {
        Self {
            vertices,
            planes,
            tolerance,
            intersections: HashMap::new(),
        }
    }

    fn add_point(&mut self, point: Vec3) -> usize {
        self.vertices.push(point);
        self.vertices.len() - 1
    }

    #[allow(
        clippy::cast_precision_loss,
        reason = "a polygon's node count, used as an averaging divisor"
    )]
    fn center(&self, nodes: &[usize]) -> Vec3 {
        let mut center: Vec3 = [0.0; 3];
        let count = nodes.len() as f64;
        for &index in nodes {
            for (axis, value) in center.iter_mut().enumerate() {
                *value += self.vertices[index][axis] / count;
            }
        }
        center
    }

    fn distance(&self, index: usize, plane: usize) -> f64 {
        let transition = self.planes[plane];
        dot(
            sub(self.vertices[index], transition.origin),
            transition.normal,
        )
    }

    fn side(&self, nodes: &[usize], plane: usize) -> Side {
        let distances: Vec<f64> = nodes
            .iter()
            .map(|&index| self.distance(index, plane))
            .collect();
        if distances.iter().copied().fold(f64::NEG_INFINITY, f64::max) <= self.tolerance {
            return Side::Negative;
        }
        if distances.iter().copied().fold(f64::INFINITY, f64::min) >= -self.tolerance {
            return Side::Positive;
        }
        Side::Straddles
    }

    fn intersection(&mut self, first: usize, second: usize, plane: usize) -> usize {
        let start_distance = self.distance(first, plane);
        let end_distance = self.distance(second, plane);
        if start_distance.abs() <= self.tolerance {
            return first;
        }
        if end_distance.abs() <= self.tolerance {
            return second;
        }
        let key = (first.min(second), first.max(second), plane);
        if let Some(&existing) = self.intersections.get(&key) {
            return existing;
        }
        let ratio = start_distance / (start_distance - end_distance);
        let start = self.vertices[first];
        let point = add(start, scale(sub(self.vertices[second], start), ratio));
        let index = self.add_point(point);
        self.intersections.insert(key, index);
        index
    }

    fn clip_polygon(&mut self, polygon: &[usize], plane: usize, positive: bool) -> Vec<usize> {
        let sign = if positive { 1.0 } else { -1.0 };
        let mut output = Vec::with_capacity(polygon.len() + 2);
        for corner in 0..polygon.len() {
            let start = polygon[corner];
            let end = polygon[(corner + 1) % polygon.len()];
            let inside = sign * self.distance(start, plane) >= -self.tolerance;
            let next_inside = sign * self.distance(end, plane) >= -self.tolerance;
            if inside {
                output.push(start);
            }
            if inside != next_inside {
                output.push(self.intersection(start, end, plane));
            }
        }
        unique_in_order(output)
    }

    fn ordered_cap(&self, nodes: &[usize], plane: usize) -> Vec<usize> {
        let mut cap: Vec<usize> = nodes
            .iter()
            .copied()
            .filter(|&index| self.distance(index, plane).abs() <= self.tolerance)
            .collect();
        let center = self.center(&cap);
        let normal = self.planes[plane].normal;
        let seed: Vec3 = if normal[0].abs() < 0.8 {
            [1.0, 0.0, 0.0]
        } else {
            [0.0, 1.0, 0.0]
        };
        let first = cross(normal, seed);
        let second = cross(normal, first);
        let angle = |index: usize| {
            let offset = sub(self.vertices[index], center);
            dot(offset, second).atan2(dot(offset, first))
        };
        cap.sort_by(|&left, &right| angle(left).total_cmp(&angle(right)));
        cap
    }

    fn volume_side(
        &mut self,
        faces: &[Vec<usize>],
        plane: usize,
        positive: bool,
    ) -> Vec<Vec<usize>> {
        let mut clipped: Vec<Vec<usize>> = faces
            .iter()
            .map(|face| self.clip_polygon(face, plane, positive))
            .filter(|face| face.len() >= 3)
            .collect();
        let cap = self.ordered_cap(&unique_in_order(clipped.iter().flatten().copied()), plane);
        let existing = clipped
            .iter()
            .any(|face| face.len() == cap.len() && face.iter().all(|index| cap.contains(index)));
        if cap.len() >= 3 && !existing {
            clipped.push(cap);
        }
        clipped
    }

    fn split_volume(&mut self, piece: VolumePiece, plane: usize) -> Vec<VolumePiece> {
        let nodes = unique_in_order(piece.faces.iter().flatten().copied());
        match self.side(&nodes, plane) {
            Side::Negative => vec![VolumePiece {
                faces: piece.faces,
                retained: true,
            }],
            Side::Positive => vec![piece],
            Side::Straddles => {
                let negative = self.volume_side(&piece.faces, plane, false);
                let positive = self.volume_side(&piece.faces, plane, true);
                vec![
                    VolumePiece {
                        faces: negative,
                        retained: true,
                    },
                    VolumePiece {
                        faces: positive,
                        retained: piece.retained,
                    },
                ]
            }
        }
    }

    fn split_surface(&mut self, piece: SurfacePiece, plane: usize) -> Vec<SurfacePiece> {
        match self.side(&piece.polygon, plane) {
            Side::Negative => vec![SurfacePiece {
                polygon: piece.polygon,
                retained: true,
            }],
            Side::Positive => vec![piece],
            Side::Straddles => {
                let negative = self.clip_polygon(&piece.polygon, plane, false);
                let positive = self.clip_polygon(&piece.polygon, plane, true);
                [
                    SurfacePiece {
                        polygon: negative,
                        retained: true,
                    },
                    SurfacePiece {
                        polygon: positive,
                        retained: piece.retained,
                    },
                ]
                .into_iter()
                .filter(|part| part.polygon.len() >= 3)
                .collect()
            }
        }
    }
}

struct SolidOutput {
    tets: Vec<[usize; 4]>,
    body: Vec<i32>,
}

impl SolidOutput {
    fn add_tet(&mut self, clipper: &PlaneClipper, mut nodes: [usize; 4], body: i32) {
        let corners = nodes.map(|index| clipper.vertices[index]);
        let determinant = dot(
            sub(corners[1], corners[0]),
            cross(sub(corners[2], corners[0]), sub(corners[3], corners[0])),
        );
        if determinant.abs() <= clipper.tolerance.powi(3) {
            return;
        }
        if determinant < 0.0 {
            nodes.swap(1, 2);
        }
        self.tets.push(nodes);
        self.body.push(body);
    }

    fn add_volume(
        &mut self,
        clipper: &mut PlaneClipper,
        piece: &VolumePiece,
        original: [usize; 4],
        body: i32,
    ) {
        if !piece.retained {
            return;
        }
        let nodes = unique_in_order(piece.faces.iter().flatten().copied());
        if nodes.len() < 4 {
            return;
        }
        if nodes.len() == 4 && nodes.iter().all(|index| original.contains(index)) {
            self.add_tet(clipper, original, body);
            return;
        }
        let center = clipper.center(&nodes);
        let center = clipper.add_point(center);
        for face in &piece.faces {
            for [first, second, third] in triangulate(face) {
                self.add_tet(clipper, [first, second, third, center], body);
            }
        }
    }
}

fn clip_solid_tets(
    mesh: &ShellizeMesh,
    replaced: &BTreeSet<usize>,
    clipper: &mut PlaneClipper,
) -> SolidOutput {
    let mut output = SolidOutput {
        tets: Vec::new(),
        body: Vec::new(),
    };
    for (element, &nodes) in mesh.tets.iter().enumerate() {
        let mut pieces = vec![VolumePiece {
            faces: TET_FACES
                .iter()
                .map(|face| face.map(|corner| nodes[corner]).to_vec())
                .collect(),
            retained: !replaced.contains(&element),
        }];
        // Retained solids receive every cut too: otherwise a plane from a
        // perpendicular joint leaves hanging nodes on their shared interface.
        for plane in 0..clipper.planes.len() {
            pieces = pieces
                .into_iter()
                .flat_map(|piece| clipper.split_volume(piece, plane))
                .collect();
        }
        for piece in &pieces {
            output.add_volume(clipper, piece, nodes, mesh.body[element]);
        }
    }
    output
}

fn clip_solid_surface(
    mesh: &ShellizeMesh,
    shell_face_ids: &HashSet<i32>,
    clipper: &mut PlaneClipper,
) -> (Vec<[usize; 3]>, Vec<i32>) {
    let mut surf_tris = Vec::new();
    let mut surf_face = Vec::new();
    for (triangle, tri) in mesh.surf_tris.iter().enumerate() {
        let face = mesh.surf_face[triangle];
        let mut pieces = vec![SurfacePiece {
            polygon: tri.to_vec(),
            retained: !shell_face_ids.contains(&face),
        }];
        for plane in 0..clipper.planes.len() {
            pieces = pieces
                .into_iter()
                .flat_map(|piece| clipper.split_surface(piece, plane))
                .collect();
        }
        for piece in pieces.iter().filter(|piece| piece.retained) {
            for part in triangulate(&piece.polygon) {
                surf_tris.push(part);
                surf_face.push(face);
            }
        }
    }
    (surf_tris, surf_face)
}

/// Clip the shell facets to the positive (shell) side of every plane and
/// compact their nodes.
fn clip_shell_facets(
    shells: &ShellExtraction,
    planes: &[TransitionPlane],
    tolerance: f64,
) -> Result<ShellExtraction, ShellizeError> {
    let mut clipper = PlaneClipper::new(shells.vertices.clone(), planes, tolerance);
    let mut triangles: Vec<[usize; 3]> = Vec::new();
    let mut thicknesses = Vec::new();
    let mut sources = Vec::new();
    let mut node_sources = shells.node_source.clone();
    for (triangle, tri) in shells.triangles.iter().enumerate() {
        let mut polygon = tri.to_vec();
        for plane in 0..planes.len() {
            if polygon.len() < 3 {
                break;
            }
            polygon = clipper.clip_polygon(&polygon, plane, true);
        }
        node_sources.resize(clipper.vertices.len(), shells.triangle_source[triangle]);
        for part in triangulate(&polygon) {
            let [first, second, third] = part.map(|index| clipper.vertices[index]);
            if norm(cross(sub(second, first), sub(third, first))) <= tolerance * tolerance {
                continue;
            }
            triangles.push(part);
            thicknesses.push(shells.thicknesses[triangle]);
            sources.push(shells.triangle_source[triangle]);
        }
    }
    if triangles.is_empty() {
        return Err(ShellizeError::ShellTooShort);
    }
    let used = unique_in_order(triangles.iter().flatten().copied());
    let remap: HashMap<usize, usize> = used
        .iter()
        .enumerate()
        .map(|(position, &index)| (index, position))
        .collect();
    let mut compacted = Vec::with_capacity(triangles.len());
    for tri in &triangles {
        let mut mapped = [0usize; 3];
        for (corner, index) in tri.iter().enumerate() {
            mapped[corner] = *remap.get(index).ok_or(ShellizeError::Internal {
                reason: "missing clipped shell vertex",
            })?;
        }
        compacted.push(mapped);
    }
    Ok(ShellExtraction {
        walls: shells.walls.clone(),
        shell_body: shells.shell_body,
        vertices: used.iter().map(|&index| clipper.vertices[index]).collect(),
        triangles: compacted,
        thicknesses,
        node_source: used.iter().map(|&index| node_sources[index]).collect(),
        triangle_source: sources,
    })
}

/// Cut the mesh at the transition planes: retained solid keeps its side of
/// every plane (and the replaced tets on that side become retained), the solid
/// surface is cut alike, and the shell facets keep the other side.
///
/// # Errors
/// [`ShellizeError::ShellTooShort`] when no shell facet survives.
pub fn clip_shell_transition(
    mesh: &ShellizeMesh,
    shells: &ShellExtraction,
    replaced: &BTreeSet<usize>,
    planes: &[TransitionPlane],
    shell_face_ids: &HashSet<i32>,
    tolerance: f64,
) -> Result<(ShellizeMesh, ShellExtraction), ShellizeError> {
    let mut clipper = PlaneClipper::new(mesh.vertices.clone(), planes, tolerance);
    let solids = clip_solid_tets(mesh, replaced, &mut clipper);
    let (surf_tris, surf_face) = clip_solid_surface(mesh, shell_face_ids, &mut clipper);
    let clipped_shells = clip_shell_facets(shells, planes, tolerance)?;
    Ok((
        ShellizeMesh {
            vertices: clipper.vertices,
            tets: solids.tets,
            body: solids.body,
            surf_tris,
            surf_face,
        },
        clipped_shells,
    ))
}
