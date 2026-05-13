//! Ruppert's algorithm: iterative Delaunay mesh refinement.
//!
//! Inserts the circumcenter of the worst triangle, unless it encroaches
//! on a constrained edge (boundary segment), in which case that edge's
//! midpoint is inserted instead.

use std::collections::HashSet;

use crate::geom::{
    circumcenter, circumradius_sq, encroaches, point_in_polygon, shortest_edge_sq, Point2,
};
use crate::triangulate::{insert_point, Triangle};

// ── Quality metric ────────────────────────────────────────────────────────────

/// B = R² / e²  where R = circumradius, e = shortest edge.
/// B > B_threshold  ⟺  min angle < min_angle_threshold.
fn quality_ratio(a: Point2, b: Point2, c: Point2) -> f64 {
    let se = shortest_edge_sq(a, b, c);
    if se < 1e-28 {
        return f64::INFINITY;
    }
    circumradius_sq(a, b, c) / se
}

// ── Constrained-edge bookkeeping ──────────────────────────────────────────────

/// Unordered set of boundary edges stored as canonical (min, max) pairs.
#[derive(Default)]
struct ConstrainedEdges {
    edges: HashSet<(usize, usize)>,
}

impl ConstrainedEdges {
    fn insert(&mut self, a: usize, b: usize) {
        self.edges.insert(if a < b { (a, b) } else { (b, a) });
    }

    fn remove(&mut self, a: usize, b: usize) {
        self.edges.remove(&if a < b { (a, b) } else { (b, a) });
    }

    fn iter(&self) -> impl Iterator<Item = (usize, usize)> + '_ {
        self.edges.iter().copied()
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Refine `(points, triangles)` in-place using Ruppert's algorithm.
///
/// * `min_angle_deg`  — target minimum angle (20–33° is practical)
/// * `max_points`     — hard cap on Steiner points to prevent run-away insertion
/// * `boundary`       — original polygon (CCW), used for interior tests
pub fn refine(
    points: &mut Vec<Point2>,
    triangles: &mut Vec<Triangle>,
    boundary: &[Point2],
    min_angle_deg: f64,
    max_points: usize,
) {
    let sin_t = min_angle_deg.to_radians().sin();
    // B_threshold derived from:  min_angle = arcsin(1 / (2 sqrt(B)))
    let b_threshold = 1.0 / (4.0 * sin_t * sin_t);

    // Build constrained-edge set from the boundary polygon.
    let mut constrained = ConstrainedEdges::default();
    let nb = boundary.len();
    for i in 0..nb {
        constrained.insert(i, (i + 1) % nb);
    }

    let mut inserted = 0usize;
    // Track triangles we could not improve to avoid infinite loops.
    let mut skip: HashSet<usize> = HashSet::new();

    loop {
        if inserted >= max_points {
            break;
        }

        // Find worst triangle not in the skip set.
        let worst = triangles
            .iter()
            .enumerate()
            .filter(|(i, _)| !skip.contains(i))
            .filter_map(|(i, t)| {
                let [a, b, c] = t.v;
                let bv = quality_ratio(points[a], points[b], points[c]);
                if bv > b_threshold {
                    Some((i, bv))
                } else {
                    None
                }
            })
            .max_by(|x, y| x.1.partial_cmp(&y.1).unwrap());

        let (ti, _) = match worst {
            Some(v) => v,
            None => break,
        };

        let [ta, tb, tc] = triangles[ti].v;
        let cc = match circumcenter(points[ta], points[tb], points[tc]) {
            Some(p) => p,
            None => {
                skip.insert(ti);
                continue;
            }
        };

        // Skip circumcenters outside the polygon (can happen near concavities).
        if !point_in_polygon(cc, boundary) {
            skip.insert(ti);
            continue;
        }

        // Check if cc encroaches on any constrained edge; if so, insert midpoint.
        let encroached = constrained
            .iter()
            .find(|(a, b)| encroaches(cc, points[*a], points[*b]));

        let candidate_idx = match encroached {
            Some((ea, eb)) => {
                let mid = points[ea].midpoint(points[eb]);
                let new_idx = points.len();
                constrained.remove(ea, eb);
                constrained.insert(ea, new_idx);
                constrained.insert(new_idx, eb);
                points.push(mid);
                new_idx
            }
            None => {
                let new_idx = points.len();
                points.push(cc);
                new_idx
            }
        };

        // Insert the new point via Bowyer-Watson.
        insert_point(triangles, points, candidate_idx);

        // Discard any triangles outside the polygon that insertion regenerated.
        triangles.retain(|t| point_in_polygon(t.centroid(points), boundary));

        // Invalidate skip set — triangle indices have changed after retention.
        skip.clear();

        inserted += 1;
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::min_angle;
    use crate::triangulate::triangulate;

    fn square() -> Vec<Point2> {
        vec![
            Point2::new(0.0, 0.0),
            Point2::new(1.0, 0.0),
            Point2::new(1.0, 1.0),
            Point2::new(0.0, 1.0),
        ]
    }

    #[test]
    fn refined_square_meets_angle_criterion() {
        let boundary = square();
        let mesh = triangulate(&boundary);
        let mut pts = mesh.points;
        let mut tris = mesh.triangles;
        refine(&mut pts, &mut tris, &boundary, 20.0, 2000);

        let min_deg = tris
            .iter()
            .map(|t| {
                let [a, b, c] = t.v;
                min_angle(pts[a], pts[b], pts[c]).to_degrees()
            })
            .fold(f64::INFINITY, f64::min);

        // Allow a small tolerance (numerical edge cases).
        assert!(
            min_deg > 18.0,
            "min angle {min_deg:.1}° is below threshold after refinement"
        );
    }
}
