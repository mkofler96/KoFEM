//! 3-D Constrained Delaunay Tetrahedralization (volume mesher).
//!
//! Implementation status:
//! - Stage 5.1: types, helpers, and test fixtures ✓
//! - Stage 5.2: 3-D Bowyer-Watson ✓
//! - Stage 5.3: constrained face recovery ✓
//! - Stage 5.4: interior/exterior classification ✓
//! - Stage 5.5: Delaunay refinement (TODO)

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

#[inline]
fn sorted2(mut e: [usize; 2]) -> [usize; 2] {
    if e[0] > e[1] {
        e.swap(0, 1);
    }
    e
}

// ── Constrained face recovery (Stage 5.3) ────────────────────────────────────

/// Auxiliary tet mesh for incremental face recovery.
///
/// Maintains adjacency info needed for flips and Steiner insertion.
#[derive(Debug, Clone)]
pub struct TetMesh {
    /// Vertex coordinates (grows as Steiner points are added).
    pub pts: Vec<[f64; 3]>,
    /// Tetrahedra indices into `pts`. Dead tets have `v[0] == usize::MAX`.
    pub tets: Vec<[usize; 4]>,
    /// Map from canonical face key to list of (tet_index, local_face_index).
    /// Interior faces have 2 entries; boundary faces have 1.
    face_to_tets: HashMap<[usize; 3], Vec<(usize, u8)>>,
    /// Map from canonical edge key to list of tet indices using that edge.
    pub edge_to_tets: HashMap<[usize; 2], Vec<usize>>,
}

impl TetMesh {
    /// Build from Bowyer-Watson output.
    pub fn from_tets(pts: Vec<[f64; 3]>, tets: Vec<[usize; 4]>) -> Self {
        let mut mesh = Self {
            pts,
            tets,
            face_to_tets: HashMap::new(),
            edge_to_tets: HashMap::new(),
        };
        mesh.rebuild_adjacency();
        mesh
    }

    /// Rebuild `face_to_tets` and `edge_to_tets` from scratch.
    fn rebuild_adjacency(&mut self) {
        self.face_to_tets.clear();
        self.edge_to_tets.clear();
        for (ti, &tet) in self.tets.iter().enumerate() {
            if tet[0] == usize::MAX {
                continue; // dead tet
            }
            for (fi, face) in tet_faces(tet).iter().enumerate() {
                self.face_to_tets
                    .entry(sorted3(*face))
                    .or_default()
                    .push((ti, fi as u8));
            }
            for edge in tet_edges(tet) {
                self.edge_to_tets.entry(sorted2(edge)).or_default().push(ti);
            }
        }
    }

    /// Check if a face (canonical key) exists in the mesh.
    pub fn has_face(&self, face: [usize; 3]) -> bool {
        self.face_to_tets.contains_key(&sorted3(face))
    }

    /// Get all faces in the mesh.
    pub fn all_faces(&self) -> impl Iterator<Item = [usize; 3]> + '_ {
        self.face_to_tets.keys().copied()
    }

    /// Get tets sharing a face.
    fn tets_sharing_face(&self, face: [usize; 3]) -> Vec<usize> {
        self.face_to_tets
            .get(&sorted3(face))
            .map(|v| v.iter().map(|(ti, _)| *ti).collect())
            .unwrap_or_default()
    }

    /// Extract final tets (skipping dead ones).
    pub fn live_tets(&self) -> Vec<[usize; 4]> {
        self.tets
            .iter()
            .filter(|t| t[0] != usize::MAX)
            .copied()
            .collect()
    }

    /// Mark a tet as dead.
    fn kill_tet(&mut self, ti: usize) {
        self.tets[ti][0] = usize::MAX;
    }

    /// Add a new tet, returning its index.
    fn add_tet(&mut self, tet: [usize; 4]) -> usize {
        let idx = self.tets.len();
        self.tets.push(tet);
        idx
    }

    /// Add a Steiner point, returning its index.
    fn add_point(&mut self, p: [f64; 3]) -> usize {
        let idx = self.pts.len();
        self.pts.push(p);
        idx
    }
}

/// The 4 faces of a tet: opposite vertices 3, 2, 1, 0 respectively.
fn tet_faces(tet: [usize; 4]) -> [[usize; 3]; 4] {
    let [a, b, c, d] = tet;
    [[a, b, c], [a, b, d], [a, c, d], [b, c, d]]
}

/// The 6 edges of a tet.
fn tet_edges(tet: [usize; 4]) -> [[usize; 2]; 6] {
    let [a, b, c, d] = tet;
    [[a, b], [a, c], [a, d], [b, c], [b, d], [c, d]]
}

