// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Physical shell footprint: where a shell edge ends on a through-thickness
//! solid section, the section's solid nodes follow the interpolated shell edge
//! (coupling kind 3) instead of a search-ball tie.

use std::collections::HashSet;

use crate::coupling_set::{CouplingKind, CouplingSet};
use crate::error::ShellizeError;
use crate::geometry::{
    cross, dot, max_of, norm, scale, sub, tet_mesh_boundary, unique_in_order, OrderedMap, Vec3,
};

/// A free edge of a shell triangle set, with its facet's unit normal and the
/// in-plane unit direction pointing into the facet.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShellBoundaryEdge {
    pub first: usize,
    pub second: usize,
    pub thickness: f64,
    pub normal: Vec3,
    pub inward: Vec3,
}

/// The free edges of a shell triangle set (used by exactly one facet), in
/// order of first appearance.
///
/// # Errors
/// [`ShellizeError::DegenerateShellTriangle`] for a facet of zero area.
pub fn shell_boundary_edges(
    vertices: &[Vec3],
    triangles: &[[usize; 3]],
    thicknesses: &[f64],
) -> Result<Vec<ShellBoundaryEdge>, ShellizeError> {
    let mut edges: OrderedMap<[usize; 2], (usize, ShellBoundaryEdge)> = OrderedMap::new();
    for (triangle, &nodes) in triangles.iter().enumerate() {
        let points = nodes.map(|node| vertices[node]);
        let raw = cross(sub(points[1], points[0]), sub(points[2], points[0]));
        let length = norm(raw);
        if length == 0.0 {
            return Err(ShellizeError::DegenerateShellTriangle);
        }
        let normal = scale(raw, 1.0 / length);
        for corner in 0..3 {
            let first = nodes[corner];
            let second = nodes[(corner + 1) % 3];
            let key = [first.min(second), first.max(second)];
            if let Some(existing) = edges.get_mut(&key) {
                existing.0 += 1;
                continue;
            }
            let tangent = sub(points[(corner + 1) % 3], points[corner]);
            let inward_raw = cross(normal, tangent);
            let inward = scale(inward_raw, 1.0 / norm(inward_raw));
            edges.insert(
                key,
                (
                    1,
                    ShellBoundaryEdge {
                        first,
                        second,
                        thickness: thicknesses[triangle],
                        normal,
                        inward,
                    },
                ),
            );
        }
    }
    Ok(edges
        .values()
        .filter(|(count, _)| *count == 1)
        .map(|(_, edge)| *edge)
        .collect())
}

/// Footprint couplings and the shell nodes they make redundant for the
/// search-ball seam tie.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Footprint {
    pub coupling: CouplingSet,
    pub shell_nodes: HashSet<usize>,
}

struct Group {
    edge: usize,
    minimum: f64,
    maximum: f64,
}

struct Candidate {
    solid: usize,
    edge: usize,
    ratio: f64,
    distance: f64,
    group: usize,
}

fn same_section(
    vertices: &[Vec3],
    grouped: &ShellBoundaryEdge,
    edge: &ShellBoundaryEdge,
    tolerance: f64,
) -> bool {
    let delta = sub(vertices[grouped.first], vertices[edge.first]);
    (0..3).all(|axis| (grouped.normal[axis] - edge.normal[axis]).abs() < 1e-7)
        && (0..3).all(|axis| (grouped.inward[axis] - edge.inward[axis]).abs() < 1e-7)
        && (grouped.thickness - edge.thickness).abs() < tolerance
        && dot(delta, edge.inward).abs() < tolerance
        && dot(delta, edge.normal).abs() < tolerance
}

