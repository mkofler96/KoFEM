//! Bowyer-Watson incremental Delaunay triangulation.
//!
//! The public entry point is [`triangulate`].  It accepts an ordered
//! boundary polygon and returns a [`Mesh2D`] containing only the
//! triangles that lie inside the polygon.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::geom::{in_circumcircle, orient2d, point_in_polygon, super_triangle, Point2};

// ── Data types ────────────────────────────────────────────────────────────────

/// A CCW-oriented triangle referencing indices into a point array.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Triangle {
    pub v: [usize; 3],
}

impl Triangle {
    /// Directed edges (CCW order preserved).
    pub fn edges(self) -> [(usize, usize); 3] {
        let [a, b, c] = self.v;
        [(a, b), (b, c), (c, a)]
    }

    /// `true` if any vertex index is ≥ `n` (i.e. belongs to the super-triangle).
    pub fn has_super_vertex(self, n: usize) -> bool {
        self.v.iter().any(|&vi| vi >= n)
    }

    /// Centroid in point array `pts`.
    pub fn centroid(self, pts: &[Point2]) -> Point2 {
        let [a, b, c] = self.v;
        Point2::new(
            (pts[a].x + pts[b].x + pts[c].x) / 3.0,
            (pts[a].y + pts[b].y + pts[c].y) / 3.0,
        )
    }
}

/// A 2-D triangle mesh.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Mesh2D {
    pub points: Vec<Point2>,
    pub triangles: Vec<Triangle>,
}

// ── Bowyer-Watson ─────────────────────────────────────────────────────────────

/// Core Bowyer-Watson Delaunay triangulation of `points`.
///
/// Returns all triangles including those touching the super-triangle;
/// call [`filter_interior`] / [`remove_super`] as needed.
pub fn bowyer_watson(points: &[Point2]) -> (Vec<Point2>, Vec<Triangle>) {
    let n_orig = points.len();
    assert!(n_orig >= 3, "need at least 3 points");

    let [s0, s1, s2] = super_triangle(points);
    let mut all_pts: Vec<Point2> = points.to_vec();
    all_pts.push(s0);
    all_pts.push(s1);
    all_pts.push(s2);

    let mut triangles: Vec<Triangle> = vec![Triangle {
        v: [n_orig, n_orig + 1, n_orig + 2],
    }];

    for pi in 0..n_orig {
        insert_point(&mut triangles, &all_pts, pi);
    }

    (all_pts, triangles)
}

/// Insert a single point `pi` into the current triangulation (Bowyer-Watson step).
pub(crate) fn insert_point(triangles: &mut Vec<Triangle>, pts: &[Point2], pi: usize) {
    // ── Find the cavity: all triangles whose circumcircle contains pts[pi] ──
    let bad: Vec<usize> = triangles
        .iter()
        .enumerate()
        .filter_map(|(i, t)| {
            let [a, b, c] = t.v;
            // ensure CCW for the predicate
            let inside = if orient2d(pts[a], pts[b], pts[c]) >= 0.0 {
                in_circumcircle(pts, a, b, c, pi)
            } else {
                in_circumcircle(pts, a, c, b, pi)
            };
            inside.then_some(i)
        })
        .collect();

    // ── Boundary of the cavity: directed edges appearing exactly once ─────
    // We accumulate undirected (min,max) keys to count occurrences, then
    // recover direction from the original triangles for proper CCW winding.
    let mut edge_count: HashMap<(usize, usize), usize> = HashMap::new();
    for &ti in &bad {
        for (a, b) in triangles[ti].edges() {
            let key = if a < b { (a, b) } else { (b, a) };
            *edge_count.entry(key).or_insert(0) += 1;
        }
    }

    // Collect boundary edges, preserving directed orientation from their
    // parent triangle (so the new triangles wind correctly).
    let mut boundary: Vec<(usize, usize)> = Vec::new();
    for &ti in &bad {
        for (a, b) in triangles[ti].edges() {
            let key = if a < b { (a, b) } else { (b, a) };
            if edge_count[&key] == 1 {
                boundary.push((a, b));
            }
        }
    }

    // ── Remove bad triangles ──────────────────────────────────────────────
    {
        let bad_set: std::collections::HashSet<usize> = bad.into_iter().collect();
        let mut i = 0;
        triangles.retain(|_| {
            let keep = !bad_set.contains(&i);
            i += 1;
            keep
        });
    }

    // ── Re-triangulate the cavity ─────────────────────────────────────────
    for (a, b) in boundary {
        // Determine CCW winding for [a, b, pi].
        let tri = if orient2d(pts[a], pts[b], pts[pi]) > 0.0 {
            Triangle { v: [a, b, pi] }
        } else {
            Triangle { v: [b, a, pi] }
        };
        triangles.push(tri);
    }
}

// ── Post-processing ───────────────────────────────────────────────────────────

/// Remove triangles that touch any of the three super-triangle vertices
/// (indices `n_orig`, `n_orig+1`, `n_orig+2`).
pub fn remove_super(triangles: &mut Vec<Triangle>, n_orig: usize) {
    triangles.retain(|t| !t.has_super_vertex(n_orig));
}

/// Keep only triangles whose centroid lies inside `boundary`.
pub fn filter_interior(triangles: &mut Vec<Triangle>, pts: &[Point2], boundary: &[Point2]) {
    triangles.retain(|t| {
        let c = t.centroid(pts);
        point_in_polygon(c, boundary)
    });
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Triangulate a closed `boundary` polygon (vertices in CCW order).
///
/// Returns a [`Mesh2D`] whose triangles cover the polygon interior.
/// Delegates to [`crate::cdt::triangulate_constrained`] so all boundary edges
/// are guaranteed to appear in the output (constrained Delaunay).
pub fn triangulate(boundary: &[Point2]) -> Mesh2D {
    assert!(boundary.len() >= 3, "polygon needs ≥ 3 vertices");
    crate::cdt::triangulate_constrained(boundary, &[])
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn square() -> Vec<Point2> {
        vec![
            Point2::new(0.0, 0.0),
            Point2::new(1.0, 0.0),
            Point2::new(1.0, 1.0),
            Point2::new(0.0, 1.0),
        ]
    }

    #[test]
    fn unit_square_triangulates() {
        let mesh = triangulate(&square());
        // A convex quad triangulates into exactly 2 triangles.
        assert_eq!(mesh.triangles.len(), 2);
        assert_eq!(mesh.points.len(), 4);
    }

    #[test]
    fn all_triangles_ccw() {
        let mesh = triangulate(&square());
        for t in &mesh.triangles {
            let [a, b, c] = t.v;
            let o = orient2d(mesh.points[a], mesh.points[b], mesh.points[c]);
            assert!(o > 0.0, "triangle is not CCW: {o}");
        }
    }

    #[test]
    fn triangle_indices_in_range() {
        let mesh = triangulate(&square());
        for t in &mesh.triangles {
            for &vi in &t.v {
                assert!(vi < mesh.points.len());
            }
        }
    }
}
