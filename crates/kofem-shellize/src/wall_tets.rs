// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Which solid tets the shell mid-surface replaces.

use std::collections::{BTreeSet, HashMap};

use crate::error::ShellizeError;
use crate::geometry::{
    add, cross, dot, max_of, norm, scale, sub, triangle_extent, ShellizeMesh, Vec3,
};
use crate::grid::TriangleGrid;
use crate::mid_surface::ShellExtraction;

#[allow(
    clippy::cast_precision_loss,
    reason = "a facet count far below 2^52, used as an averaging divisor"
)]
fn mean(sum: f64, count: usize) -> f64 {
    sum / count as f64
}

/// The tets of the shelled body that lie inside a detected thin wall: those
/// whose centroid is within `margin` × half that wall's thickness of its
/// mid-surface — the geometric statement of "this material is now carried by
/// the shell". Thicker junction blocks stay solid. (A shape test on tet
/// flatness, used before, kept a mesh-size-dependent share of the wall twice.)
///
/// # Errors
/// A degenerate grid size (all facets of zero extent and thickness).
pub fn shell_wall_tets(
    mesh: &ShellizeMesh,
    shells: &ShellExtraction,
    margin: f64,
) -> Result<BTreeSet<usize>, ShellizeError> {
    let mut wall_tets = BTreeSet::new();
    let Some(shell_body) = shells.shell_body else {
        return Ok(wall_tets);
    };
    if shells.triangles.is_empty() {
        return Ok(wall_tets);
    }
    let corners: Vec<[Vec3; 3]> = shells
        .triangles
        .iter()
        .map(|tri| tri.map(|node| shells.vertices[node]))
        .collect();
    let max_thickness = max_of(&shells.thicknesses).unwrap_or(0.0);
    let sum_extent: f64 = corners.iter().map(|corner| triangle_extent(*corner)).sum();
    // Cell ≥ the largest query radius (half the thickest wall) and ≥ the facet
    // extent, so a facet spans only a few cells.
    let cell = (max_thickness * margin)
        .max(mean(sum_extent, corners.len()))
        .max(1e-9);
    let grid = TriangleGrid::new(corners, cell)?;
    for (element, tet) in mesh.tets.iter().enumerate() {
        if mesh.body[element] != shell_body {
            continue;
        }
        let mut centroid: Vec3 = [0.0; 3];
        for &vertex in tet {
            let node = mesh.vertices[vertex];
            for axis in 0..3 {
                centroid[axis] += node[axis] / 4.0;
            }
        }
        let inside = grid.any_near(centroid, |distance2, triangle| {
            let reach = 0.5 * shells.thicknesses[triangle] * margin;
            distance2 <= reach * reach
        });
        if inside {
            wall_tets.insert(element);
        }
    }
    Ok(wall_tets)
}

/// Two facets `|n₁·n₂|` above this are (near) parallel: their shared edge is
/// no corner.
const PARALLEL: f64 = 0.9;

/// The block where two walls meeting at an angle cross (an L-corner or a
/// T-junction): along their shared facet edge, within half of each wall's
/// thickness of its mid-plane. The outer corner of an L lies there, up to
/// √2·t/2 from the line where the welded mid-surfaces end, so beyond the
/// reach of either wall alone (KOF-452).
struct CornerBlock {
    ends: [Vec3; 2],
    /// Each wall's unit normal and half thickness.
    walls: [(Vec3, f64); 2],
}

impl CornerBlock {
    fn contains(&self, point: Vec3) -> bool {
        let along = sub(self.ends[1], self.ends[0]);
        let offset = sub(point, self.ends[0]);
        let fraction = dot(offset, along) / dot(along, along);
        (0.0..=1.0).contains(&fraction)
            && self
                .walls
                .iter()
                .all(|&(normal, half)| dot(offset, normal).abs() <= half)
    }
}

fn corner_blocks(shells: &ShellExtraction) -> Vec<CornerBlock> {
    let mut facets_of_edge: HashMap<(usize, usize), Vec<usize>> = HashMap::new();
    for (facet, tri) in shells.triangles.iter().enumerate() {
        for corner in 0..3 {
            let (first, second) = (tri[corner], tri[(corner + 1) % 3]);
            facets_of_edge
                .entry((first.min(second), first.max(second)))
                .or_default()
                .push(facet);
        }
    }
    let normal = |facet: usize| {
        let [first, second, third] = shells.triangles[facet].map(|node| shells.vertices[node]);
        let raw = cross(sub(second, first), sub(third, first));
        scale(raw, 1.0 / norm(raw).max(f64::MIN_POSITIVE))
    };
    let mut blocks = Vec::new();
    for (&(first, second), facets) in &facets_of_edge {
        if first == second {
            continue;
        }
        for (position, &one) in facets.iter().enumerate() {
            for &other in &facets[position + 1..] {
                let walls =
                    [one, other].map(|facet| (normal(facet), 0.5 * shells.thicknesses[facet]));
                if shells.triangle_source[one] != shells.triangle_source[other]
                    && dot(walls[0].0, walls[1].0).abs() <= PARALLEL
                {
                    blocks.push(CornerBlock {
                        ends: [shells.vertices[first], shells.vertices[second]],
                        walls,
                    });
                }
            }
        }
    }
    blocks
}

/// Every tet of the shelled body — what the app replaces with shell facets.
/// Sound only when the detected walls cover all of it: a curved wall, a small
/// tab or a thick block yields no facets, and dropping its tets would remove
/// material. Such a body is refused, with the share of it the shells would lose.
///
/// # Errors
/// [`ShellizeError::UncoveredShellBody`] when some tet of the body lies in no
/// wall.
pub fn shell_body_tets(
    mesh: &ShellizeMesh,
    shells: &ShellExtraction,
) -> Result<BTreeSet<usize>, ShellizeError> {
    let Some(shell_body) = shells.shell_body else {
        return Ok(BTreeSet::new());
    };
    let tets: BTreeSet<usize> = (0..mesh.tets.len())
        .filter(|&element| mesh.body[element] == shell_body)
        .collect();
    let covered = shell_wall_tets(mesh, shells, 1.0)?;
    let corners = corner_blocks(shells);
    let mut lost_volume = 0.0;
    let mut body_volume = 0.0;
    let mut lost = 0;
    for &element in &tets {
        let volume = mesh.tet_volume(element);
        body_volume += volume;
        if covered.contains(&element) {
            continue;
        }
        let centroid = scale(
            mesh.tets[element]
                .iter()
                .fold([0.0; 3], |sum, &vertex| add(sum, mesh.vertices[vertex])),
            0.25,
        );
        if corners.iter().any(|block| block.contains(centroid)) {
            continue;
        }
        lost += 1;
        lost_volume += volume;
    }
    if lost > 0 {
        return Err(ShellizeError::UncoveredShellBody {
            body: shell_body,
            lost,
            total: tets.len(),
            percent: 100.0 * lost_volume / body_volume,
        });
    }
    Ok(tets)
}
