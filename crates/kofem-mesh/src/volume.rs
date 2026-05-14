//! 3-D Constrained Delaunay Tetrahedralization (volume mesher).
//!
//! This module is being built incrementally:
//! - Stage 5.1 (this file): types, helpers, and test fixtures
//! - Stage 5.2: 3-D Bowyer-Watson
//! - Stage 5.3: constrained face recovery
//! - Stage 5.4: interior/exterior classification
//! - Stage 5.5: Delaunay refinement

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::extrude::{Mesh3D, Tet};
use crate::geom::Point3;

// ── Public types ──────────────────────────────────────────────────────────────

/// A closed, watertight triangulated surface.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SurfaceMesh {
    pub points: Vec<Point3>,
    /// Each entry is a triple of indices into `points`.
    pub triangles: Vec<[usize; 3]>,
}

/// Error type for volume meshing operations.
#[derive(Debug, Clone, PartialEq)]
pub enum MeshError {
    NotImplemented,
    DegenerateInput,
    BudgetExhausted,
}

impl std::fmt::Display for MeshError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MeshError::NotImplemented => write!(f, "not implemented"),
            MeshError::DegenerateInput => write!(f, "degenerate input"),
            MeshError::BudgetExhausted => write!(f, "Steiner point budget exhausted"),
        }
    }
}

impl std::error::Error for MeshError {}

/// Options for the volume mesher.
#[derive(Debug, Clone)]
pub struct VolumeMeshOptions {
    /// Circumradius-to-shortest-edge threshold; tets above this are refined.
    pub quality_ratio: f64,
    /// Maximum number of Steiner points inserted during refinement.
    pub max_tets: usize,
}

impl Default for VolumeMeshOptions {
    fn default() -> Self {
        Self {
            quality_ratio: 2.0,
            max_tets: 100_000,
        }
    }
}

// ── Entry point (stub) ────────────────────────────────────────────────────────

/// Fill the interior of `surface` with quality tetrahedra.
///
/// Not yet implemented — subsequent stages (5.2–5.5) complete this.
pub fn volume_mesh(_surface: &SurfaceMesh, _opts: VolumeMeshOptions) -> Result<Mesh3D, MeshError> {
    Err(MeshError::NotImplemented)
}

// ── Geometric helpers ─────────────────────────────────────────────────────────

/// Signed volume of tetrahedron (v[0], v[1], v[2], v[3]).
///
/// V = (1/6) det([b−a, c−a, d−a])
///
/// Positive for right-hand oriented tets.
pub fn tet_signed_volume(pts: &[[f64; 3]], tet: &[usize; 4]) -> f64 {
    let a = pts[tet[0]];
    let b = pts[tet[1]];
    let c = pts[tet[2]];
    let d = pts[tet[3]];
    let bma = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let cma = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let dma = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    // scalar triple product: (b−a) · ((c−a) × (d−a))
    let cross = [
        cma[1] * dma[2] - cma[2] * dma[1],
        cma[2] * dma[0] - cma[0] * dma[2],
        cma[0] * dma[1] - cma[1] * dma[0],
    ];
    (bma[0] * cross[0] + bma[1] * cross[1] + bma[2] * cross[2]) / 6.0
}

/// Convenience wrapper: signed volume using `Mesh3D` point indexing.
pub fn tet_signed_volume_mesh(mesh: &Mesh3D, tet: &Tet) -> f64 {
    let pts: Vec<[f64; 3]> = mesh.points.iter().map(|p| [p.x, p.y, p.z]).collect();
    tet_signed_volume(&pts, &tet.v)
}