/// Recover all constraint faces from `surface` in the tet mesh.
///
/// Uses edge flips where possible; inserts Steiner points when flips fail.
/// Returns the number of Steiner points inserted.
pub fn recover_constraint_faces(
    mesh: &mut TetMesh,
    surface: &SurfaceMesh,
    max_steiner: usize,
) -> Result<usize, MeshError> {
    let mut steiner_count = 0;

    // Build set of required faces (canonical keys).
    let required: std::collections::HashSet<[usize; 3]> =
        surface.triangles.iter().map(|tri| sorted3(*tri)).collect();

    // Multiple passes — each pass may enable more faces to be recovered.
    for _pass in 0..20 {
        let mut progress = false;

        for &face_key in &required {
            if mesh.has_face(face_key) {
                continue;
            }

            // Try edge-based recovery: ensure all three edges of the face exist.
            if try_recover_face_edges(mesh, face_key) {
                progress = true;
            }

            // Try to recover via flips on edges crossing the face.
            if try_recover_face_by_flips(mesh, face_key) {
                progress = true;
                continue;
            }
        }

        if !progress {
            break;
        }
    }

    // Steiner insertion loop: insert points for missing faces, then retry recovery.
    loop {
        let missing: Vec<[usize; 3]> = required
            .iter()
            .filter(|f| !mesh.has_face(**f))
            .copied()
            .collect();

        if missing.is_empty() {
            break;
        }

        if steiner_count >= max_steiner {
            return Err(MeshError::BudgetExhausted);
        }

        // Insert Steiner point for the first missing face.
        let face_key = missing[0];
        insert_steiner_on_face(mesh, face_key)?;
        steiner_count += 1;

        // Retry edge and face recovery for all missing faces.
        for _ in 0..10 {
            let mut progress = false;
            for &fk in &required {
                if mesh.has_face(fk) {
                    continue;
                }
                if try_recover_face_edges(mesh, fk) {
                    progress = true;
                }
                if try_recover_face_by_flips(mesh, fk) {
                    progress = true;
                }
            }
            if !progress {
                break;
            }
        }
    }

    Ok(steiner_count)
}

/// Try to recover a face by ensuring its edges exist (via flips).
fn try_recover_face_edges(mesh: &mut TetMesh, face_key: [usize; 3]) -> bool {
    let [a, b, c] = face_key;
    let edges = [[a, b], [b, c], [c, a]];
    let mut made_progress = false;

    for edge in edges {
        let edge_key = sorted2(edge);
        if mesh.edge_to_tets.contains_key(&edge_key) {
            continue;
        }

        // Edge doesn't exist — try to create it via flips.
        if try_create_edge_by_flips(mesh, edge_key) {
            made_progress = true;
        }
    }

    made_progress
}

/// Try to create a missing edge by flipping tets or swapping boundary diagonals.
fn try_create_edge_by_flips(mesh: &mut TetMesh, target_edge: [usize; 2]) -> bool {
    let [e0, e1] = target_edge;

    // First, try boundary diagonal swap (for flat quad faces).
    if try_boundary_edge_swap(mesh, target_edge) {
        return true;
    }

    // Find tets containing e0 that neighbor tets containing e1.
    let tets_with_e0: Vec<usize> = mesh
        .tets
        .iter()
        .enumerate()
        .filter(|(_, t)| t[0] != usize::MAX && t.contains(&e0))
        .map(|(i, _)| i)
        .collect();

    for &ti in &tets_with_e0 {
        let tet = mesh.tets[ti];
        if tet.contains(&e1) {
            return false; // Edge should exist.
        }

        // Check neighbors via shared faces.
        for face in tet_faces(tet) {
            let face_key = sorted3(face);
            let neighbors = mesh.tets_sharing_face(face_key);
            for neighbor_ti in neighbors {
                if neighbor_ti != ti {
                    let neighbor = mesh.tets[neighbor_ti];
                    if neighbor[0] != usize::MAX && neighbor.contains(&e1) {
                        // Found adjacent tets spanning e0 and e1.
                        if try_flip_2_3(mesh, ti, neighbor_ti, target_edge)
                            && mesh.edge_to_tets.contains_key(&target_edge)
                        {
                            return true;
                        }
                    }
                }
            }
        }
    }

    false
}

