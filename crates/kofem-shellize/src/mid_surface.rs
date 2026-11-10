// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Collapse the detected thin walls to Kirchhoff shell mid-surface facets, one
//! thickness per wall, welded where walls meet.

use std::collections::{BTreeSet, HashMap, HashSet};

use crate::error::ShellizeError;
use crate::geometry::{add, dot, norm, scale, sub, OrderedMap, ShellizeMesh, Vec3};
use crate::junction::{clearance, imprint, Imprint};
use crate::walls::{detect_walls, face_props, FaceProp, PairedWall, Wall};

/// The shell mid-surface of one body: facets over their own local node
/// numbering, one thickness and one source CAD face per facet.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ShellExtraction {
    pub walls: Vec<Wall>,
    /// The shelled body, `None` when no thin wall was found.
    pub shell_body: Option<i32>,
    pub vertices: Vec<Vec3>,
    pub triangles: Vec<[usize; 3]>,
    pub thicknesses: Vec<f64>,
    /// Source CAD face per shell node (for a welded fold node, one of them).
    pub node_source: Vec<i32>,
    /// Source CAD face per shell triangle — unambiguous, so a BC on a folded
    /// face reaches every node of its facets.
    pub triangle_source: Vec<i32>,
}

/// Options of [`extract_thin_wall_shells`].
#[derive(Debug, Clone)]
pub struct ExtractOptions {
    /// Thickest gap still treated as a wall.
    pub max_wall: f64,
    /// Bodies the user marked Shell; `None` lets the largest wall's body win.
    pub shell_body_ids: Option<Vec<i32>>,
}

impl Default for ExtractOptions {
    fn default() -> Self {
        Self {
            max_wall: 15.0,
            shell_body_ids: None,
        }
    }
}

/// A base wall's facets, and the junction nodes and segments to imprint there.
type Junction = (Vec<[usize; 3]>, Vec<usize>, Vec<[usize; 2]>);

/// One plane a mid-surface node must reach: `normal · Δ = target`.
#[derive(Debug, Clone, Copy)]
struct Constraint {
    normal: Vec3,
    target: f64,
}

/// Where a node lies on ONE wall the mid-surface is that wall's face offset t/2
/// along −n. A node on the CAD edge where two walls meet lies on both, and must
/// land on the LINE where the two mid-planes cross (three walls ⇒ the corner
/// point). Solving `n_w·Δ = −t_w/2` for every wall `w` the node belongs to gives
/// that point; the walls are applied in face order, each along the direction
/// the earlier ones leave free, so every accepted constraint holds exactly.
///
/// Offsetting along a single wall's normal instead leaves the node up to t/2
/// off the other wall's mid-plane, so the wall tets there are not found within
/// t/2 of the mid-surface and survive as floating slivers (KOF-191).
///
/// A node on the edge where a wall stands on another wall's inner face (a
/// T-junction) gets that other wall's mid-plane as a further constraint, so the
/// standing wall reaches the mid-plane it is welded into.
fn mid_surface_offset(constraints: &[Constraint]) -> Vec3 {
    let mut delta: Vec3 = [0.0; 3];
    let mut basis: Vec<Vec3> = Vec::new();
    for constraint in constraints {
        let mut residual = constraint.normal;
        for used in &basis {
            let projection = dot(residual, *used);
            for axis in 0..3 {
                residual[axis] -= projection * used[axis];
            }
        }
        let length = norm(residual);
        // Nothing left to move along ⇒ this wall's mid-plane is (near) parallel
        // to one already enforced, so it already holds to within t/2·sin(angle).
        if length < 0.2 {
            continue;
        }
        let direction = scale(residual, 1.0 / length);
        let along = dot(constraint.normal, delta);
        let step = (constraint.target - along) / dot(constraint.normal, direction);
        delta = add(delta, scale(direction, step));
        basis.push(direction);
    }
    delta
}

/// Union–find root with path halving.
fn find(representative: &mut [usize], mut node: usize) -> usize {
    while representative[node] != node {
        representative[node] = representative[representative[node]];
        node = representative[node];
    }
    node
}

