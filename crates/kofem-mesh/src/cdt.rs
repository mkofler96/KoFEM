//! Constrained Delaunay Triangulation (CDT) helpers.

use std::collections::{HashMap, HashSet};

use crate::geom::{in_circumcircle, orient2d, Point2};
use crate::triangulate::bowyer_watson;
use crate::triangulate::{filter_interior, remove_super, Mesh2D, Triangle};

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

/// Constrained Delaunay triangulation of a boundary polygon.
///
/// Triangulates `boundary` (CCW, closed polygon) and then enforces each
/// constraint edge `(a, b)` by re-triangulating the cavities that form when
/// the constraint is inserted.  If `constraints` is empty this is equivalent
/// to [`crate::triangulate::triangulate`].
pub fn triangulate_constrained(boundary: &[Point2], constraints: &[(usize, usize)]) -> Mesh2D {
    let (all_pts, mut triangles) = bowyer_watson(boundary);
    let n_orig = boundary.len();
    remove_super(&mut triangles, n_orig);
    filter_interior(&mut triangles, &all_pts, boundary);

    for &(a, b) in constraints {
        enforce_constraint(&mut triangles, &all_pts, a, b);
    }

    Mesh2D {
        points: all_pts[..n_orig].to_vec(),
        triangles,
    }
}

/// Inserts constraint edge `(a, b)` into an existing triangulation.
fn enforce_constraint(triangles: &mut Vec<Triangle>, pts: &[Point2], a: usize, b: usize) {
    if has_edge(triangles, a, b) {
        return;
    }

    // Find all triangles whose interior is crossed by segment (a, b).
    let crossed_set: HashSet<usize> = triangles
        .iter()
        .enumerate()
        .filter(|(_, t)| {
            t.edges().iter().any(|&(u, v)| {
                u != a
                    && u != b
                    && v != a
                    && v != b
                    && segments_properly_intersect(pts[a], pts[b], pts[u], pts[v])
            })
        })
        .map(|(i, _)| i)
        .collect();

    if crossed_set.is_empty() {
        return;
    }

    // Boundary edges of the crossed set: edges shared by exactly one crossed triangle.
    let mut edge_count: HashMap<(usize, usize), usize> = HashMap::new();
    for &ti in &crossed_set {
        for (u, v) in triangles[ti].edges() {
            let key = if u < v { (u, v) } else { (v, u) };
            *edge_count.entry(key).or_insert(0) += 1;
        }
    }

    // Collect boundary edges (count == 1) with their directed orientation.
    let boundary_edges: Vec<(usize, usize)> = crossed_set
        .iter()
        .flat_map(|&ti| triangles[ti].edges())
        .filter(|&(u, v)| {
            let key = if u < v { (u, v) } else { (v, u) };
            edge_count[&key] == 1
        })
        .collect();

    // Classify non-endpoint boundary vertices as left or right of a→b.
    let mut left_verts: HashSet<usize> = HashSet::new();
    let mut right_verts: HashSet<usize> = HashSet::new();
    for &(u, v) in &boundary_edges {
        for &vi in &[u, v] {
            if vi == a || vi == b {
                continue;
            }
            if orient2d(pts[a], pts[b], pts[vi]) > 0.0 {
                left_verts.insert(vi);
            } else {
                right_verts.insert(vi);
            }
        }
    }

    let left_cavity = order_cavity(a, b, &left_verts, &boundary_edges);
    let right_cavity = order_cavity(b, a, &right_verts, &boundary_edges);

    // Remove crossed triangles.
    {
        let mut idx = 0;
        triangles.retain(|_| {
            let keep = !crossed_set.contains(&idx);
            idx += 1;
            keep
        });
    }

    triangles.extend(retri_cavity(a, b, &left_cavity, pts));
    triangles.extend(retri_cavity(b, a, &right_cavity, pts));
}

