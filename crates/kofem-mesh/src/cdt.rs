//! Constrained Delaunay Triangulation (CDT) helpers.

use crate::triangulate::Triangle;

/// Returns `true` iff some triangle in `triangles` contains both vertex `a` and vertex `b`.
///
/// Order of `a` and `b` does not matter.
pub fn has_edge(triangles: &[Triangle], a: usize, b: usize) -> bool {
    triangles
        .iter()
        .any(|t| t.v.contains(&a) && t.v.contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