/// Signed distance of `point` from a wall's mid-plane (the kept face's plane
/// moved t/2 into the material).
fn from_mid_plane(point: Vec3, wall: &Wall, kept: &FaceProp) -> f64 {
    dot(wall.normal, sub(point, kept.centroid)) + wall.thickness / 2.0
}

/// Collapse the kept wall faces to mid-surface facets and weld mid-surface
/// nodes that came from the SAME original mesh node. Where two walls meet at a
/// CAD edge they share Netgen's edge nodes, so joining by original id fuses the
/// walls exactly — independent of mesh resolution.
///
/// Where a wall stands on another wall's inner face (a T-junction: an I-beam
/// web on a flange) no node is shared: the standing wall's edge nodes are moved
/// onto the other wall's mid-plane and imprinted into its facets
/// ([`crate::junction`]).
#[allow(
    clippy::too_many_lines,
    reason = "one pass per stage of the collapse; splitting it would only thread its tables through helpers"
)]
fn collapse_walls_to_mid_surface(
    mesh: &ShellizeMesh,
    walls: &[PairedWall],
    faces: &[FaceProp],
) -> Result<ShellExtraction, ShellizeError> {
    let keep: HashMap<i32, Wall> = walls
        .iter()
        .map(|paired| (paired.wall.keep, paired.wall))
        .collect();
    let face_of: HashMap<i32, &FaceProp> = faces.iter().map(|face| (face.id, face)).collect();
    let kept_face = |wall: &Wall| {
        face_of
            .get(&wall.keep)
            .copied()
            .ok_or(ShellizeError::UnknownWallFace { face: wall.keep })
    };
    // Inner (partner) face → the wall it belongs to.
    let partner_wall: HashMap<i32, i32> = walls
        .iter()
        .flat_map(|paired| {
            paired
                .partners
                .iter()
                .map(move |&partner| (partner, paired.wall.keep))
        })
        .collect();

    // Every kept wall each node lies on — a junction node belongs to several —
    // and every wall whose inner face it lies on.
    let mut walls_of_node: OrderedMap<usize, BTreeSet<i32>> = OrderedMap::new();
    let mut inner_walls_of_node: HashMap<usize, BTreeSet<i32>> = HashMap::new();
    for (triangle, tri) in mesh.surf_tris.iter().enumerate() {
        let face = mesh.surf_face[triangle];
        if keep.contains_key(&face) {
            for &vertex in tri {
                walls_of_node
                    .get_or_insert_with(vertex, BTreeSet::new)
                    .insert(face);
            }
        } else if let Some(&wall) = partner_wall.get(&face) {
            for &vertex in tri {
                inner_walls_of_node.entry(vertex).or_default().insert(wall);
            }
        }
    }
    // Where each node sits on its kept walls' mid-planes; and, for a node
    // that also lies on another wall's inner face, where it sits once that
    // wall's mid-plane is added (its place if it turns out to be a T-junction).
    let mut offset_of_node: HashMap<usize, Vec3> = HashMap::with_capacity(walls_of_node.len());
    let mut junction_offset: HashMap<usize, Vec3> = HashMap::new();
    for (&vertex, node_walls) in walls_of_node.iter() {
        let mut constraints = Vec::with_capacity(node_walls.len());
        for face in node_walls {
            let wall = keep
                .get(face)
                .ok_or(ShellizeError::UnknownWallFace { face: *face })?;
            constraints.push(Constraint {
                normal: wall.normal,
                target: -wall.thickness / 2.0,
            });
        }
        offset_of_node.insert(vertex, mid_surface_offset(&constraints));
        let kept_only = constraints.len();
        for face in inner_walls_of_node.get(&vertex).into_iter().flatten() {
            if node_walls.contains(face) {
                continue;
            }
            let wall = keep
                .get(face)
                .ok_or(ShellizeError::UnknownWallFace { face: *face })?;
            constraints.push(Constraint {
                normal: wall.normal,
                target: -from_mid_plane(mesh.vertices[vertex], wall, kept_face(wall)?),
            });
        }
        if constraints.len() > kept_only {
            junction_offset.insert(vertex, mid_surface_offset(&constraints));
        }
    }

    let mut raw_vertices: Vec<Vec3> = Vec::new();
    let mut raw_source: Vec<i32> = Vec::new();
    let mut raw_original: Vec<usize> = Vec::new();
    let mut raw_triangles: Vec<[usize; 3]> = Vec::new();
    let mut raw_thickness: Vec<f64> = Vec::new();
    let mut raw_triangle_source: Vec<i32> = Vec::new();
    let mut node_of: HashMap<(i32, usize), usize> = HashMap::new();
    for (triangle, tri) in mesh.surf_tris.iter().enumerate() {
        let Some(wall) = keep.get(&mesh.surf_face[triangle]) else {
            continue;
        };
        let mut nodes = [0usize; 3];
        for (corner, &original) in tri.iter().enumerate() {
            nodes[corner] = if let Some(&existing) = node_of.get(&(wall.keep, original)) {
                existing
            } else {
                // Every node of a kept face was given an offset above.
                let delta = offset_of_node
                    .get(&original)
                    .copied()
                    .ok_or(ShellizeError::UnknownWallFace { face: wall.keep })?;
                let id = raw_vertices.len();
                node_of.insert((wall.keep, original), id);
                raw_vertices.push(add(mesh.vertices[original], delta));
                raw_source.push(wall.keep);
                raw_original.push(original);
                id
            };
        }
        raw_triangles.push(nodes);
        raw_thickness.push(wall.thickness);
        raw_triangle_source.push(wall.keep);
    }

    let mut representative: Vec<usize> = (0..raw_vertices.len()).collect();
    let union = |representative: &mut Vec<usize>, first: usize, second: usize| {
        let root_a = find(representative, first);
        let root_b = find(representative, second);
        if root_a != root_b {
            representative[root_a.max(root_b)] = root_a.min(root_b);
        }
    };

    let mut by_original: OrderedMap<usize, Vec<usize>> = OrderedMap::new();
    for (node, &original) in raw_original.iter().enumerate() {
        by_original
            .get_or_insert_with(original, Vec::new)
            .push(node);
    }

    // T-junctions: a standing wall's node on a base wall's inner face reaches
    // the base wall's mid-plane and is imprinted into the base wall's facets —
    // where the standing wall's edge runs through the base wall's mid-surface.
    // Along the base's own edge (a wall standing on the face that was KEPT,
    // say) the walls already meet at shared nodes, and the node stays put.
    let mut candidates: OrderedMap<i32, HashMap<usize, Vec3>> = OrderedMap::new();
    for (node, &original) in raw_original.iter().enumerate() {
        let Some(&delta) = junction_offset.get(&original) else {
            continue;
        };
        let position = add(mesh.vertices[original], delta);
        for base in inner_walls_of_node.get(&original).into_iter().flatten() {
            let Some(wall) = keep.get(base) else {
                continue;
            };
            let reach = 1e-6 * wall.thickness.max(1.0);
            if *base != raw_source[node]
                && from_mid_plane(position, wall, kept_face(wall)?).abs() <= reach
            {
                candidates
                    .get_or_insert_with(*base, HashMap::new)
                    .insert(node, position);
            }
        }
    }
    // Per base wall: its facets, and the junction nodes and segments to imprint.
    let mut junction_nodes: OrderedMap<i32, Junction> = OrderedMap::new();
    for (&base, on_base) in candidates.iter() {
        let wall = keep
            .get(&base)
            .ok_or(ShellizeError::UnknownWallFace { face: base })?;
        let base_triangles: Vec<[usize; 3]> = raw_triangles
            .iter()
            .zip(&raw_triangle_source)
            .filter(|&(_, &source)| source == base)
            .map(|(&tri, _)| tri)
            .collect();
        // The standing walls' facet edges that run along the junction.
        let mut segments: Vec<[usize; 2]> = Vec::new();
        let mut seen: HashSet<(usize, usize)> = HashSet::new();
        for tri in &raw_triangles {
            for corner in 0..3 {
                let edge = [tri[corner], tri[(corner + 1) % 3]];
                let (Some(&start), Some(&end)) = (on_base.get(&edge[0]), on_base.get(&edge[1]))
                else {
                    continue;
                };
                if !seen.insert((edge[0].min(edge[1]), edge[0].max(edge[1]))) {
                    continue;
                }
                let middle = scale(add(start, end), 0.5);
                let inside = clearance(&raw_vertices, &base_triangles, wall.normal, middle);
                if inside.is_some_and(|inside| inside >= 0.1 * norm(sub(end, start))) {
                    segments.push(edge);
                }
            }
        }
        let mut points: Vec<usize> = segments.iter().flatten().copied().collect();
        points.sort_unstable();
        points.dedup();
        if !points.is_empty() {
            junction_nodes.insert(base, (base_triangles, points, segments));
        }
    }
    // Move the accepted junction nodes — every copy of their original node,
    // so the copies still weld — onto the base walls' mid-planes.
    for (_, points, _) in junction_nodes.values() {
        for &node in points {
            let original = raw_original[node];
            let Some(&delta) = junction_offset.get(&original) else {
                continue;
            };
            for &copy in by_original.get(&original).into_iter().flatten() {
                raw_vertices[copy] = add(mesh.vertices[original], delta);
            }
        }
    }
    if !junction_nodes.is_empty() {
        let mut rebuilt: HashMap<i32, Vec<[usize; 3]>> = HashMap::new();
        for (&base, (base_triangles, points, segments)) in junction_nodes.iter() {
            let wall = keep
                .get(&base)
                .ok_or(ShellizeError::UnknownWallFace { face: base })?;
            // A base node no other wall touches may be nudged in its plane.
            let movable = |node: usize| {
                let original = raw_original[node];
                raw_source[node] == base
                    && walls_of_node
                        .get(&original)
                        .is_some_and(|walls| walls.len() == 1)
                    && !inner_walls_of_node.contains_key(&original)
            };
            let imprinted = imprint(
                &mut raw_vertices,
                &Imprint {
                    normal: wall.normal,
                    triangles: base_triangles,
                    points,
                    segments,
                },
                &movable,
            );
            for (point, onto) in imprinted.merged {
                union(&mut representative, point, onto);
            }
            rebuilt.insert(base, imprinted.triangles);
        }
        // Swap each base wall's facets for its imprinted ones, in place of
        // its first facet, so the facet order stays wall by wall.
        let mut triangles = Vec::with_capacity(raw_triangles.len());
        let mut thickness = Vec::with_capacity(raw_triangles.len());
        let mut source = Vec::with_capacity(raw_triangles.len());
        for (index, &tri) in raw_triangles.iter().enumerate() {
            let face = raw_triangle_source[index];
            let Some(replacement) = rebuilt.get_mut(&face) else {
                triangles.push(tri);
                thickness.push(raw_thickness[index]);
                source.push(face);
                continue;
            };
            for tri in replacement.drain(..) {
                triangles.push(tri);
                thickness.push(raw_thickness[index]);
                source.push(face);
            }
        }
        raw_triangles = triangles;
        raw_thickness = thickness;
        raw_triangle_source = source;
    }

    for group in by_original.values() {
        for &member in &group[1..] {
            union(&mut representative, group[0], member);
        }
    }

    let mut extraction = ShellExtraction::default();
    let mut compact: HashMap<usize, usize> = HashMap::new();
    for (triangle, raw) in raw_triangles.iter().enumerate() {
        // Every corner gets its compact id before the degeneracy check, as in
        // the TS pipeline, so the node numbering matches it exactly.
        let mut ids = [0usize; 3];
        for (corner, &node) in raw.iter().enumerate() {
            let root = find(&mut representative, node);
            ids[corner] = *compact.entry(root).or_insert_with(|| {
                extraction.vertices.push(raw_vertices[root]);
                extraction.node_source.push(raw_source[root]);
                extraction.vertices.len() - 1
            });
        }
        if ids[0] == ids[1] || ids[1] == ids[2] || ids[0] == ids[2] {
            continue;
        }
        extraction.triangles.push(ids);
        extraction.thicknesses.push(raw_thickness[triangle]);
        extraction
            .triangle_source
            .push(raw_triangle_source[triangle]);
    }
    Ok(extraction)
}

