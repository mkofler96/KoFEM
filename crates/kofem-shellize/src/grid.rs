// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Uniform-grid neighbour search over points and triangles.

use std::collections::HashMap;

use crate::error::ShellizeError;
use crate::geometry::{dot, sub, Vec3};

type Cell = [i64; 3];

#[allow(
    clippy::cast_possible_truncation,
    reason = "grid cell coordinates: floor(x / cell) of a finite model coordinate"
)]
fn cell_of(point: Vec3, cell_size: f64) -> Cell {
    point.map(|value| (value / cell_size).floor() as i64)
}

fn checked_cell_size(cell_size: f64, what: &'static str) -> Result<f64, ShellizeError> {
    if cell_size.is_finite() && cell_size > 0.0 {
        Ok(cell_size)
    } else {
        Err(ShellizeError::NotPositive {
            what,
            value: cell_size,
        })
    }
}

/// Points filed by grid cell. Candidate traversal only: callers own distance
/// limits, nearest-neighbour selection and stopping rules. Chebyshev rings are
/// walked in x, y, z order and each cell in insertion order, the same order as
/// the TS `SpatialGrid`, so ties between equidistant points break the same way.
#[derive(Debug)]
pub struct SpatialGrid {
    cell_size: f64,
    buckets: HashMap<Cell, Vec<usize>>,
}

impl SpatialGrid {
    /// # Errors
    /// A cell size that is not positive and finite.
    pub fn new(
        items: impl IntoIterator<Item = usize>,
        position: impl Fn(usize) -> Vec3,
        cell_size: f64,
    ) -> Result<Self, ShellizeError> {
        let cell_size = checked_cell_size(cell_size, "spatial grid cell size")?;
        let mut buckets: HashMap<Cell, Vec<usize>> = HashMap::new();
        for item in items {
            buckets
                .entry(cell_of(position(item), cell_size))
                .or_default()
                .push(item);
        }
        Ok(Self { cell_size, buckets })
    }

    /// Every item in the cells whose Chebyshev distance from `point`'s cell
    /// lies in `inner..=outer`.
    pub fn candidates(
        &self,
        point: Vec3,
        outer: i64,
        inner: i64,
    ) -> impl Iterator<Item = usize> + '_ {
        let [cx, cy, cz] = cell_of(point, self.cell_size);
        (-outer..=outer)
            .flat_map(move |dx| (-outer..=outer).map(move |dy| (dx, dy)))
            .flat_map(move |(dx, dy)| (-outer..=outer).map(move |dz| [dx, dy, dz]))
            .filter(move |offset| {
                offset.iter().map(|value| value.abs()).max().unwrap_or(0) >= inner
            })
            .filter_map(move |[dx, dy, dz]| self.buckets.get(&[cx + dx, cy + dy, cz + dz]))
            .flat_map(|bucket| bucket.iter().copied())
    }
}

/// Squared distance from a point to a triangle (Ericson, Real-Time Collision
/// Detection §5.1.5 — closest point via the Voronoi regions of its vertices,
/// edges and interior).
#[must_use]
pub fn point_triangle_distance2(
    point: Vec3,
    corner_a: Vec3,
    corner_b: Vec3,
    corner_c: Vec3,
) -> f64 {
    let ab = sub(corner_b, corner_a);
    let ac = sub(corner_c, corner_a);
    let ap = sub(point, corner_a);
    let at = |along_ab: f64, along_ac: f64| -> f64 {
        (0..3)
            .map(|axis| {
                (point[axis] - (corner_a[axis] + along_ab * ab[axis] + along_ac * ac[axis])).powi(2)
            })
            .sum()
    };
    let d1 = dot(ab, ap);
    let d2 = dot(ac, ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return at(0.0, 0.0);
    }
    let bp = sub(point, corner_b);
    let d3 = dot(ab, bp);
    let d4 = dot(ac, bp);
    if d3 >= 0.0 && d4 <= d3 {
        return at(1.0, 0.0);
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        return at(d1 / (d1 - d3), 0.0);
    }
    let cp = sub(point, corner_c);
    let d5 = dot(ab, cp);
    let d6 = dot(ac, cp);
    if d6 >= 0.0 && d5 <= d6 {
        return at(0.0, 1.0);
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        return at(0.0, d2 / (d2 - d6));
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 {
        let along = (d4 - d3) / (d4 - d3 + (d5 - d6));
        return at(1.0 - along, along);
    }
    let denom = 1.0 / (va + vb + vc);
    at(vb * denom, vc * denom)
}

/// Uniform grid over a triangle soup, for "is any triangle within r of p"
/// queries. A triangle is filed under every cell its bounding box overlaps, so
/// a triangle within `cell_size` of a query point is always among the 27 cells
/// around it — build with `cell_size` ≥ the largest query radius.
#[derive(Debug)]
pub struct TriangleGrid {
    cell_size: f64,
    corners: Vec<[Vec3; 3]>,
    buckets: HashMap<Cell, Vec<usize>>,
}

impl TriangleGrid {
    /// # Errors
    /// A cell size that is not positive and finite.
    pub fn new(corners: Vec<[Vec3; 3]>, cell_size: f64) -> Result<Self, ShellizeError> {
        let cell_size = checked_cell_size(cell_size, "triangle grid cell size")?;
        let mut buckets: HashMap<Cell, Vec<usize>> = HashMap::new();
        for (triangle, corner) in corners.iter().enumerate() {
            let low = cell_of(
                [0, 1, 2].map(|axis| corner[0][axis].min(corner[1][axis]).min(corner[2][axis])),
                cell_size,
            );
            let high = cell_of(
                [0, 1, 2].map(|axis| corner[0][axis].max(corner[1][axis]).max(corner[2][axis])),
                cell_size,
            );
            for cell_x in low[0]..=high[0] {
                for cell_y in low[1]..=high[1] {
                    for cell_z in low[2]..=high[2] {
                        buckets
                            .entry([cell_x, cell_y, cell_z])
                            .or_default()
                            .push(triangle);
                    }
                }
            }
        }
        Ok(Self {
            cell_size,
            corners,
            buckets,
        })
    }

    /// True when some triangle near `point` satisfies
    /// `within_reach(dist2, triangle)`, where `dist2` is the squared
    /// point-to-triangle distance.
    pub fn any_near(&self, point: Vec3, within_reach: impl Fn(f64, usize) -> bool) -> bool {
        let [cx, cy, cz] = cell_of(point, self.cell_size);
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    let Some(bucket) = self.buckets.get(&[cx + dx, cy + dy, cz + dz]) else {
                        continue;
                    };
                    for &triangle in bucket {
                        let [corner_a, corner_b, corner_c] = self.corners[triangle];
                        if within_reach(
                            point_triangle_distance2(point, corner_a, corner_b, corner_c),
                            triangle,
                        ) {
                            return true;
                        }
                    }
                }
            }
        }
        false
    }
}