/// Try to swap a boundary diagonal to create the target edge.
///
/// This handles the case where two coplanar boundary triangles use the "wrong"
/// diagonal. For example, triangles [0,1,3] and [1,2,3] with edge [1,3] can be
/// swapped to [0,1,2] and [0,2,3] with edge [0,2].
fn try_boundary_edge_swap(mesh: &mut TetMesh, target_edge: [usize; 2]) -> bool {
    let [e0, e1] = target_edge;

    // Find boundary faces containing e0 but not e1, and vice versa.
    // A boundary face has exactly one tet.
    let mut faces_with_e0: Vec<[usize; 3]> = Vec::new();
    let mut faces_with_e1: Vec<[usize; 3]> = Vec::new();

    for (&face_key, tets) in &mesh.face_to_tets {
        if tets.len() != 1 {
            continue; // Interior face, skip.
        }
        if face_key.contains(&e0) && !face_key.contains(&e1) {
            faces_with_e0.push(face_key);
        }
        if face_key.contains(&e1) && !face_key.contains(&e0) {
            faces_with_e1.push(face_key);
        }
    }

    // Look for two boundary faces that together form a quad with the wrong diagonal.
    for &f0 in &faces_with_e0 {
        for &f1 in &faces_with_e1 {
            // Check if they share exactly one edge (the wrong diagonal).
            let shared = shared_edge(f0, f1);
            if shared.is_none() {
                continue;
            }
            let wrong_diag = shared.unwrap();

            // The four vertices of the quad.
            let quad: Vec<usize> = f0
                .iter()
                .chain(f1.iter())
                .copied()
                .collect::<std::collections::HashSet<_>>()
                .into_iter()
                .collect();
            if quad.len() != 4 {
                continue;
            }

            // Verify target edge would connect the quad correctly.
            if !quad.contains(&e0) || !quad.contains(&e1) {
                continue;
            }

            // Find the tets containing these faces.
            let ti0 = mesh.face_to_tets.get(&f0).map(|v| v[0].0);
            let ti1 = mesh.face_to_tets.get(&f1).map(|v| v[0].0);
            if ti0.is_none() || ti1.is_none() {
                continue;
            }
            let ti0 = ti0.unwrap();
            let ti1 = ti1.unwrap();

            // The tets should share the wrong diagonal edge.
            let tet0 = mesh.tets[ti0];
            let tet1 = mesh.tets[ti1];
            if !has_edge(tet0, wrong_diag) || !has_edge(tet1, wrong_diag) {
                continue;
            }

            // Get the apex of each tet (vertex not in the quad).
            let apex0 = tet0.iter().find(|&&v| !quad.contains(&v)).copied();
            let apex1 = tet1.iter().find(|&&v| !quad.contains(&v)).copied();

            // For boundary swap, both apexes should be the same (the interior vertex).
            if apex0 != apex1 || apex0.is_none() {
                continue;
            }
            let apex = apex0.unwrap();

            // Create new tets with the swapped diagonal.
            // New faces: [e0, wrong_diag[0], e1], [e0, e1, wrong_diag[1]]
            // But we need tets, not faces. Connect to apex.
            let [w0, w1] = wrong_diag;
            let new_tet0 = orient_tet(&mesh.pts, [e0, w0, e1, apex]);
            let new_tet1 = orient_tet(&mesh.pts, [e0, e1, w1, apex]);

            if new_tet0.is_none() || new_tet1.is_none() {
                continue; // Would create degenerate tets.
            }

            // Perform the swap.
            mesh.kill_tet(ti0);
            mesh.kill_tet(ti1);
            mesh.add_tet(new_tet0.unwrap());
            mesh.add_tet(new_tet1.unwrap());
            mesh.rebuild_adjacency();

            return mesh.edge_to_tets.contains_key(&target_edge);
        }
    }

    false
}

/// Find the shared edge between two triangles, if any.
fn shared_edge(f0: [usize; 3], f1: [usize; 3]) -> Option<[usize; 2]> {
    let edges0 = [[f0[0], f0[1]], [f0[1], f0[2]], [f0[2], f0[0]]];
    let edges1 = [[f1[0], f1[1]], [f1[1], f1[2]], [f1[2], f1[0]]];
    for e0 in edges0 {
        for e1 in edges1 {
            if sorted2(e0) == sorted2(e1) {
                return Some(sorted2(e0));
            }
        }
    }
    None
}

/// Orient a tet to have positive volume, or return None if degenerate.
fn orient_tet(pts: &[[f64; 3]], tet: [usize; 4]) -> Option<[usize; 4]> {
    let vol = tet_signed_volume(pts, &tet);
    if vol.abs() < 1e-20 {
        return None;
    }
    if vol > 0.0 {
        Some(tet)
    } else {
        Some([tet[0], tet[2], tet[1], tet[3]])
    }
}

