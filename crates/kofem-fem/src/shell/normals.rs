// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The axis of each facet corner's drilling rotation: the normal of the
//! smooth surface at that node.
//!
//! The drilling DOF of the membrane is the in-plane rotation of the surface,
//! a rotation about the surface's normal. Facets meet at small angles where
//! they approximate a smooth surface, and the rotation about one facet's own
//! normal then carries a share of its neighbours' bending rotation. Taken as
//! the drilling DOF, that share let a free edge of a curved shell flare and
//! shed membrane strain (KOF-453). So the facets around a node that form one
//! smooth surface share one axis, their area-weighted mean normal. Where
//! facets meet at a fold the surface has no normal, and each side keeps its
//! own: there one wall's in-plane rotation is the other wall's bending
//! rotation.

use crate::mesh::{cross, dot, sub};
use crate::shell::mesh::ShellMesh;

/// Two facets sharing an edge at a node belong to one smooth surface when
/// their normals differ by less than this; a sharper angle is a fold. A
/// facet mesh of a smooth surface stays far below it (h/R < 0.35), and a fold
/// shallower than it is close enough to smooth that either axis serves.
const FEATURE_ANGLE_DEG: f64 = 20.0;

impl ShellMesh {
    /// One drilling axis per facet corner, in the facet's corner order: a
    /// unit vector along the smooth surface's normal at that node, turned to
    /// the side of the facet's own normal (the right-hand normal of its
    /// corner order).
    #[must_use]
    pub fn drilling_normals(&self) -> Vec<[[f64; 3]; 3]> {
        let triangles = self.triangles();
        // Area-weighted normals: the cross product is twice the area along
        // the unit normal.
        let weighted: Vec<[f64; 3]> = (0..triangles.len())
            .map(|facet| {
                let corners = self.corners(facet);
                cross(sub(corners[1], corners[0]), sub(corners[2], corners[0]))
            })
            .collect();
        let unit: Vec<[f64; 3]> = weighted
            .iter()
            .map(|normal| {
                let length = dot(*normal, *normal).sqrt();
                normal.map(|component| component / length)
            })
            .collect();
        let mut incident: Vec<Vec<usize>> = vec![Vec::new(); self.vertex_count()];
        for (facet, nodes) in triangles.iter().enumerate() {
            for &node in nodes {
                incident[node as usize].push(facet);
            }
        }

        let smooth = FEATURE_ANGLE_DEG.to_radians().cos();
        let mut axes = vec![[[0.0; 3]; 3]; triangles.len()];
        for (node, facets) in incident.iter().enumerate() {
            let groups = smooth_groups(node, facets, triangles, &unit, smooth);
            for group in groups {
                // Sum the normals turned to the side of the group's first
                // facet: a smooth group may mix windings.
                let lead = unit[group[0]];
                let mut sum = [0.0; 3];
                for &facet in &group {
                    let sign = dot(unit[facet], lead).signum();
                    for (total, component) in sum.iter_mut().zip(weighted[facet]) {
                        *total += sign * component;
                    }
                }
                let length = dot(sum, sum).sqrt();
                let shared = sum.map(|component| component / length);
                for &facet in &group {
                    let sign = dot(shared, unit[facet]).signum();
                    let corner = triangles[facet]
                        .iter()
                        .position(|&other| other as usize == node)
                        .unwrap_or_else(|| unreachable!("facet {facet} is incident on {node}"));
                    axes[facet][corner] = shared.map(|component| sign * component);
                }
            }
        }
        axes
    }
}

/// The facets around `node`, split into smooth groups: facets joined through
/// shared edges at the node whose normals differ by less than the feature
/// angle (`smooth` its cosine), whatever their winding.
fn smooth_groups(
    node: usize,
    facets: &[usize],
    triangles: &[[u32; 3]],
    unit: &[[f64; 3]],
    smooth: f64,
) -> Vec<Vec<usize>> {
    let mut parent: Vec<usize> = (0..facets.len()).collect();
    for first in 0..facets.len() {
        for second in first + 1..facets.len() {
            let (facet_a, facet_b) = (facets[first], facets[second]);
            let shares_edge = triangles[facet_a]
                .iter()
                .any(|&other| other as usize != node && triangles[facet_b].contains(&other));
            if shares_edge && dot(unit[facet_a], unit[facet_b]).abs() >= smooth {
                let (root_a, root_b) = (root(&mut parent, first), root(&mut parent, second));
                parent[root_a] = root_b;
            }
        }
    }
    let mut groups: Vec<Vec<usize>> = Vec::new();
    let mut slot = vec![usize::MAX; facets.len()];
    for (member, &facet) in facets.iter().enumerate() {
        let top = root(&mut parent, member);
        if slot[top] == usize::MAX {
            slot[top] = groups.len();
            groups.push(Vec::new());
        }
        groups[slot[top]].push(facet);
    }
    groups
}

/// The representative of `item`'s set in a union–find forest, halving the
/// path on the way.
fn root(parent: &mut [usize], mut item: usize) -> usize {
    while parent[item] != item {
        parent[item] = parent[parent[item]];
        item = parent[item];
    }
    item
}