/// Orders the cavity interior vertices into a path from `start` to `end`
/// using the cavity's boundary edges.  Returns only the interior vertices
/// (i.e., excluding `start` and `end`).
fn order_cavity(
    start: usize,
    end: usize,
    verts: &HashSet<usize>,
    boundary_edges: &[(usize, usize)],
) -> Vec<usize> {
    // Build adjacency restricted to cavity vertices + endpoints.
    let mut adj: HashMap<usize, Vec<usize>> = HashMap::new();
    for &(u, v) in boundary_edges {
        let u_ok = u == start || u == end || verts.contains(&u);
        let v_ok = v == start || v == end || verts.contains(&v);
        if u_ok && v_ok {
            adj.entry(u).or_default().push(v);
            adj.entry(v).or_default().push(u);
        }
    }

    // Walk from start to end, collecting interior vertices.
    let mut path: Vec<usize> = Vec::new();
    let mut current = start;
    let mut prev = usize::MAX;

    loop {
        let next = adj
            .get(&current)
            .and_then(|ns| {
                ns.iter()
                    .find(|&&n| n != prev && (verts.contains(&n) || n == end))
            })
            .copied();

        match next {
            Some(n) if n == end => break,
            Some(n) => {
                path.push(n);
                prev = current;
                current = n;
            }
            None => break,
        }
    }

    path
}

/// Re-triangulates a polygonal cavity on one side of constraint edge `(a, b)`.
///
/// `cavity` lists the ordered interior vertices of the cavity going from `a`
/// to `b` along the cavity boundary (endpoints excluded).  Uses greedy
/// Delaunay ear selection: picks apex `c` such that no other cavity vertex
/// lies inside `circumcircle(a, b, c)`.  All returned triangles are CCW.
pub fn retri_cavity(a: usize, b: usize, cavity: &[usize], pts: &[Point2]) -> Vec<Triangle> {
    if cavity.is_empty() {
        return vec![];
    }

    // Find apex whose circumcircle (with a and b) is empty of other cavity vertices.
    let c_idx = (0..cavity.len())
        .find(|&i| {
            let c = cavity[i];
            // Normalise to CCW for the in_circumcircle predicate.
            let (ta, tb, tc) = if orient2d(pts[a], pts[b], pts[c]) > 0.0 {
                (a, b, c)
            } else {
                (b, a, c)
            };
            cavity
                .iter()
                .enumerate()
                .all(|(j, &d)| j == i || !in_circumcircle(pts, ta, tb, tc, d))
        })
        .expect("a valid Delaunay apex must always exist for a convex cavity");

    let c = cavity[c_idx];

    let tri = if orient2d(pts[a], pts[b], pts[c]) > 0.0 {
        Triangle { v: [a, b, c] }
    } else {
        Triangle { v: [b, a, c] }
    };

    let mut result = vec![tri];
    result.extend(retri_cavity(a, c, &cavity[..c_idx], pts));
    result.extend(retri_cavity(c, b, &cavity[c_idx + 1..], pts));
    result
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

    #[test]
    fn cavity_retri_produces_constraint_edge() {
        use crate::geom::orient2d;
        let pts = vec![
            Point2::new(0.0, 1.0),  // 0 top
            Point2::new(1.0, 0.0),  // 1 right
            Point2::new(0.0, -1.0), // 2 bottom
            Point2::new(-1.0, 0.0), // 3 left
        ];
        let mesh = triangulate_constrained(&pts, &[]);
        for t in &mesh.triangles {
            for &vi in &t.v {
                assert!(vi < 4);
            }
        }
        assert_eq!(mesh.triangles.len(), 2);
        for t in &mesh.triangles {
            let [a, b, c] = t.v;
            assert!(orient2d(mesh.points[a], mesh.points[b], mesh.points[c]) > 0.0);
        }
    }

    #[test]
    fn l_shape_no_crossing_diagonals() {
        use crate::geom::point_in_polygon;
        let outer = vec![
            Point2::new(0.0, 0.0),
            Point2::new(2.0, 0.0),
            Point2::new(2.0, 1.0),
            Point2::new(1.0, 1.0),
            Point2::new(1.0, 2.0),
            Point2::new(0.0, 2.0),
        ];
        let mesh = triangulate_constrained(&outer, &[]);
        for t in &mesh.triangles {
            let c = t.centroid(&mesh.points);
            assert!(point_in_polygon(c, &outer));
        }
    }
}