/// Attempt to recover `face_key` using local edge flips.
///
/// Returns `true` if the face is now present in the mesh.
fn try_recover_face_by_flips(mesh: &mut TetMesh, face_key: [usize; 3]) -> bool {
    // Find edges crossing the plane of the missing face.
    // We'll try 2-3 flips on edges that intersect the face interior.
    let [a, b, c] = face_key;
    let pa = mesh.pts[a];
    let pb = mesh.pts[b];
    let pc = mesh.pts[c];

    // Face normal and plane equation.
    let ab = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    let ac = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
    let n = cross3(ab, ac);
    let d = -(n[0] * pa[0] + n[1] * pa[1] + n[2] * pa[2]);

    // Look for edges in tets adjacent to the face vertices that cross the face plane.
    let mut candidate_edges: Vec<[usize; 2]> = Vec::new();
    for &v in &[a, b, c] {
        for tet in &mesh.tets {
            if tet[0] == usize::MAX {
                continue;
            }
            if !tet.contains(&v) {
                continue;
            }
            for edge in tet_edges(*tet) {
                let [e0, e1] = edge;
                // Skip edges that share a vertex with the face.
                if [a, b, c].contains(&e0) || [a, b, c].contains(&e1) {
                    continue;
                }
                let p0 = mesh.pts[e0];
                let p1 = mesh.pts[e1];
                let s0 = n[0] * p0[0] + n[1] * p0[1] + n[2] * p0[2] + d;
                let s1 = n[0] * p1[0] + n[1] * p1[1] + n[2] * p1[2] + d;
                // Check if edge crosses the plane (opposite signs).
                if s0 * s1 < 0.0 {
                    let key = sorted2(edge);
                    if !candidate_edges.contains(&key) {
                        candidate_edges.push(key);
                    }
                }
            }
        }
    }

    // Try flipping each candidate edge.
    for edge in candidate_edges {
        if try_flip_edge(mesh, edge, face_key) && mesh.has_face(face_key) {
            return true;
        }
    }

    // Multiple flip iterations may be needed — try a few rounds.
    for _ in 0..10 {
        if mesh.has_face(face_key) {
            return true;
        }
        // Recollect and retry.
        let mut made_progress = false;
        for edge in collect_crossing_edges(mesh, face_key) {
            if try_flip_edge(mesh, edge, face_key) {
                made_progress = true;
                if mesh.has_face(face_key) {
                    return true;
                }
            }
        }
        if !made_progress {
            break;
        }
    }

    mesh.has_face(face_key)
}

/// Collect edges that cross the interior of the face plane.
fn collect_crossing_edges(mesh: &TetMesh, face_key: [usize; 3]) -> Vec<[usize; 2]> {
    let [a, b, c] = face_key;
    let pa = mesh.pts[a];
    let pb = mesh.pts[b];
    let pc = mesh.pts[c];
    let ab = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    let ac = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
    let n = cross3(ab, ac);
    let d = -(n[0] * pa[0] + n[1] * pa[1] + n[2] * pa[2]);

    let mut edges: Vec<[usize; 2]> = Vec::new();
    for tet in &mesh.tets {
        if tet[0] == usize::MAX {
            continue;
        }
        for edge in tet_edges(*tet) {
            let [e0, e1] = edge;
            if [a, b, c].contains(&e0) || [a, b, c].contains(&e1) {
                continue;
            }
            let p0 = mesh.pts[e0];
            let p1 = mesh.pts[e1];
            let s0 = n[0] * p0[0] + n[1] * p0[1] + n[2] * p0[2] + d;
            let s1 = n[0] * p1[0] + n[1] * p1[1] + n[2] * p1[2] + d;
            if s0 * s1 < 0.0 {
                let key = sorted2(edge);
                if !edges.contains(&key) {
                    edges.push(key);
                }
            }
        }
    }
    edges
}

/// Try a 2-3 or 3-2 flip on `edge`. Returns true if a flip was performed.
fn try_flip_edge(mesh: &mut TetMesh, edge: [usize; 2], _target_face: [usize; 3]) -> bool {
    let edge_key = sorted2(edge);

    // Find all tets sharing this edge.
    let tet_indices: Vec<usize> = mesh
        .tets
        .iter()
        .enumerate()
        .filter(|(_, t)| t[0] != usize::MAX && has_edge(**t, edge_key))
        .map(|(i, _)| i)
        .collect();

    if tet_indices.len() == 2 {
        // 2-3 flip: two tets sharing a face → three tets sharing an edge.
        return try_flip_2_3(mesh, tet_indices[0], tet_indices[1], edge_key);
    } else if tet_indices.len() == 3 {
        // 3-2 flip: three tets sharing an edge → two tets sharing a face.
        return try_flip_3_2(mesh, &tet_indices, edge_key);
    }

    false
}

/// Check if tet contains edge (canonical).
fn has_edge(tet: [usize; 4], edge: [usize; 2]) -> bool {
    tet.contains(&edge[0]) && tet.contains(&edge[1])
}