/// Circumsphere of tetrahedron (v[0]..v[3]).
///
/// Returns `(center, radius_sq)`.  `radius_sq` is `f64::INFINITY` for degenerate tets.
pub fn tet_circumsphere(pts: &[[f64; 3]], tet: &[usize; 4]) -> ([f64; 3], f64) {
    let a = pts[tet[0]];
    let b = pts[tet[1]];
    let c = pts[tet[2]];
    let d = pts[tet[3]];

    // Translate so `a` is at the origin, then solve the 3×3 Cramer system:
    //   2·[b−a, c−a, d−a]ᵀ · u = [|b−a|², |c−a|², |d−a|²]
    let b = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let c = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let d = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    let b2 = b[0] * b[0] + b[1] * b[1] + b[2] * b[2];
    let c2 = c[0] * c[0] + c[1] * c[1] + c[2] * c[2];
    let d2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];

    let det = 2.0
        * (b[0] * (c[1] * d[2] - c[2] * d[1]) - b[1] * (c[0] * d[2] - c[2] * d[0])
            + b[2] * (c[0] * d[1] - c[1] * d[0]));

    if det.abs() < 1e-20 {
        return ([0.0; 3], f64::INFINITY);
    }

    let ux = (b2 * (c[1] * d[2] - c[2] * d[1]) - b[1] * (c2 * d[2] - c[2] * d2)
        + b[2] * (c2 * d[1] - c[1] * d2))
        / det;
    let uy = (b[0] * (c2 * d[2] - c[2] * d2) - b2 * (c[0] * d[2] - c[2] * d[0])
        + b[2] * (c[0] * d2 - c2 * d[0]))
        / det;
    let uz = (b[0] * (c[1] * d2 - c2 * d[1]) - b[1] * (c[0] * d2 - c2 * d[0])
        + b2 * (c[0] * d[1] - c[1] * d[0]))
        / det;

    let center = [a[0] + ux, a[1] + uy, a[2] + uz];
    let r2 = ux * ux + uy * uy + uz * uz;
    (center, r2)
}

// ── Bowyer-Watson 3-D Delaunay tetrahedralization ────────────────────────────

/// Incremental Delaunay tetrahedralization of a point set (3-D Bowyer-Watson).
///
/// Returns tets with positive orientation ([`tet_signed_volume`] > 0).
/// Requires at least 4 non-coplanar input points.
pub fn bowyer_watson_3d(pts: &[[f64; 3]]) -> Vec<[usize; 4]> {
    let n = pts.len();
    if n < 4 {
        return vec![];
    }

    // Working point list: input points followed by 4 super-tetrahedron vertices.
    let mut all_pts: Vec<[f64; 3]> = pts.to_vec();
    append_super_tet_vertices(&mut all_pts, pts);
    let super_start = n;

    // Orient the super-tet positively before we begin.
    let st0 = [
        super_start,
        super_start + 1,
        super_start + 2,
        super_start + 3,
    ];
    let st = if tet_signed_volume(&all_pts, &st0) > 0.0 {
        st0
    } else {
        [
            super_start,
            super_start + 2,
            super_start + 1,
            super_start + 3,
        ]
    };
    let mut tets: Vec<[usize; 4]> = vec![st];

    // Insert each input point one at a time.
    for (i, &p) in pts.iter().enumerate() {
        // Classify: tets whose circumsphere contains p → cavity; rest → outside.
        // The small tolerance robustly captures co-spherical points.
        let mut cavity: Vec<[usize; 4]> = Vec::new();
        let mut outside: Vec<[usize; 4]> = Vec::new();
        for &tet in &tets {
            let (cc, r2) = tet_circumsphere(&all_pts, &tet);
            if bw_inside(p, cc, r2) {
                cavity.push(tet);
            } else {
                outside.push(tet);
            }
        }

        // Boundary = faces that appear exactly once across all cavity tets.
        let boundary = cavity_boundary_faces(&cavity);

        // Re-triangulate: connect each boundary face to the new point.
        tets = outside;
        for face in boundary {
            let [a, b, c] = face;
            let vol = tet_signed_volume(&all_pts, &[a, b, c, i]);
            if vol > 0.0 {
                tets.push([a, b, c, i]);
            } else if vol < 0.0 {
                tets.push([a, c, b, i]);
            }
            // vol == 0: degenerate — skip (requires degenerate input, not expected)
        }
    }

    // Strip any tet that touches a super-tetrahedron vertex.
    tets.retain(|t| t.iter().all(|&v| v < n));
    tets
}

