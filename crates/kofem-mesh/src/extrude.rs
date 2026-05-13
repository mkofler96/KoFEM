//! Extrude a 2-D triangle mesh into a 3-D tetrahedral mesh.
//!
//! Each triangular prism (triangle × layer) is split into 3 tetrahedra
//! using the consistent Schöberl decomposition, which avoids cracks at
//! shared prism faces.

use serde::{Deserialize, Serialize};

use crate::geom::{Point2, Point3};
use crate::triangulate::{Mesh2D, Triangle};

// ── Output types ──────────────────────────────────────────────────────────────

/// A 3-D tetrahedron referencing indices into a [`Mesh3D::points`] array.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Tet {
    pub v: [usize; 4],
}

/// A 3-D tetrahedral mesh produced by extrusion.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Mesh3D {
    pub points: Vec<Point3>,
    pub tets: Vec<Tet>,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Lift a 2-D point to 3-D by displacing it by `t * direction`.
#[inline]
fn lift(p: Point2, direction: [f64; 3], t: f64) -> Point3 {
    Point3::new(
        p.x + t * direction[0],
        p.y + t * direction[1],
        t * direction[2],
    )
}

/// Split a triangular prism into 3 tetrahedra.
///
/// The prism has bottom face `[b0, b1, b2]` and top face `[t0, t1, t2]`
/// where vertex `bi` corresponds to vertex `ti`.
///
/// Decomposition (Schöberl / J. Brandts):
/// ```text
///   Tet 0: b0, b1, b2, t0
///   Tet 1: b1, b2, t0, t1
///   Tet 2: b2, t0, t1, t2
/// ```
/// This is consistent across adjacent prisms sharing the edge b2–t0.
fn split_prism(b: [usize; 3], t: [usize; 3]) -> [Tet; 3] {
    [
        Tet {
            v: [b[0], b[1], b[2], t[0]],
        },
        Tet {
            v: [b[1], b[2], t[0], t[1]],
        },
        Tet {
            v: [b[2], t[0], t[1], t[2]],
        },
    ]
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Extrude `mesh2d` along `direction` (need not be a unit vector; its
/// magnitude is used directly).  The extrusion is divided into `layers`
/// equal slices.
///
/// Node layout: layer `k` occupies indices `k * n2d .. (k+1) * n2d`,
/// where `n2d = mesh2d.points.len()`.  Layer 0 is the original 2-D plane,
/// layer `layers` is the extruded end.
pub fn extrude(mesh2d: &Mesh2D, direction: [f64; 3], layers: usize) -> Mesh3D {
    assert!(layers >= 1, "need at least one layer");

    let n2d = mesh2d.points.len();
    let n3d = n2d * (layers + 1);
    let mut points = Vec::with_capacity(n3d);

    // Build all node layers.
    for k in 0..=layers {
        let t = k as f64 / layers as f64; // 0.0 .. 1.0
        for &p2 in &mesh2d.points {
            points.push(lift(p2, direction, t));
        }
    }

    // Build tetrahedra layer by layer.
    let n_tris = mesh2d.triangles.len();
    let mut tets = Vec::with_capacity(n_tris * layers * 3);

    for k in 0..layers {
        let base = k * n2d;
        let top = (k + 1) * n2d;
        for &Triangle { v: [a, b, c] } in &mesh2d.triangles {
            let b_face = [base + a, base + b, base + c];
            let t_face = [top + a, top + b, top + c];
            tets.extend_from_slice(&split_prism(b_face, t_face));
        }
    }

    Mesh3D { points, tets }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::Point2;
    use crate::triangulate::triangulate;

    fn unit_square() -> Vec<Point2> {
        vec![
            Point2::new(0.0, 0.0),
            Point2::new(1.0, 0.0),
            Point2::new(1.0, 1.0),
            Point2::new(0.0, 1.0),
        ]
    }

    #[test]
    fn node_count() {
        let mesh2d = triangulate(&unit_square());
        let n2d = mesh2d.points.len();
        let layers = 3;
        let mesh3d = extrude(&mesh2d, [0.0, 0.0, 1.0], layers);
        assert_eq!(mesh3d.points.len(), n2d * (layers + 1));
    }

    #[test]
    fn tet_count() {
        let mesh2d = triangulate(&unit_square());
        let n_tris = mesh2d.triangles.len();
        let layers = 4;
        let mesh3d = extrude(&mesh2d, [0.0, 0.0, 1.0], layers);
        assert_eq!(mesh3d.tets.len(), n_tris * layers * 3);
    }

    #[test]
    fn all_tet_indices_in_range() {
        let mesh2d = triangulate(&unit_square());
        let mesh3d = extrude(&mesh2d, [0.0, 0.0, 1.0], 2);
        let n = mesh3d.points.len();
        for tet in &mesh3d.tets {
            for &vi in &tet.v {
                assert!(vi < n, "index {vi} out of range (n={n})");
            }
        }
    }

    #[test]
    fn positive_tet_volume() {
        let mesh2d = triangulate(&unit_square());
        let mesh3d = extrude(&mesh2d, [0.0, 0.0, 1.0], 1);
        for tet in &mesh3d.tets {
            let [i0, i1, i2, i3] = tet.v;
            let p = &mesh3d.points;
            // Signed volume = det([p1-p0, p2-p0, p3-p0]) / 6
            let v = |i: usize, j: usize| -> [f64; 3] {
                [p[j].x - p[i].x, p[j].y - p[i].y, p[j].z - p[i].z]
            };
            let a = v(i0, i1);
            let b = v(i0, i2);
            let c = v(i0, i3);
            let vol = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
                + a[2] * (b[0] * c[1] - b[1] * c[0]);
            assert!(vol > 0.0, "tet {tet:?} has non-positive volume {vol}");
        }
    }
}
