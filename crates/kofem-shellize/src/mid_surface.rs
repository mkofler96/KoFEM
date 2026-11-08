// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Collapse the detected thin walls to Kirchhoff shell mid-surface facets, one
//! thickness per wall, welded where walls meet.

use std::collections::{BTreeSet, HashMap};

use crate::error::ShellizeError;
use crate::geometry::{add, dot, norm, scale, OrderedMap, ShellizeMesh, Vec3};
use crate::walls::{detect_wall_pairs, face_props, Wall};

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
fn mid_surface_offset(
    walls_of_node: &BTreeSet<i32>,
    keep: &HashMap<i32, Wall>,
) -> Result<Vec3, ShellizeError> {
    let mut delta: Vec3 = [0.0; 3];
    let mut basis: Vec<Vec3> = Vec::new();
    for &face in walls_of_node {
        let wall = keep
            .get(&face)
            .ok_or(ShellizeError::UnknownWallFace { face })?;
        let mut residual = wall.normal;
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
        let along = dot(wall.normal, delta);
        let step = (-wall.thickness / 2.0 - along) / dot(wall.normal, direction);
        delta = add(delta, scale(direction, step));
        basis.push(direction);
    }
    Ok(delta)
}

/// Union–find root with path halving.
fn find(representative: &mut [usize], mut node: usize) -> usize {
    while representative[node] != node {
        representative[node] = representative[representative[node]];
        node = representative[node];
    }
    node
}

/// Collapse the kept wall faces to mid-surface facets and weld mid-surface
/// nodes that came from the SAME original mesh node. Where two walls meet at a
/// CAD edge they share Netgen's edge nodes, so joining by original id fuses the
/// walls exactly — independent of mesh resolution.
fn collapse_walls_to_mid_surface(
    mesh: &ShellizeMesh,
    walls: &[Wall],
) -> Result<ShellExtraction, ShellizeError> {
    let keep: HashMap<i32, Wall> = walls.iter().map(|wall| (wall.keep, *wall)).collect();

    // Every kept wall each node lies on — a junction node belongs to several.
    let mut walls_of_node: OrderedMap<usize, BTreeSet<i32>> = OrderedMap::new();
    for (triangle, tri) in mesh.surf_tris.iter().enumerate() {
        let face = mesh.surf_face[triangle];
        if !keep.contains_key(&face) {
            continue;
        }
        for &vertex in tri {
            walls_of_node
                .get_or_insert_with(vertex, BTreeSet::new)
                .insert(face);
        }
    }
    let mut offset_of_node: HashMap<usize, Vec3> = HashMap::with_capacity(walls_of_node.len());
    for (&vertex, node_walls) in walls_of_node.iter() {
        offset_of_node.insert(vertex, mid_surface_offset(node_walls, &keep)?);
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
    let mut by_original: OrderedMap<usize, Vec<usize>> = OrderedMap::new();
    for (node, &original) in raw_original.iter().enumerate() {
        by_original
            .get_or_insert_with(original, Vec::new)
            .push(node);
    }
    for group in by_original.values() {
        for &member in &group[1..] {
            let root_a = find(&mut representative, group[0]);
            let root_b = find(&mut representative, member);
            if root_a != root_b {
                representative[root_a.max(root_b)] = root_a.min(root_b);
            }
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
    let all_walls: Vec<Wall> = detect_wall_pairs(&faces, options.max_wall)
        .into_iter()
        .filter(|wall| {
            options
                .shell_body_ids
                .as_ref()
                .is_none_or(|ids| ids.contains(&wall.body))
        })
        .collect();
    let Some(first) = all_walls.first() else {
        return Ok(ShellExtraction::default());
    };
    let shell_body = first.body;
    let walls: Vec<Wall> = all_walls
        .into_iter()
        .filter(|wall| wall.body == shell_body)
        .collect();
    let collapsed = collapse_walls_to_mid_surface(mesh, &walls)?;
    Ok(ShellExtraction {
        walls,
        shell_body: Some(shell_body),
        ..collapsed
    })
}