/// 2-3 flip: replace two tets sharing a common face with three tets.
fn try_flip_2_3(mesh: &mut TetMesh, ti0: usize, ti1: usize, _edge: [usize; 2]) -> bool {
    let tet0 = mesh.tets[ti0];
    let tet1 = mesh.tets[ti1];

    // Find the shared face.
    let shared = find_shared_face(tet0, tet1);
    if shared.is_none() {
        return false;
    }
    let shared_face = shared.unwrap();

    // The apex in each tet (vertex not on shared face).
    let apex0 = tet0.iter().find(|&&v| !shared_face.contains(&v)).copied();
    let apex1 = tet1.iter().find(|&&v| !shared_face.contains(&v)).copied();
    if apex0.is_none() || apex1.is_none() {
        return false;
    }
    let d0 = apex0.unwrap();
    let d1 = apex1.unwrap();

    // New edge connects the two apexes.
    let _new_edge = sorted2([d0, d1]);

    // Verify the three new tets would have positive volume.
    let [a, b, c] = shared_face;
    let new_tets = [[a, b, d0, d1], [b, c, d0, d1], [c, a, d0, d1]];
    for nt in &new_tets {
        let vol = tet_signed_volume(&mesh.pts, nt);
        if vol <= 1e-20 {
            return false; // Would create degenerate or inverted tet.
        }
    }

    // Perform the flip.
    mesh.kill_tet(ti0);
    mesh.kill_tet(ti1);
    for nt in new_tets {
        mesh.add_tet(nt);
    }

    // Rebuild adjacency (simpler than incremental update for now).
    mesh.rebuild_adjacency();
    true
}

/// 3-2 flip: replace three tets sharing an edge with two tets sharing a face.
fn try_flip_3_2(mesh: &mut TetMesh, tet_indices: &[usize], edge: [usize; 2]) -> bool {
    if tet_indices.len() != 3 {
        return false;
    }

    let [e0, e1] = edge;
    let tets: Vec<[usize; 4]> = tet_indices.iter().map(|&i| mesh.tets[i]).collect();

    // Collect the ring of vertices around the edge (should be 3 vertices).
    let mut ring: Vec<usize> = Vec::new();
    for tet in &tets {
        for &v in tet {
            if v != e0 && v != e1 && !ring.contains(&v) {
                ring.push(v);
            }
        }
    }
    if ring.len() != 3 {
        return false;
    }

    // New tets: connect each edge endpoint to the triangle ring.
    let [r0, r1, r2] = [ring[0], ring[1], ring[2]];
    let new_tets = [[r0, r1, r2, e0], [r0, r2, r1, e1]];

    // Verify positive volume.
    for nt in &new_tets {
        let vol = tet_signed_volume(&mesh.pts, nt);
        if vol <= 1e-20 {
            // Try swapping orientation.
            let flipped = [nt[0], nt[2], nt[1], nt[3]];
            if tet_signed_volume(&mesh.pts, &flipped) <= 1e-20 {
                return false;
            }
        }
    }

    // Perform the flip.
    for &ti in tet_indices {
        mesh.kill_tet(ti);
    }

    // Add with correct orientation.
    for nt in new_tets {
        let vol = tet_signed_volume(&mesh.pts, &nt);
        if vol > 0.0 {
            mesh.add_tet(nt);
        } else {
            mesh.add_tet([nt[0], nt[2], nt[1], nt[3]]);
        }
    }

    mesh.rebuild_adjacency();
    true
}

/// Find the face shared by two tets, if any.
fn find_shared_face(tet0: [usize; 4], tet1: [usize; 4]) -> Option<[usize; 3]> {
    for face in tet_faces(tet0) {
        let key = sorted3(face);
        for face1 in tet_faces(tet1) {
            if sorted3(face1) == key {
                return Some(key);
            }
        }
    }
    None
}