/// Detect thin walls (opposite planar CAD-face pairs) and collapse each to a
/// mid-surface facet with its wall thickness; weld walls at their junctions.
/// Returns an empty extraction (`shell_body` = `None`) when no thin wall is
/// found, so the caller can decide what that means.
///
/// Only ONE body is shelled — among the requested bodies the one carrying the
/// largest thin wall — and only that body's walls are collapsed: detection
/// pairs opposite faces on any body, and collapsing a wall of a body that stays
/// solid would lay shell facets over solid tets.
///
/// # Errors
/// An internal inconsistency in the wall bookkeeping.
pub fn extract_thin_wall_shells(
    mesh: &ShellizeMesh,
    options: &ExtractOptions,
) -> Result<ShellExtraction, ShellizeError> {
    if options
        .shell_body_ids
        .as_ref()
        .is_some_and(std::vec::Vec::is_empty)
    {
        return Ok(ShellExtraction::default()); // the user chose all-solid
    }
    let faces = face_props(mesh);
    let all_walls: Vec<PairedWall> = detect_walls(mesh, &faces, options.max_wall)
        .into_iter()
        .filter(|paired| {
            options
                .shell_body_ids
                .as_ref()
                .is_none_or(|ids| ids.contains(&paired.wall.body))
        })
        .collect();
    let Some(first) = all_walls.first() else {
        return Ok(ShellExtraction::default());
    };
    let shell_body = first.wall.body;
    let walls: Vec<PairedWall> = all_walls
        .into_iter()
        .filter(|paired| paired.wall.body == shell_body)
        .collect();
    let collapsed = collapse_walls_to_mid_surface(mesh, &walls, &faces)?;
    Ok(ShellExtraction {
        walls: walls.into_iter().map(|paired| paired.wall).collect(),
        shell_body: Some(shell_body),
        ..collapsed
    })
}

