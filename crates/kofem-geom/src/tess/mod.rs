//! Stage 4: face tessellator — watertight surface mesh from a B-rep.
//!
//! # Milestone order
//! 1. [`fan_tessellate`]  — vertex-only, no surface evaluation (implemented)
//! 2. `tessellate_plane` / `tessellate_cylinder` — UV triangulation (implemented)
//! 3. Stitching pass — merge near-duplicate vertices (implemented)

use std::f64::consts::PI;

use serde::Serialize;

use kofem_mesh::geom::{point_in_polygon, Point2};
use kofem_mesh::triangulate::triangulate;

use crate::geom::curve::curve_from_step;
use crate::geom::{
    add, axis2_placement, cross, get_entity, get_real, get_ref, normalize, point3, scale, sub,
    GeomError,
};
use crate::step::parser::StepFile;
use crate::step::topology::{BRep, TopoEdge, TopoFace};

// ── Public types ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct SurfaceMesh {
    pub points: Vec<[f64; 3]>,
    pub triangles: Vec<[usize; 3]>,
}

pub struct TessOptions {
    /// Maximum edge length in model units (controls sampling density).
    pub max_edge_len: f64,
    /// Minimum angle passed to Ruppert refinement.
    pub min_angle_deg: f64,
}

impl Default for TessOptions {
    fn default() -> Self {
        Self {
            max_edge_len: 1.0,
            min_angle_deg: 20.0,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum TessError {
    #[error("geometry error on surface #{0}: {1}")]
    Geom(u64, #[source] GeomError),
}

// ── Public API ─────────────────────────────────────────────────────────────────

/// Milestone 1: fan-triangulate a face using only its vertex positions.
///
/// No surface evaluation — just takes the outer-loop start vertices and fans
/// triangles from vertex 0.  Produces a faceted but always-valid mesh.
pub fn fan_tessellate(face: &TopoFace) -> SurfaceMesh {
    let mesh = fan_raw(face);
    flip_winding_if(mesh, !face.outer_loop_orientation)
}

/// Raw fan triangulation without orientation correction.
fn fan_raw(face: &TopoFace) -> SurfaceMesh {
    let points: Vec<[f64; 3]> = face.outer_loop.iter().map(|e| e.start).collect();
    let n = points.len();
    if n < 3 {
        return SurfaceMesh {
            points,
            triangles: Vec::new(),
        };
    }
    let triangles = (1..n - 1).map(|i| [0, i, i + 1]).collect();
    SurfaceMesh { points, triangles }
}

/// Flip `[a,b,c]` → `[a,c,b]` on every triangle when `flip` is true.
fn flip_winding_if(mut mesh: SurfaceMesh, flip: bool) -> SurfaceMesh {
    if flip {
        for tri in &mut mesh.triangles {
            tri.swap(1, 2);
        }
    }
    mesh
}

/// Tessellate the complete B-rep into a single (approximately) watertight mesh.
///
/// Each face is triangulated by:
/// 1. Sampling its boundary edges into 3D polygons.
/// 2. Projecting to a local 2D tangent plane.
/// 3. Running Bowyer-Watson Delaunay triangulation.
/// 4. Lifting back to 3D via the local basis.
///
/// After all faces, near-duplicate vertices are merged (ε = 1e-4 × bbox diagonal).
pub fn tessellate(
    brep: &BRep,
    file: &StepFile,
    opts: TessOptions,
) -> Result<SurfaceMesh, TessError> {
    let mut all_points: Vec<[f64; 3]> = Vec::new();
    let mut all_triangles: Vec<[usize; 3]> = Vec::new();

    for face in &brep.faces {
        let face_mesh = tessellate_face(face, file, opts.max_edge_len);
        let offset = all_points.len();
        all_points.extend_from_slice(&face_mesh.points);
        for &[a, b, c] in &face_mesh.triangles {
            all_triangles.push([a + offset, b + offset, c + offset]);
        }
    }

    let bbox_diag = bounding_box_diagonal(&all_points);
    let eps = 1e-4 * bbox_diag.max(1e-10);
    Ok(stitch(all_points, all_triangles, eps))
}

// ── Face tessellation ──────────────────────────────────────────────────────────

fn tessellate_face(face: &TopoFace, file: &StepFile, max_edge_len: f64) -> SurfaceMesh {
    let raw = tessellate_face_raw(face, file, max_edge_len);
    flip_winding_if(raw, !face.outer_loop_orientation)
}

fn tessellate_face_raw(face: &TopoFace, file: &StepFile, max_edge_len: f64) -> SurfaceMesh {
    if let Some(mesh) = try_tessellate_cylindrical(face, file, max_edge_len) {
        return mesh;
    }

    let boundary = sample_boundary_3d(&face.outer_loop, file, max_edge_len);

    if boundary.len() < 3 {
        return fan_raw(face);
    }

    let normal = match face_normal(&boundary) {
        Some(n) => n,
        None => return fan_raw(face),
    };

    let (pts2d, origin, x_axis, y_axis) = project_to_2d(&boundary, normal);

    let pts2d = deduplicate_2d(pts2d);
    if pts2d.len() < 3 {
        return fan_raw(face);
    }

    let pts2d = ensure_ccw(pts2d);

    // Guard: polygon must have non-negligible area.
    if polygon_area_2d(&pts2d).abs() < 1e-20 {
        return fan_raw(face);
    }

    // Project each inner loop (hole) onto the same 2D plane.
    let holes2d: Vec<Vec<Point2>> = face
        .inner_loops
        .iter()
        .filter_map(|inner_edges| {
            let inner_3d = sample_boundary_3d(inner_edges, file, max_edge_len);
            if inner_3d.len() < 3 {
                return None;
            }
            Some(
                inner_3d
                    .iter()
                    .map(|&p| {
                        let d = sub(p, origin);
                        Point2::new(dot3(d, x_axis), dot3(d, y_axis))
                    })
                    .collect(),
            )
        })
        .collect();

    let mut mesh2d = triangulate(&pts2d);

    // Reject triangles whose centroid falls inside a hole polygon.
    if !holes2d.is_empty() {
        let pts = mesh2d.points.clone();
        mesh2d.triangles.retain(|t| {
            let c = t.centroid(&pts);
            !holes2d.iter().any(|hole| point_in_polygon(c, hole))
        });
    }

    let points: Vec<[f64; 3]> = mesh2d
        .points
        .iter()
        .map(|p| add(origin, add(scale(x_axis, p.x), scale(y_axis, p.y))))
        .collect();

    let triangles: Vec<[usize; 3]> = mesh2d.triangles.iter().map(|t| t.v).collect();

    SurfaceMesh { points, triangles }
}

// ── Curved-surface tessellation ───────────────────────────────────────────────

/// Tessellate a `CYLINDRICAL_SURFACE` face directly in UV space (u = angle, v = height)
/// and lift back to 3D. Returns `None` when the surface is not cylindrical.
///
/// The flat 2D-projection path in `tessellate_face_raw` fails for cylinder barrels
/// because the boundary (two circles + two seam lines) projects to a degenerate 2D
/// polygon: both circles overlap in XY and the seam lines collapse to a single point,
/// losing all height information.
fn try_tessellate_cylindrical(
    face: &TopoFace,
    file: &StepFile,
    max_edge_len: f64,
) -> Option<SurfaceMesh> {
    let e = file.get(&face.surface_id)?;
    if e.type_name != "CYLINDRICAL_SURFACE" {
        return None;
    }

    let ax_id = get_ref(e, 1).ok()?;
    let radius = get_real(e, 2).ok()?;
    let axis = axis2_placement(file, ax_id).ok()?;

    // Sample the boundary to determine the height (v) range.
    let boundary_3d = sample_boundary_3d(&face.outer_loop, file, max_edge_len);
    let mut v_min = f64::INFINITY;
    let mut v_max = f64::NEG_INFINITY;
    for &p in &boundary_3d {
        let d = sub(p, axis.origin);
        let v = dot3(d, axis.z);
        v_min = v_min.min(v);
        v_max = v_max.max(v);
    }
    if (v_max - v_min).abs() < 1e-10 {
        return None;
    }

    let circumference = 2.0 * PI * radius;
    let n_u = ((circumference / max_edge_len).ceil() as usize).clamp(8, 256);
    let n_v = (((v_max - v_min).abs() / max_edge_len).ceil() as usize).max(1);

    let y = axis.y();
    let mut points = Vec::with_capacity(n_u * (n_v + 1));
    for j in 0..=n_v {
        let v = v_min + (v_max - v_min) * j as f64 / n_v as f64;
        for i in 0..n_u {
            let u = 2.0 * PI * i as f64 / n_u as f64;
            let radial = add(scale(axis.x, u.cos()), scale(y, u.sin()));
            points.push(add(
                axis.origin,
                add(scale(radial, radius), scale(axis.z, v)),
            ));
        }
    }

    let mut triangles = Vec::with_capacity(n_u * n_v * 2);
    for j in 0..n_v {
        for i in 0..n_u {
            let ni = (i + 1) % n_u;
            let a = j * n_u + i;
            let b = j * n_u + ni;
            let c = (j + 1) * n_u + i;
            let d = (j + 1) * n_u + ni;
            // CCW winding when viewed from outside (outward-radial normal).
            triangles.push([a, b, d]);
            triangles.push([a, d, c]);
        }
    }

    Some(SurfaceMesh { points, triangles })
}

// ── Boundary sampling ──────────────────────────────────────────────────────────

/// Collect all outer-loop edges into a single ordered 3D polygon by sampling
/// intermediate curve points between each edge's start and end vertices.
///
/// `max_edge_len` controls density: edges are subdivided so segments stay ≤
/// `max_edge_len`.  Closed curves (start ≈ end) fall back to 16 samples.
fn sample_boundary_3d(edges: &[TopoEdge], file: &StepFile, max_edge_len: f64) -> Vec<[f64; 3]> {
    let mut pts = Vec::with_capacity(edges.len() * 8);

    for edge in edges {
        pts.push(edge.start);

        let chord = dist3(edge.start, edge.end);
        // Closed curves have chord ≈ 0; use a fixed minimum for full circles.
        let n_intermediate = if chord < 1e-10 {
            16usize
        } else {
            (chord / max_edge_len).ceil() as usize
        }
        .clamp(4, 64);

        let samples = sample_curve(
            file,
            edge.curve_id,
            edge.start,
            edge.end,
            edge.reversed,
            n_intermediate,
        );
        // samples[0] ≈ edge.start (already pushed); samples[last] ≈ edge.end
        // (will be the next edge's start), so skip both endpoints.
        if samples.len() > 2 {
            pts.extend_from_slice(&samples[1..samples.len() - 1]);
        }
    }

    pts
}

/// Sample `n_intermediate + 2` points along a curve from `start` to `end`
/// (including both endpoints).  Falls back to linear interpolation when the
/// curve cannot be loaded.
fn sample_curve(
    file: &StepFile,
    curve_id: u64,
    start: [f64; 3],
    end: [f64; 3],
    reversed: bool,
    n_intermediate: usize,
) -> Vec<[f64; 3]> {
    let n = n_intermediate + 2;

    let (t0, t1) = curve_t_range(file, curve_id, start, end, reversed);

    if let Ok(curve) = curve_from_step(curve_id, file) {
        return (0..n)
            .map(|i| {
                let t = t0 + (t1 - t0) * (i as f64) / ((n - 1) as f64);
                curve.point(t)
            })
            .collect();
    }

    // Fallback: chord interpolation.
    (0..n)
        .map(|i| {
            let s = i as f64 / ((n - 1) as f64);
            lerp3(start, end, s)
        })
        .collect()
}

// ── Curve parameter inversion ──────────────────────────────────────────────────

/// Return the parameter interval [t0, t1] that traces the curve from `start`
/// to `end`, accounting for the `reversed` flag.
fn curve_t_range(
    file: &StepFile,
    curve_id: u64,
    start: [f64; 3],
    end: [f64; 3],
    reversed: bool,
) -> (f64, f64) {
    let entity = match file.get(&curve_id) {
        Some(e) => e,
        None => return (0.0, 1.0),
    };

    match entity.type_name.as_str() {
        "LINE" => {
            // LINE(label, point_ref, vector_ref)
            // t = dot(P - origin, direction)
            if let (Ok(pt_id), Ok(vec_id)) = (get_ref(entity, 1), get_ref(entity, 2)) {
                if let (Ok(origin), Ok(dir)) = (point3(file, pt_id), line_direction(file, vec_id)) {
                    let t0 = dot3(sub(start, origin), dir);
                    let t1 = dot3(sub(end, origin), dir);
                    return (t0, t1);
                }
            }
            (0.0, 1.0)
        }

        "CIRCLE" => {
            // CIRCLE(label, axis2_placement_ref, radius)
            // t = atan2(dot(P-origin, y_axis), dot(P-origin, x_axis))
            if let Ok(ax_id) = get_ref(entity, 1) {
                if let Ok(axis) = axis2_placement(file, ax_id) {
                    let y = axis.y();

                    let angle_of = |p: [f64; 3]| -> f64 {
                        let d = sub(p, axis.origin);
                        f64::atan2(dot3(d, y), dot3(d, axis.x))
                    };

                    let t_start = angle_of(start);
                    let t_end_raw = angle_of(end);

                    // Full circle when endpoints coincide.
                    if dist3(start, end) < 1e-8 {
                        let span = if reversed { -2.0 * PI } else { 2.0 * PI };
                        return (t_start, t_start + span);
                    }

                    let t_end = if reversed {
                        // CW traversal: t must decrease from t_start to t_end.
                        let delta = ((t_start - t_end_raw).rem_euclid(2.0 * PI)).max(1e-10);
                        t_start - delta
                    } else {
                        // CCW traversal: t must increase from t_start to t_end.
                        let delta = ((t_end_raw - t_start).rem_euclid(2.0 * PI)).max(1e-10);
                        t_start + delta
                    };

                    return (t_start, t_end);
                }
            }
            (0.0, 2.0 * PI)
        }

        _ => {
            // B-spline and others: use the curve's own t_bounds.
            if let Ok(curve) = curve_from_step(curve_id, file) {
                let (t0, t1) = curve.t_bounds();
                if t0.is_finite() && t1.is_finite() {
                    return if reversed { (t1, t0) } else { (t0, t1) };
                }
            }
            (0.0, 1.0)
        }
    }
}

/// Normalised direction vector for a VECTOR entity (used in LINE inversion).
fn line_direction(file: &StepFile, vec_id: u64) -> Result<[f64; 3], GeomError> {
    // VECTOR(label, direction_ref, magnitude)
    let vec_e = get_entity(file, vec_id)?;
    let dir_id = get_ref(vec_e, 1)?;
    Ok(normalize(point3(file, dir_id)?))
}

// ── 2D projection helpers ──────────────────────────────────────────────────────

/// Newell's method: compute a robust face normal from an ordered polygon.
fn face_normal(pts: &[[f64; 3]]) -> Option<[f64; 3]> {
    let n = pts.len();
    let mut nx = 0.0_f64;
    let mut ny = 0.0_f64;
    let mut nz = 0.0_f64;
    for i in 0..n {
        let p = pts[i];
        let q = pts[(i + 1) % n];
        nx += (p[1] - q[1]) * (p[2] + q[2]);
        ny += (p[2] - q[2]) * (p[0] + q[0]);
        nz += (p[0] - q[0]) * (p[1] + q[1]);
    }
    let len = (nx * nx + ny * ny + nz * nz).sqrt();
    if len < 1e-15 {
        return None;
    }
    Some([nx / len, ny / len, nz / len])
}

/// Project `pts3d` onto a tangent plane defined by `normal`.
///
/// Returns `(2D points, origin, x_axis, y_axis)` so callers can lift back.
fn project_to_2d(
    pts3d: &[[f64; 3]],
    normal: [f64; 3],
) -> (Vec<Point2>, [f64; 3], [f64; 3], [f64; 3]) {
    // Build an orthonormal frame from normal.
    let ref_vec: [f64; 3] = if normal[0].abs() < 0.9 {
        [1.0, 0.0, 0.0]
    } else {
        [0.0, 1.0, 0.0]
    };
    let x_axis = normalize(cross(ref_vec, normal));
    let y_axis = normalize(cross(normal, x_axis));

    let origin = pts3d[0];
    let pts2d = pts3d
        .iter()
        .map(|&p| {
            let d = sub(p, origin);
            Point2::new(dot3(d, x_axis), dot3(d, y_axis))
        })
        .collect();

    (pts2d, origin, x_axis, y_axis)
}

/// Remove 2D points that are within a fixed tolerance of an earlier point.
fn deduplicate_2d(pts: Vec<Point2>) -> Vec<Point2> {
    let eps2 = 1e-20_f64; // squared distance threshold
    let mut out: Vec<Point2> = Vec::with_capacity(pts.len());
    for p in pts {
        let dup = out.iter().any(|q| {
            let dx = q.x - p.x;
            let dy = q.y - p.y;
            dx * dx + dy * dy < eps2
        });
        if !dup {
            out.push(p);
        }
    }
    out
}

/// Reverse the polygon if it is wound clockwise so that `triangulate` sees CCW.
fn ensure_ccw(pts: Vec<Point2>) -> Vec<Point2> {
    if polygon_area_2d(&pts) < 0.0 {
        let mut pts = pts;
        pts.reverse();
        pts
    } else {
        pts
    }
}

/// Signed area of a 2D polygon (positive ⟺ CCW).
fn polygon_area_2d(pts: &[Point2]) -> f64 {
    let n = pts.len();
    let mut area = 0.0_f64;
    for i in 0..n {
        let j = (i + 1) % n;
        area += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
    }
    area / 2.0
}

// ── Stitching ──────────────────────────────────────────────────────────────────

fn bounding_box_diagonal(pts: &[[f64; 3]]) -> f64 {
    if pts.is_empty() {
        return 1.0;
    }
    let mut min = pts[0];
    let mut max = pts[0];
    for &p in pts.iter().skip(1) {
        for k in 0..3 {
            if p[k] < min[k] {
                min[k] = p[k];
            }
            if p[k] > max[k] {
                max[k] = p[k];
            }
        }
    }
    let d = sub(max, min);
    (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt()
}

/// Merge 3D vertices within `eps` of each other and remove degenerate triangles.
fn stitch(points: Vec<[f64; 3]>, triangles: Vec<[usize; 3]>, eps: f64) -> SurfaceMesh {
    let eps2 = eps * eps;
    let n = points.len();
    let mut remap = vec![0usize; n];
    let mut unique: Vec<[f64; 3]> = Vec::new();

    for (i, &p) in points.iter().enumerate() {
        let found = unique.iter().enumerate().find(|(_, &q)| {
            let d = sub(p, q);
            d[0] * d[0] + d[1] * d[1] + d[2] * d[2] <= eps2
        });
        match found {
            Some((j, _)) => remap[i] = j,
            None => {
                remap[i] = unique.len();
                unique.push(p);
            }
        }
    }

    let tris: Vec<[usize; 3]> = triangles
        .iter()
        .map(|&[a, b, c]| [remap[a], remap[b], remap[c]])
        .filter(|&[a, b, c]| a != b && b != c && a != c)
        .collect();

    SurfaceMesh {
        points: unique,
        triangles: tris,
    }
}

// ── Math helpers ───────────────────────────────────────────────────────────────

fn dot3(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn dist3(a: [f64; 3], b: [f64; 3]) -> f64 {
    let d = sub(a, b);
    (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt()
}

fn lerp3(a: [f64; 3], b: [f64; 3], t: f64) -> [f64; 3] {
    add(a, scale(sub(b, a), t))
}