/// Insert a Steiner point near the missing face to enable its recovery.
///
/// The point is placed at the face centroid, offset slightly inward along
/// the face normal to avoid degenerate tets.
fn insert_steiner_on_face(mesh: &mut TetMesh, face_key: [usize; 3]) -> Result<(), MeshError> {
    let [a, b, c] = face_key;
    let pa = mesh.pts[a];
    let pb = mesh.pts[b];
    let pc = mesh.pts[c];

    // Face centroid.
    let centroid = [
        (pa[0] + pb[0] + pc[0]) / 3.0,
        (pa[1] + pb[1] + pc[1]) / 3.0,
        (pa[2] + pb[2] + pc[2]) / 3.0,
    ];

    // Face normal (not normalized).
    let ab = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    let ac = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
    let n = cross3(ab, ac);
    let n_len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();

    // Offset: small fraction of face size, along normal (either direction works).
    let offset = if n_len > 1e-14 {
        let scale = 0.01 * n_len.sqrt(); // ~1% of face edge length
        [
            n[0] / n_len * scale,
            n[1] / n_len * scale,
            n[2] / n_len * scale,
        ]
    } else {
        [0.0, 0.0, 0.0]
    };

    // Try both directions (inward/outward) — use whichever is inside the mesh.
    let pt_pos = [
        centroid[0] + offset[0],
        centroid[1] + offset[1],
        centroid[2] + offset[2],
    ];
    let pt_neg = [
        centroid[0] - offset[0],
        centroid[1] - offset[1],
        centroid[2] - offset[2],
    ];

    // Check which point is inside a tet.
    let insertion_pt = if is_inside_mesh(mesh, pt_pos) {
        pt_pos
    } else if is_inside_mesh(mesh, pt_neg) {
        pt_neg
    } else {
        centroid // fallback
    };

    let new_idx = mesh.add_point(insertion_pt);

    // Find tets whose circumsphere contains the new point.
    let mut cavity: Vec<usize> = Vec::new();
    for (ti, tet) in mesh.tets.iter().enumerate() {
        if tet[0] == usize::MAX {
            continue;
        }
        let (cc, r2) = tet_circumsphere(&mesh.pts, tet);
        if bw_inside(centroid, cc, r2) {
            cavity.push(ti);
        }
    }

    if cavity.is_empty() {
        // Point is outside all circumspheres — find containing tet instead.
        for (ti, tet) in mesh.tets.iter().enumerate() {
            if tet[0] == usize::MAX {
                continue;
            }
            if point_in_tet(&mesh.pts, tet, centroid) {
                cavity.push(ti);
                break;
            }
        }
    }

    if cavity.is_empty() {
        return Err(MeshError::DegenerateInput);
    }

    // Extract cavity boundary faces.
    let cavity_tets: Vec<[usize; 4]> = cavity.iter().map(|&ti| mesh.tets[ti]).collect();
    let boundary = cavity_boundary_faces(&cavity_tets);

    // Remove cavity tets.
    for ti in cavity {
        mesh.kill_tet(ti);
    }

    // Create new tets connecting boundary faces to new point.
    for face in boundary {
        let [fa, fb, fc] = face;
        let vol = tet_signed_volume(&mesh.pts, &[fa, fb, fc, new_idx]);
        if vol.abs() < 1e-20 {
            continue; // Degenerate.
        }
        if vol > 0.0 {
            mesh.add_tet([fa, fb, fc, new_idx]);
        } else {
            mesh.add_tet([fa, fc, fb, new_idx]);
        }
    }

    mesh.rebuild_adjacency();
    Ok(())
}

/// Check if a point is inside any tet in the mesh.
fn is_inside_mesh(mesh: &TetMesh, p: [f64; 3]) -> bool {
    for tet in &mesh.tets {
        if tet[0] == usize::MAX {
            continue;
        }
        if point_in_tet(&mesh.pts, tet, p) {
            return true;
        }
    }
    false
}

/// Check if point `p` is inside tetrahedron `tet`.
fn point_in_tet(pts: &[[f64; 3]], tet: &[usize; 4], p: [f64; 3]) -> bool {
    let [a, b, c, d] = *tet;
    let pa = pts[a];
    let pb = pts[b];
    let pc = pts[c];
    let pd = pts[d];

    // Check that p is on the same side of each face as the opposite vertex.
    let same_side =
        |f0: [f64; 3], f1: [f64; 3], f2: [f64; 3], ref_pt: [f64; 3], test_pt: [f64; 3]| {
            let v1 = [f1[0] - f0[0], f1[1] - f0[1], f1[2] - f0[2]];
            let v2 = [f2[0] - f0[0], f2[1] - f0[1], f2[2] - f0[2]];
            let n = cross3(v1, v2);
            let d_ref = n[0] * (ref_pt[0] - f0[0])
                + n[1] * (ref_pt[1] - f0[1])
                + n[2] * (ref_pt[2] - f0[2]);
            let d_test = n[0] * (test_pt[0] - f0[0])
                + n[1] * (test_pt[1] - f0[1])
                + n[2] * (test_pt[2] - f0[2]);
            d_ref * d_test >= -1e-14
        };

    same_side(pa, pb, pc, pd, p)
        && same_side(pa, pb, pd, pc, p)
        && same_side(pa, pc, pd, pb, p)
        && same_side(pb, pc, pd, pa, p)
}

/// Cross product of two 3-vectors.
fn cross3(u: [f64; 3], v: [f64; 3]) -> [f64; 3] {
    [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
    ]
}

#[inline]
fn dot3(u: [f64; 3], v: [f64; 3]) -> f64 {
    u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
}

#[inline]
fn sub3(u: [f64; 3], v: [f64; 3]) -> [f64; 3] {
    [u[0] - v[0], u[1] - v[1], u[2] - v[2]]
}

// ── Stage 5.4: Interior / exterior classification ─────────────────────────────

