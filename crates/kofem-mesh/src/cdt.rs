//! Constrained Delaunay Triangulation (CDT) helpers.

use std::collections::HashSet;

use crate::geom::{orient2d, Point2};
use crate::triangulate::Triangle;

/// Returns `true` iff some triangle in `triangles` contains both vertex `a` and vertex `b`.
///
/// Order of `a` and `b` does not matter.
pub fn has_edge(triangles: &[Triangle], a: usize, b: usize) -> bool {
    triangles
        .iter()
        .any(|t| t.v.contains(&a) && t.v.contains(&b))
}

/// Returns all edges `(u, v)` in `triangles` that are properly crossed by segment `(a, b)`.
///
/// "Properly crossed" means the interiors of the two segments intersect — edges
/// sharing an endpoint with `a` or `b` are excluded.  If `(a, b)` already exists
/// as a triangle edge the returned vector is empty.
#[allow(dead_code)]
pub(crate) fn find_crossing_edges(
    triangles: &[Triangle],
    pts: &[Point2],
    a: usize,
    b: usize,
) -> Vec<(usize, usize)> {
    if has_edge(triangles, a, b) {
        return vec![];
    }

    let pa = pts[a];
    let pb = pts[b];

    let mut seen: HashSet<(usize, usize)> = HashSet::new();
    let mut crossing = Vec::new();

    for tri in triangles {
        for (u, v) in tri.edges() {
            if u == a || u == b || v == a || v == b {
                continue;
            }
            let key = if u < v { (u, v) } else { (v, u) };
            if !seen.insert(key) {
                continue;
            }
            if segments_properly_intersect(pa, pb, pts[u], pts[v]) {
                crossing.push((u, v));
            }
        }
    }

    crossing
}

/// `true` iff the open interiors of segments `(p,q)` and `(r,s)` intersect.
#[allow(dead_code)]
fn segments_properly_intersect(p: Point2, q: Point2, r: Point2, s: Point2) -> bool {
    let d1 = orient2d(p, q, r);
    let d2 = orient2d(p, q, s);
    let d3 = orient2d(r, s, p);
    let d4 = orient2d(r, s, q);

    ((d1 > 0.0 && d2 < 0.0) || (d1 < 0.0 && d2 > 0.0))
        && ((d3 > 0.0 && d4 < 0.0) || (d3 < 0.0 && d4 > 0.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::triangulate::bowyer_watson;

    #[test]
    fn has_edge_finds_existing() {
        let tris = vec![Triangle { v: [0, 1, 2] }, Triangle { v: [1, 2, 3] }];
        assert!(has_edge(&tris, 0, 1));
        assert!(has_edge(&tris, 1, 0)); // reverse
        assert!(has_edge(&tris, 1, 3));
        assert!(!has_edge(&tris, 0, 3)); // not adjacent
    }

    #[test]
    fn has_edge_empty_triangulation() {
        let tris: Vec<Triangle> = vec![];
        assert!(!has_edge(&tris, 0, 1));
    }

    #[test]
    fn crossing_edges_identified_for_l_shape() {
        let outer = vec![
            Point2::new(0.0, 0.0),
            Point2::new(2.0, 0.0),
            Point2::new(2.0, 1.0),
            Point2::new(1.0, 1.0),
            Point2::new(1.0, 2.0),
            Point2::new(0.0, 2.0),
        ];
        let (pts, tris) = bowyer_watson(&outer);
        // Constraint from vertex 1 (2,0) → vertex 4 (1,2) crosses some diagonal
        let crossing = find_crossing_edges(&tris, &pts, 1, 4);
        assert!(!crossing.is_empty());
        for (a, b) in &crossing {
            assert!(*a != 1 && *a != 4);
            assert!(*b != 1 && *b != 4);
        }
    }

    #[test]
    fn no_crossing_edges_when_constraint_exists() {
        let outer = vec![
            Point2::new(0.0, 0.0),
            Point2::new(1.0, 0.0),
            Point2::new(1.0, 1.0),
            Point2::new(0.0, 1.0),
        ];
        let (pts, tris) = bowyer_watson(&outer);
        // Edge (0,1) is a boundary edge, must already exist
        let crossing = find_crossing_edges(&tris, &pts, 0, 1);
        assert!(crossing.is_empty());
    }
}
