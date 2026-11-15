// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The shell↔solid seam: which shell nodes sit on the retained solid and so
//! become references of the continuity tie.

use crate::error::ShellizeError;
use crate::geometry::{triangle_extent, Vec3};
use crate::grid::TriangleGrid;

/// The shell nodes that lie ON the retained solid — within `tolerance` of its
/// boundary surface. Whether a node is at the seam is a geometric fact, so it
/// is tested against the boundary itself; a fixed ball of solid nodes (used
/// before) clamped whole millimetres of thin wall to the block.
///
/// # Errors
/// A degenerate grid size.
#[allow(
    clippy::cast_precision_loss,
    reason = "a triangle count far below 2^52, used as an averaging divisor"
)]
pub fn seam_shell_nodes(
    point: &impl Fn(usize) -> Vec3,
    shell_nodes: &[usize],
    solid_boundary: &[[usize; 3]],
    tolerance: f64,
) -> Result<Vec<usize>, ShellizeError> {
    if solid_boundary.is_empty() || tolerance <= 0.0 {
        return Ok(Vec::new());
    }
    let corners: Vec<[Vec3; 3]> = solid_boundary.iter().map(|tri| tri.map(point)).collect();
    let sum_extent: f64 = corners.iter().map(|corner| triangle_extent(*corner)).sum();
    let cell = tolerance.max(sum_extent / corners.len() as f64).max(1e-9);
    let grid = TriangleGrid::new(corners, cell)?;
    let tolerance2 = tolerance * tolerance;
    Ok(shell_nodes
        .iter()
        .copied()
        .filter(|&node| grid.any_near(point(node), |distance2, _| distance2 <= tolerance2))
        .collect())
}

/// How far off the retained solid's boundary a shell node may sit and still
/// count as seam: one wall thickness, or half an element, whichever is larger.
/// A discretised seam is only located to within the element size, and unlike a
/// fixed radius this shrinks as the mesh is refined.
#[must_use]
pub fn seam_tolerance(max_wall_thickness: f64, median_edge: f64) -> f64 {
    max_wall_thickness.max(0.5 * median_edge)
}