/// Remove all tetrahedra whose centroid lies outside `surface`.
///
/// Each centroid is tested with a ray cast against the closed surface using
/// the Möller–Trumbore algorithm.  Odd intersection count → inside, even → outside.
pub fn classify_interior_tets(mesh: &mut TetMesh, surface: &SurfaceMesh) {
    let surf_pts: Vec<[f64; 3]> = surface.points.iter().map(|p| [p.x, p.y, p.z]).collect();

    // Slightly non-axis-aligned direction reduces the chance of the ray
    // grazing a surface edge or vertex (which would give an ambiguous count).
    let ray_dir = normalize3([1.0, 1e-4, 1e-8]);

    let dead: Vec<usize> = (0..mesh.tets.len())
        .filter(|&ti| {
            let tet = mesh.tets[ti];
            if tet[0] == usize::MAX {
                return false;
            }
            let c = tet_centroid(&mesh.pts, &tet);
            count_ray_hits(c, ray_dir, &surf_pts, &surface.triangles).is_multiple_of(2)
        })
        .collect();

    for ti in dead {
        mesh.kill_tet(ti);
    }
    mesh.rebuild_adjacency();
}

fn tet_centroid(pts: &[[f64; 3]], tet: &[usize; 4]) -> [f64; 3] {
    let [a, b, c, d] = *tet;
    let (pa, pb, pc, pd) = (pts[a], pts[b], pts[c], pts[d]);
    [
        (pa[0] + pb[0] + pc[0] + pd[0]) * 0.25,
        (pa[1] + pb[1] + pc[1] + pd[1]) * 0.25,
        (pa[2] + pb[2] + pc[2] + pd[2]) * 0.25,
    ]
}

/// Count forward (t > 0) intersections of ray `(origin, dir)` with the surface.
fn count_ray_hits(
    origin: [f64; 3],
    dir: [f64; 3],
    pts: &[[f64; 3]],
    tris: &[[usize; 3]],
) -> usize {
    tris.iter()
        .filter(|tri| ray_triangle_hit(origin, dir, pts[tri[0]], pts[tri[1]], pts[tri[2]]))
        .count()
}