/// Append four vertices that form a super-tetrahedron enclosing all of `pts`.
fn append_super_tet_vertices(all_pts: &mut Vec<[f64; 3]>, pts: &[[f64; 3]]) {
    let mut lo = pts[0];
    let mut hi = pts[0];
    for &p in pts {
        for k in 0..3 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    let cx = (lo[0] + hi[0]) * 0.5;
    let cy = (lo[1] + hi[1]) * 0.5;
    let cz = (lo[2] + hi[2]) * 0.5;
    // Scale: 20× the longest bounding-box side (at least 1) so all points fit inside.
    let s = (0..3)
        .map(|k| hi[k] - lo[k])
        .fold(0.0_f64, f64::max)
        .max(1.0)
        * 20.0;
    all_pts.push([cx, cy + 3.0 * s, cz - s]);
    all_pts.push([cx - 3.0 * s, cy - s, cz - s]);
    all_pts.push([cx + 3.0 * s, cy - s, cz - s]);
    all_pts.push([cx, cy, cz + 3.0 * s]);
}

/// True when `p` is inside (or on, within floating-point tolerance) the sphere
/// centred at `cc` with squared radius `r2`.
#[inline]
fn bw_inside(p: [f64; 3], cc: [f64; 3], r2: f64) -> bool {
    let dx = p[0] - cc[0];
    let dy = p[1] - cc[1];
    let dz = p[2] - cc[2];
    let d2 = dx * dx + dy * dy + dz * dz;
    // Relative + absolute epsilon handles co-spherical points (e.g. cube vertices).
    d2 < r2 * (1.0 + 1e-10) + 1e-20
}

/// Return the faces that appear exactly once in `cavity` (the cavity boundary).
fn cavity_boundary_faces(cavity: &[[usize; 4]]) -> Vec<[usize; 3]> {
    let mut counts: HashMap<[usize; 3], u32> = HashMap::new();
    let mut oriented: HashMap<[usize; 3], [usize; 3]> = HashMap::new();
    for &[a, b, c, d] in cavity {
        for face in [[a, b, c], [a, b, d], [a, c, d], [b, c, d]] {
            let key = sorted3(face);
            *counts.entry(key).or_insert(0) += 1;
            oriented.entry(key).or_insert(face);
        }
    }
    counts
        .into_iter()
        .filter(|(_, cnt)| *cnt == 1)
        .map(|(key, _)| oriented[&key])
        .collect()
}

#[inline]
fn sorted3(mut f: [usize; 3]) -> [usize; 3] {
    f.sort_unstable();
    f
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

/// Generate a subdivided icosphere of radius 1, centred at the origin.
///
/// `subdivisions = 0` → 20 triangles (icosahedron).
/// Each subdivision quadruples the triangle count.
pub fn icosphere(subdivisions: u32) -> SurfaceMesh {
    let phi = (1.0 + 5.0_f64.sqrt()) / 2.0;
    // 12 icosahedron vertices (will be normalised to unit sphere)
    let raw: &[[f64; 3]] = &[
        [-1.0, phi, 0.0],
        [1.0, phi, 0.0],
        [-1.0, -phi, 0.0],
        [1.0, -phi, 0.0],
        [0.0, -1.0, phi],
        [0.0, 1.0, phi],
        [0.0, -1.0, -phi],
        [0.0, 1.0, -phi],
        [phi, 0.0, -1.0],
        [phi, 0.0, 1.0],
        [-phi, 0.0, -1.0],
        [-phi, 0.0, 1.0],
    ];
    let mut pts: Vec<[f64; 3]> = raw.iter().map(|p| normalize3(*p)).collect();
    let mut tris: Vec<[usize; 3]> = vec![
        [0, 11, 5],
        [0, 5, 1],
        [0, 1, 7],
        [0, 7, 10],
        [0, 10, 11],
        [1, 5, 9],
        [5, 11, 4],
        [11, 10, 2],
        [10, 7, 6],
        [7, 1, 8],
        [3, 9, 4],
        [3, 4, 2],
        [3, 2, 6],
        [3, 6, 8],
        [3, 8, 9],
        [4, 9, 5],
        [2, 4, 11],
        [6, 2, 10],
        [8, 6, 7],
        [9, 8, 1],
    ];

    for _ in 0..subdivisions {
        let mut cache: HashMap<(usize, usize), usize> = HashMap::new();
        let mut new_tris: Vec<[usize; 3]> = Vec::with_capacity(tris.len() * 4);
        for tri in &tris {
            let [a, b, c] = *tri;
            let ab = midpoint_idx(&mut pts, &mut cache, a, b);
            let bc = midpoint_idx(&mut pts, &mut cache, b, c);
            let ca = midpoint_idx(&mut pts, &mut cache, c, a);
            new_tris.push([a, ab, ca]);
            new_tris.push([b, bc, ab]);
            new_tris.push([c, ca, bc]);
            new_tris.push([ab, bc, ca]);
        }
        tris = new_tris;
    }

    SurfaceMesh {
        points: pts.iter().map(|p| Point3::new(p[0], p[1], p[2])).collect(),
        triangles: tris,
    }
}

#[inline]
fn normalize3(p: [f64; 3]) -> [f64; 3] {
    let len = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
    [p[0] / len, p[1] / len, p[2] / len]
}

fn midpoint_idx(
    pts: &mut Vec<[f64; 3]>,
    cache: &mut HashMap<(usize, usize), usize>,
    a: usize,
    b: usize,
) -> usize {
    let key = if a < b { (a, b) } else { (b, a) };
    if let Some(&idx) = cache.get(&key) {
        return idx;
    }
    let pa = pts[a];
    let pb = pts[b];
    let mid = normalize3([
        (pa[0] + pb[0]) * 0.5,
        (pa[1] + pb[1]) * 0.5,
        (pa[2] + pb[2]) * 0.5,
    ]);
    let idx = pts.len();
    pts.push(mid);
    cache.insert(key, idx);
    idx
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tet_signed_volume_unit_tet() {
        // Right-angle tet: (0,0,0), (1,0,0), (0,1,0), (0,0,1) → volume = 1/6
        let pts: Vec<[f64; 3]> = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ];
        let v = tet_signed_volume(&pts, &[0, 1, 2, 3]);
        assert!((v - 1.0 / 6.0).abs() < 1e-14, "expected 1/6, got {v}");
    }

    #[test]
    fn tet_circumsphere_unit_tet() {
        // Regular tet inscribed in unit sphere: circumradius² = 1
        let s = 1.0_f64 / 3.0_f64.sqrt();
        let pts: Vec<[f64; 3]> = vec![[s, s, s], [-s, -s, s], [-s, s, -s], [s, -s, -s]];
        let (_center, r2) = tet_circumsphere(&pts, &[0, 1, 2, 3]);
        assert!((r2 - 1.0).abs() < 1e-10, "expected r²=1, got {r2}");
    }

    #[test]
    fn icosphere_face_counts() {
        assert_eq!(icosphere(0).triangles.len(), 20);
        assert_eq!(icosphere(1).triangles.len(), 80);
        assert_eq!(icosphere(2).triangles.len(), 320);
    }

    #[test]
    fn icosphere_unit_radius() {
        for p in icosphere(2).points {
            let r = (p.x * p.x + p.y * p.y + p.z * p.z).sqrt();
            assert!((r - 1.0).abs() < 1e-12, "point not on unit sphere: r={r}");
        }
    }

    #[test]
    fn volume_mesh_stub_returns_err() {
        let surface = icosphere(1);
        let result = volume_mesh(&surface, VolumeMeshOptions::default());
        assert!(matches!(result, Err(MeshError::NotImplemented)));
    }

    #[test]
    fn bowyer_watson_3d_cube_vertices() {
        let pts: Vec<[f64; 3]> = vec![
            [0., 0., 0.],
            [1., 0., 0.],
            [1., 1., 0.],
            [0., 1., 0.],
            [0., 0., 1.],
            [1., 0., 1.],
            [1., 1., 1.],
            [0., 1., 1.],
        ];
        let tets = bowyer_watson_3d(&pts);
        let vol: f64 = tets.iter().map(|t| tet_signed_volume(&pts, t).abs()).sum();
        assert!((vol - 1.0).abs() < 1e-10, "expected vol=1.0, got {vol}");
        for t in &tets {
            assert!(
                tet_signed_volume(&pts, t) > 0.,
                "tet {t:?} has non-positive orientation"
            );
        }
    }
}