/// Every (retained-solid boundary node, free shell edge) pair where the node
/// lies in the edge's through-thickness section, grouped by section.
fn section_candidates(
    vertices: &[Vec3],
    boundary: &[usize],
    shell_set: &HashSet<usize>,
    edges: &[ShellBoundaryEdge],
    tolerance: f64,
) -> (Vec<Group>, Vec<Candidate>) {
    let mut groups: Vec<Group> = Vec::new();
    let mut candidates: Vec<Candidate> = Vec::new();
    for &solid in boundary {
        if shell_set.contains(&solid) {
            continue;
        }
        let position = vertices[solid];
        for (edge_index, edge) in edges.iter().enumerate() {
            let first = vertices[edge.first];
            let tangent = sub(vertices[edge.second], first);
            let offset = sub(position, first);
            let fraction = dot(tangent, offset) / dot(tangent, tangent);
            if !(-1e-7..=1.0 + 1e-7).contains(&fraction) {
                continue;
            }
            let ratio = fraction.clamp(0.0, 1.0);
            let remainder = sub(offset, scale(tangent, ratio));
            let normal_distance = dot(remainder, edge.normal);
            let plane_distance = dot(remainder, edge.inward);
            if plane_distance.abs() > tolerance
                || normal_distance.abs() > edge.thickness / 2.0 + tolerance
            {
                continue;
            }
            let group = if let Some(found) = groups
                .iter()
                .position(|entry| same_section(vertices, &edges[entry.edge], edge, tolerance))
            {
                found
            } else {
                groups.push(Group {
                    edge: edge_index,
                    minimum: normal_distance,
                    maximum: normal_distance,
                });
                groups.len() - 1
            };
            groups[group].minimum = groups[group].minimum.min(normal_distance);
            groups[group].maximum = groups[group].maximum.max(normal_distance);
            candidates.push(Candidate {
                solid,
                edge: edge_index,
                ratio,
                distance: norm(remainder),
                group,
            });
        }
    }
    (groups, candidates)
}

/// Couple each retained-solid boundary node that lies on a through-thickness
/// section at a free shell edge to that edge, interpolated along it (kind 3).
/// A section must span both wall faces; a shell lying above a solid surface is
/// no section and keeps its search-ball tie. Shell nodes within `seam_reach` of
/// an edge that got a footprint are reported so the seam tie skips them; a
/// different seam elsewhere on the same wall keeps its own connection.
///
/// # Errors
/// A degenerate shell facet, or a footprint solid node that a tie connection
/// already made dependent.
pub fn shell_footprint_couplings(
    vertices: &[Vec3],
    tets: &[[usize; 4]],
    triangles: &[[usize; 3]],
    thicknesses: &[f64],
    dependent_solid_refs: &HashSet<usize>,
    seam_reach: f64,
) -> Result<Footprint, ShellizeError> {
    let mut footprint = Footprint::default();
    if triangles.is_empty() || tets.is_empty() {
        return Ok(footprint);
    }
    let boundary = unique_in_order(tet_mesh_boundary(tets).into_iter().flatten());
    let edges = shell_boundary_edges(vertices, triangles, thicknesses)?;
    let tolerance = max_of(thicknesses).unwrap_or(0.0) * 1e-6;
    let shell_nodes = unique_in_order(triangles.iter().flatten().copied());
    let shell_set: HashSet<usize> = shell_nodes.iter().copied().collect();
    let (groups, candidates) =
        section_candidates(vertices, &boundary, &shell_set, &edges, tolerance);
    let mut closest_by_node: OrderedMap<usize, usize> = OrderedMap::new();
    for (index, candidate) in candidates.iter().enumerate() {
        let group = &groups[candidate.group];
        let half = edges[group.edge].thickness / 2.0;
        // A section spans both wall faces.
        if group.minimum > -half + tolerance || group.maximum < half - tolerance {
            continue;
        }
        let closer = closest_by_node
            .get(&candidate.solid)
            .is_none_or(|&best| candidate.distance < candidates[best].distance);
        if closer {
            closest_by_node.insert(candidate.solid, index);
        }
    }
    for (&solid, &index) in closest_by_node.iter() {
        if dependent_solid_refs.contains(&solid) {
            return Err(ShellizeError::TieOverlapsTransition);
        }
        let closest = &candidates[index];
        let edge = &edges[closest.edge];
        footprint.coupling.push(
            solid,
            &[edge.first, edge.second],
            &[1.0 - closest.ratio, closest.ratio],
            CouplingKind::Footprint,
        );
        footprint.shell_nodes.insert(edge.first);
        footprint.shell_nodes.insert(edge.second);
    }
    let active_edges = unique_in_order(
        closest_by_node
            .values()
            .map(|&index| candidates[index].edge),
    );
    let reach2 = (seam_reach + tolerance).powi(2);
    for &shell_node in &shell_nodes {
        let position = vertices[shell_node];
        let near_active = active_edges.iter().any(|&edge_index| {
            let edge = &edges[edge_index];
            let first = vertices[edge.first];
            let tangent = sub(vertices[edge.second], first);
            let offset = sub(position, first);
            let fraction = (dot(tangent, offset) / dot(tangent, tangent)).clamp(0.0, 1.0);
            let remainder = sub(offset, scale(tangent, fraction));
            dot(remainder, remainder) <= reach2
        });
        if near_active {
            footprint.shell_nodes.insert(shell_node);
        }
    }
    Ok(footprint)
}