/// Möller–Trumbore ray-triangle intersection (two-sided, t > 0 only).
fn ray_triangle_hit(
    o: [f64; 3],
    d: [f64; 3],
    v0: [f64; 3],
    v1: [f64; 3],
    v2: [f64; 3],
) -> bool {
    const EPS: f64 = 1e-12;
    let e1 = sub3(v1, v0);
    let e2 = sub3(v2, v0);
    let h = cross3(d, e2);
    let a = dot3(e1, h);
    if a.abs() < EPS {
        return false; // ray parallel to triangle
    }
    let f = 1.0 / a;
    let s = sub3(o, v0);
    let u = f * dot3(s, h);
    if !(-EPS..=1.0 + EPS).contains(&u) {
        return false;
    }
    let q = cross3(s, e1);
    let v = f * dot3(d, q);
    if v < -EPS || u + v > 1.0 + EPS {
        return false;
    }
    f * dot3(e2, q) > EPS
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

    /// Unit cube surface mesh (12 triangles, 2 per face).
    fn box_surface_mesh() -> SurfaceMesh {
        let points = vec![
            Point3::new(0., 0., 0.), // 0
            Point3::new(1., 0., 0.), // 1
            Point3::new(1., 1., 0.), // 2
            Point3::new(0., 1., 0.), // 3
            Point3::new(0., 0., 1.), // 4
            Point3::new(1., 0., 1.), // 5
            Point3::new(1., 1., 1.), // 6
            Point3::new(0., 1., 1.), // 7
        ];
        let triangles = vec![
            // Bottom (z=0), normal -Z
            [0, 2, 1],
            [0, 3, 2],
            // Top (z=1), normal +Z
            [4, 5, 6],
            [4, 6, 7],
            // Front (y=0), normal -Y
            [0, 1, 5],
            [0, 5, 4],
            // Back (y=1), normal +Y
            [2, 3, 7],
            [2, 7, 6],
            // Left (x=0), normal -X
            [0, 4, 7],
            [0, 7, 3],
            // Right (x=1), normal +X
            [1, 2, 6],
            [1, 6, 5],
        ];
        SurfaceMesh { points, triangles }
    }

    #[test]
    fn tet_mesh_from_bowyer_watson() {
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
        let mesh = TetMesh::from_tets(pts, tets);

        // Should have multiple tets.
        let live = mesh.live_tets();
        assert!(!live.is_empty(), "should have tets");

        // All faces should be tracked.
        let face_count = mesh.all_faces().count();
        assert!(face_count > 0, "should have faces");
    }

    #[test]
    fn box_surface_all_faces_recovered() {
        let surface = box_surface_mesh();
        let pts: Vec<[f64; 3]> = surface.points.iter().map(|p| [p.x, p.y, p.z]).collect();
        let tets = bowyer_watson_3d(&pts);
        let mut mesh = TetMesh::from_tets(pts, tets);

        // Run constrained face recovery.
        let _steiner_count = recover_constraint_faces(&mut mesh, &surface, 100).unwrap();

        // All surface triangles should now be present as tet faces.
        for tri in &surface.triangles {
            let key = sorted3(*tri);
            assert!(
                mesh.has_face(key),
                "surface triangle {:?} missing from tet mesh",
                tri
            );
        }

        // No degenerate tets.
        for tet in mesh.live_tets() {
            let vol = tet_signed_volume(&mesh.pts, &tet);
            assert!(
                vol > 1e-15,
                "degenerate or inverted tet {:?} with vol {}",
                tet,
                vol
            );
        }
    }

    #[test]
    fn face_recovery_preserves_volume() {
        let surface = box_surface_mesh();
        let pts: Vec<[f64; 3]> = surface.points.iter().map(|p| [p.x, p.y, p.z]).collect();
        let tets = bowyer_watson_3d(&pts);
        let mut mesh = TetMesh::from_tets(pts, tets);

        // Volume before recovery.
        let vol_before: f64 = mesh
            .live_tets()
            .iter()
            .map(|t| tet_signed_volume(&mesh.pts, t).abs())
            .sum();

        recover_constraint_faces(&mut mesh, &surface, 100).unwrap();

        // Volume after recovery.
        let vol_after: f64 = mesh
            .live_tets()
            .iter()
            .map(|t| tet_signed_volume(&mesh.pts, t).abs())
            .sum();

        // Volume should be close (Steiner points don't change enclosed volume).
        assert!(
            (vol_before - vol_after).abs() < 0.01,
            "volume changed: before={}, after={}",
            vol_before,
            vol_after
        );
    }

    // ── Stage 5.4 tests ───────────────────────────────────────────────────────

    /// Sphere surface: after classification all remaining tet centroids must be
    /// strictly inside the unit sphere (radius < 1).
    ///
    /// For a convex icosphere the Delaunay tetrahedralization of the surface
    /// vertices naturally fills only the interior, so the classification may
    /// remove zero tets — but it must not remove any interior ones.
    #[test]
    fn classify_sphere_centroids_inside() {
        let surface = icosphere(1); // 80 triangles, 42 points
        let pts: Vec<[f64; 3]> = surface.points.iter().map(|p| [p.x, p.y, p.z]).collect();
        let tets = bowyer_watson_3d(&pts);
        let mut mesh = TetMesh::from_tets(pts, tets);
        recover_constraint_faces(&mut mesh, &surface, 500).unwrap();

        classify_interior_tets(&mut mesh, &surface);
        let after_tets = mesh.live_tets();

        assert!(!after_tets.is_empty(), "no interior tets remain after classification");

        for tet in &after_tets {
            let [cx, cy, cz] = tet_centroid(&mesh.pts, tet);
            let r = (cx * cx + cy * cy + cz * cz).sqrt();
            assert!(
                r < 1.0 + 1e-10,
                "centroid at radius {r:.6} lies outside unit sphere"
            );
        }
    }

    /// Box surface: after classification tet count is positive and no centroid
    /// falls outside [0, 1]³.
    #[test]
    fn classify_box_interior_tets() {
        let surface = box_surface_mesh();
        let pts: Vec<[f64; 3]> = surface.points.iter().map(|p| [p.x, p.y, p.z]).collect();
        let tets = bowyer_watson_3d(&pts);
        let mut mesh = TetMesh::from_tets(pts, tets);
        recover_constraint_faces(&mut mesh, &surface, 100).unwrap();

        classify_interior_tets(&mut mesh, &surface);

        let live = mesh.live_tets();
        assert!(!live.is_empty(), "no interior tets remain after classification");

        for tet in &live {
            let [cx, cy, cz] = tet_centroid(&mesh.pts, tet);
            assert!(
                cx > -1e-10 && cx < 1.0 + 1e-10,
                "centroid x={cx:.6} outside box"
            );
            assert!(
                cy > -1e-10 && cy < 1.0 + 1e-10,
                "centroid y={cy:.6} outside box"
            );
            assert!(
                cz > -1e-10 && cz < 1.0 + 1e-10,
                "centroid z={cz:.6} outside box"
            );
        }
    }

    /// Total volume of classified interior tets must be within 5 % of the
    /// analytical volume of the unit box (1.0 m³).
    #[test]
    fn classify_box_volume_within_5_percent() {
        let surface = box_surface_mesh();
        let pts: Vec<[f64; 3]> = surface.points.iter().map(|p| [p.x, p.y, p.z]).collect();
        let tets = bowyer_watson_3d(&pts);
        let mut mesh = TetMesh::from_tets(pts, tets);
        recover_constraint_faces(&mut mesh, &surface, 100).unwrap();

        classify_interior_tets(&mut mesh, &surface);

        let volume: f64 = mesh
            .live_tets()
            .iter()
            .map(|t| tet_signed_volume(&mesh.pts, t).abs())
            .sum();

        let analytical = 1.0_f64;
        let error = (volume - analytical).abs() / analytical;
        assert!(
            error < 0.05,
            "interior volume {volume:.6} deviates {:.1}% from analytical {analytical}",
            error * 100.0
        );
    }
}