impl ShellExtraction {
    /// Rebuild an extraction handed back from JS: flat facets over its own
    /// nodes, one thickness and source face per facet, one source face per
    /// node, and the walls it was collapsed from.
    ///
    /// # Errors
    /// The first malformed array or out-of-range index.
    #[allow(
        clippy::too_many_arguments,
        reason = "one argument per field of the flat wire form"
    )]
    pub fn from_parts(
        shell_body: Option<i32>,
        walls: Vec<Wall>,
        vertices: &[f64],
        triangles: &[u32],
        thicknesses: &[f64],
        node_source: &[i32],
        triangle_source: &[i32],
    ) -> Result<Self, ShellizeError> {
        if !vertices.len().is_multiple_of(3) {
            return Err(ShellizeError::ArrayLength {
                what: "shell vertex array",
                len: vertices.len(),
                stride: 3,
            });
        }
        if let Some(&value) = vertices
            .iter()
            .chain(thicknesses)
            .find(|value| !value.is_finite())
        {
            return Err(ShellizeError::NonFinite {
                what: "a shell vertex coordinate or thickness",
                value,
            });
        }
        let points: Vec<Vec3> = vertices.as_chunks::<3>().0.to_vec();
        let triangles =
            crate::geometry::checked_groups::<3>(triangles, points.len(), "shell triangle array")?;
        for (what, len, expected) in [
            ("shell thickness array", thicknesses.len(), triangles.len()),
            (
                "shell facet source array",
                triangle_source.len(),
                triangles.len(),
            ),
            ("shell node source array", node_source.len(), points.len()),
        ] {
            if len != expected {
                return Err(ShellizeError::ArrayCount {
                    what,
                    len,
                    expected,
                });
            }
        }
        Ok(Self {
            walls,
            shell_body,
            vertices: points,
            triangles,
            thicknesses: thicknesses.to_vec(),
            node_source: node_source.to_vec(),
            triangle_source: triangle_source.to_vec(),
        })
    }
}
