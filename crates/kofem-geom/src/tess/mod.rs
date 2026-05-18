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

use crate::geom::brep::{self, Face, Solid};
use crate::geom::curve::Circle;
use crate::geom::surface::{
    BSplineSurfaceWithKnots, ConicalSurface, CylindricalSurface, Plane, SphericalSurface,
    ToroidalSurface,
};
use crate::geom::{add, cross, normalize, scale, sub};

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
pub enum TessError {}

// ── Public API ─────────────────────────────────────────────────────────────────

/// Milestone 1: fan-triangulate a face using only its vertex positions.
///
/// No surface evaluation — just takes the outer-loop start vertices and fans
/// triangles from vertex 0.  Produces a faceted but always-valid mesh.
pub fn fan_tessellate(face: &Face) -> SurfaceMesh {
    let mesh = fan_raw(face);
    flip_winding_if(mesh, !face.outer_loop_orientation)
}

/// Raw fan triangulation without orientation correction.
fn fan_raw(face: &Face) -> SurfaceMesh {
    let points: Vec<[f64; 3]> = face.outer_loop.edges.iter().map(|e| e.start).collect();
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
pub fn tessellate(solid: &Solid, opts: TessOptions) -> Result<SurfaceMesh, TessError> {
    let mut all_points: Vec<[f64; 3]> = Vec::new();
    let mut all_triangles: Vec<[usize; 3]> = Vec::new();

    for shell in &solid.shells {
        for face in &shell.faces {
            let face_mesh = tessellate_face(face, opts.max_edge_len);
            let offset = all_points.len();
            all_points.extend_from_slice(&face_mesh.points);
            for &[a, b, c] in &face_mesh.triangles {
                all_triangles.push([a + offset, b + offset, c + offset]);
            }
        }
    }

    let bbox_diag = bounding_box_diagonal(&all_points);
    let eps = 1e-4 * bbox_diag.max(1e-10);
    Ok(stitch(all_points, all_triangles, eps))
}

// ── Face tessellation ──────────────────────────────────────────────────────────

fn tessellate_face(face: &Face, max_edge_len: f64) -> SurfaceMesh {
    let raw = tessellate_face_raw(face, max_edge_len);
    flip_winding_if(raw, !face.outer_loop_orientation)
}

fn tessellate_face_raw(face: &Face, max_edge_len: f64) -> SurfaceMesh {
    if let Some(mesh) = try_tessellate_cylindrical(face, max_edge_len) {
        return mesh;
    }
    if let Some(mesh) = try_tessellate_conical(face, max_edge_len) {
        return mesh;
    }
    if let Some(mesh) = try_tessellate_toroidal(face, max_edge_len) {
        return mesh;
    }
    if let Some(mesh) = try_tessellate_spherical(face, max_edge_len) {
        return mesh;
    }
    if let Some(mesh) = try_tessellate_bspline(face, max_edge_len) {
        return mesh;
    }
    if let Some(mesh) = try_tessellate_disc(face, max_edge_len) {
        return mesh;
    }

    let boundary = sample_boundary_3d(&face.outer_loop.edges, max_edge_len);

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
        .filter_map(|inner_wire| {
            let inner_3d = sample_boundary_3d(&inner_wire.edges, max_edge_len);
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

/// Tessellate a `CylindricalSurface` face directly in UV space (u = angle, v = height)
/// and lift back to 3D. Returns `None` when the surface is not cylindrical.
fn try_tessellate_cylindrical(face: &Face, max_edge_len: f64) -> Option<SurfaceMesh> {
    let cyl = face.surface.as_any().downcast_ref::<CylindricalSurface>()?;
    let radius = cyl.radius;
    let axis = &cyl.axis;
    let y = axis.y();

    let boundary_3d = sample_boundary_3d(&face.outer_loop.edges, max_edge_len);
    if boundary_3d.len() < 3 {
        return None;
    }

    // Full-revolution check: a closed-circle edge has start ≈ end (zero chord).
    let has_closed_circle = face.outer_loop.edges.iter().any(|edge| {
        let d = sub(edge.start, edge.end);
        d[0] * d[0] + d[1] * d[1] + d[2] * d[2] < 1e-16
    });

    // Determine the v (axial) range from boundary points.
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

    if has_closed_circle {
        let circumference = 2.0 * PI * radius;
        let n_u = ((circumference / max_edge_len).ceil() as usize).clamp(8, 256);
        let n_v = (((v_max - v_min).abs() / max_edge_len).ceil() as usize).max(1);

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
                triangles.push([a, b, d]);
                triangles.push([a, d, c]);
            }
        }

        Some(SurfaceMesh { points, triangles })
    } else {
        let raw_u: Vec<f64> = boundary_3d
            .iter()
            .map(|&p| {
                let d = sub(p, axis.origin);
                f64::atan2(dot3(d, y), dot3(d, axis.x))
            })
            .collect();
        let u_vals = unwrap_angles(raw_u);

        let u_min = u_vals.iter().cloned().fold(f64::INFINITY, f64::min);
        let u_max = u_vals.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

        if (u_max - u_min) < 1e-10 {
            return None;
        }

        let arc_u = (u_max - u_min) * radius;
        let arc_v = (v_max - v_min).abs();
        let n_u = ((arc_u / max_edge_len).ceil() as usize).clamp(2, 256);
        let n_v = ((arc_v / max_edge_len).ceil() as usize).clamp(1, 256);

        let mut points = Vec::with_capacity((n_u + 1) * (n_v + 1));
        for j in 0..=n_v {
            let v = v_min + (v_max - v_min) * j as f64 / n_v as f64;
            for i in 0..=n_u {
                let u = u_min + (u_max - u_min) * i as f64 / n_u as f64;
                points.push(face.surface.point(u, v));
            }
        }

        let n_cols = n_u + 1;
        let mut triangles = Vec::with_capacity(n_u * n_v * 2);
        for j in 0..n_v {
            for i in 0..n_u {
                let a = j * n_cols + i;
                let b = j * n_cols + (i + 1);
                let c = (j + 1) * n_cols + i;
                let d = (j + 1) * n_cols + (i + 1);
                triangles.push([a, b, d]);
                triangles.push([a, d, c]);
            }
        }

        Some(SurfaceMesh { points, triangles })
    }
}

/// Tessellate a `ConicalSurface` face directly in UV space.
/// Returns `None` when the surface is not conical.
fn try_tessellate_conical(face: &Face, max_edge_len: f64) -> Option<SurfaceMesh> {
    let cone = face.surface.as_any().downcast_ref::<ConicalSurface>()?;
    let radius = cone.radius;
    let semi_angle = cone.semi_angle;
    let axis = &cone.axis;
    let y = axis.y();

    let boundary_3d = sample_boundary_3d(&face.outer_loop.edges, max_edge_len);
    if boundary_3d.len() < 3 {
        return None;
    }

    // Full-revolution check.
    let has_closed_circle = face.outer_loop.edges.iter().any(|edge| {
        let d = sub(edge.start, edge.end);
        d[0] * d[0] + d[1] * d[1] + d[2] * d[2] < 1e-16
    });

    let cos_phi = semi_angle.cos();
    if cos_phi.abs() < 1e-10 {
        return None;
    }

    let mut v_min = f64::INFINITY;
    let mut v_max = f64::NEG_INFINITY;
    for &p in &boundary_3d {
        let d = sub(p, axis.origin);
        let v = dot3(d, axis.z) / cos_phi;
        v_min = v_min.min(v);
        v_max = v_max.max(v);
    }
    if (v_max - v_min).abs() < 1e-10 {
        return None;
    }

    let v_mid = (v_min + v_max) / 2.0;
    let r_mid = (radius + v_mid * semi_angle.sin()).abs();

    if has_closed_circle {
        let circumference = 2.0 * PI * r_mid;
        let n_u = ((circumference / max_edge_len).ceil() as usize).clamp(8, 256);
        let n_v = (((v_max - v_min).abs() / max_edge_len).ceil() as usize).max(1);

        let mut points = Vec::with_capacity(n_u * (n_v + 1));
        for j in 0..=n_v {
            let v = v_min + (v_max - v_min) * j as f64 / n_v as f64;
            for i in 0..n_u {
                let u = 2.0 * PI * i as f64 / n_u as f64;
                points.push(face.surface.point(u, v));
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
                triangles.push([a, b, d]);
                triangles.push([a, d, c]);
            }
        }

        Some(SurfaceMesh { points, triangles })
    } else {
        let raw_u: Vec<f64> = boundary_3d
            .iter()
            .map(|&p| {
                let d = sub(p, axis.origin);
                f64::atan2(dot3(d, y), dot3(d, axis.x))
            })
            .collect();
        let u_vals = unwrap_angles(raw_u);

        let u_min = u_vals.iter().cloned().fold(f64::INFINITY, f64::min);
        let u_max = u_vals.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

        if (u_max - u_min) < 1e-10 {
            return None;
        }

        let arc_u = (u_max - u_min) * r_mid;
        let arc_v = (v_max - v_min).abs();
        let n_u = ((arc_u / max_edge_len).ceil() as usize).clamp(2, 256);
        let n_v = ((arc_v / max_edge_len).ceil() as usize).clamp(1, 256);

        let mut points = Vec::with_capacity((n_u + 1) * (n_v + 1));
        for j in 0..=n_v {
            let v = v_min + (v_max - v_min) * j as f64 / n_v as f64;
            for i in 0..=n_u {
                let u = u_min + (u_max - u_min) * i as f64 / n_u as f64;
                points.push(face.surface.point(u, v));
            }
        }

        let n_cols = n_u + 1;
        let mut triangles = Vec::with_capacity(n_u * n_v * 2);
        for j in 0..n_v {
            for i in 0..n_u {
                let a = j * n_cols + i;
                let b = j * n_cols + (i + 1);
                let c = (j + 1) * n_cols + i;
                let d = (j + 1) * n_cols + (i + 1);
                triangles.push([a, b, d]);
                triangles.push([a, d, c]);
            }
        }

        Some(SurfaceMesh { points, triangles })
    }
}

/// Tessellate a `ToroidalSurface` face directly in UV space.
/// Returns `None` when the surface is not toroidal.
fn try_tessellate_toroidal(face: &Face, max_edge_len: f64) -> Option<SurfaceMesh> {
    let tor = face.surface.as_any().downcast_ref::<ToroidalSurface>()?;
    let major_radius = tor.major_radius;
    let minor_radius = tor.minor_radius;
    let axis = &tor.axis;
    let y = axis.y();

    let boundary_3d = sample_boundary_3d(&face.outer_loop.edges, max_edge_len);
    if boundary_3d.len() < 3 {
        return None;
    }

    let raw_uv: Vec<(f64, f64)> = boundary_3d
        .iter()
        .map(|&p| {
            let d = sub(p, axis.origin);
            let dx = dot3(d, axis.x);
            let dy = dot3(d, y);
            let dz = dot3(d, axis.z);
            let u = f64::atan2(dy, dx);
            let p_xy_len = (dx * dx + dy * dy).sqrt();
            let v = f64::atan2(dz, p_xy_len - major_radius);
            (u, v)
        })
        .collect();

    let u_vals = unwrap_angles(raw_uv.iter().map(|&(u, _)| u).collect());
    let v_vals = unwrap_angles(raw_uv.iter().map(|&(_, v)| v).collect());

    let u_min = u_vals.iter().cloned().fold(f64::INFINITY, f64::min);
    let u_max = u_vals.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let v_min = v_vals.iter().cloned().fold(f64::INFINITY, f64::min);
    let v_max = v_vals.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

    if (u_max - u_min) < 1e-10 || (v_max - v_min) < 1e-10 {
        return None;
    }

    let arc_u = (u_max - u_min) * (major_radius + minor_radius);
    let arc_v = (v_max - v_min) * minor_radius;
    let n_u = ((arc_u / max_edge_len).ceil() as usize).clamp(2, 256);
    let n_v = ((arc_v / max_edge_len).ceil() as usize).clamp(2, 256);

    let mut points = Vec::with_capacity((n_u + 1) * (n_v + 1));
    for j in 0..=n_v {
        let v = v_min + (v_max - v_min) * j as f64 / n_v as f64;
        for i in 0..=n_u {
            let u = u_min + (u_max - u_min) * i as f64 / n_u as f64;
            points.push(face.surface.point(u, v));
        }
    }

    let n_cols = n_u + 1;
    let mut triangles = Vec::with_capacity(n_u * n_v * 2);
    for j in 0..n_v {
        for i in 0..n_u {
            let a = j * n_cols + i;
            let b = j * n_cols + (i + 1);
            let c = (j + 1) * n_cols + i;
            let d = (j + 1) * n_cols + (i + 1);
            triangles.push([a, b, d]);
            triangles.push([a, d, c]);
        }
    }

    Some(SurfaceMesh { points, triangles })
}

/// Tessellate a `SphericalSurface` face directly in UV space.
/// Returns `None` when the surface is not spherical.
fn try_tessellate_spherical(face: &Face, max_edge_len: f64) -> Option<SurfaceMesh> {
    let sph = face.surface.as_any().downcast_ref::<SphericalSurface>()?;
    let radius = sph.radius;
    let axis = &sph.axis;
    let y = axis.y();

    let boundary_3d = sample_boundary_3d(&face.outer_loop.edges, max_edge_len);
    if boundary_3d.len() < 3 {
        return None;
    }

    let raw_uv: Vec<(f64, f64)> = boundary_3d
        .iter()
        .map(|&p| {
            let d = sub(p, axis.origin);
            let dx = dot3(d, axis.x);
            let dy = dot3(d, y);
            let dz = dot3(d, axis.z);
            let u = f64::atan2(dy, dx);
            let sin_v = (dz / radius).clamp(-1.0, 1.0);
            let v = sin_v.asin();
            (u, v)
        })
        .collect();

    let u_vals = unwrap_angles(raw_uv.iter().map(|&(u, _)| u).collect());
    let v_vals: Vec<f64> = raw_uv.iter().map(|&(_, v)| v).collect();

    let u_min = u_vals.iter().cloned().fold(f64::INFINITY, f64::min);
    let u_max = u_vals.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let v_min = v_vals.iter().cloned().fold(f64::INFINITY, f64::min);
    let v_max = v_vals.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

    if (u_max - u_min) < 1e-10 || (v_max - v_min) < 1e-10 {
        return None;
    }

    let v_mid = (v_min + v_max) / 2.0;
    let arc_u = radius * v_mid.cos().abs() * (u_max - u_min);
    let arc_v = radius * (v_max - v_min);

    let n_u = ((arc_u / max_edge_len).ceil() as usize).clamp(2, 256);
    let n_v = ((arc_v / max_edge_len).ceil() as usize).clamp(2, 256);

    let mut points = Vec::with_capacity((n_u + 1) * (n_v + 1));
    for j in 0..=n_v {
        let v = v_min + (v_max - v_min) * j as f64 / n_v as f64;
        for i in 0..=n_u {
            let u = u_min + (u_max - u_min) * i as f64 / n_u as f64;
            points.push(face.surface.point(u, v));
        }
    }

    let n_cols = n_u + 1;
    let mut triangles = Vec::with_capacity(n_u * n_v * 2);
    for j in 0..n_v {
        for i in 0..n_u {
            let a = j * n_cols + i;
            let b = j * n_cols + (i + 1);
            let c = (j + 1) * n_cols + i;
            let d = (j + 1) * n_cols + (i + 1);
            triangles.push([a, b, d]);
            triangles.push([a, d, c]);
        }
    }

    Some(SurfaceMesh { points, triangles })
}

/// Unwrap a sequence of angles to a contiguous range by minimising inter-sample jumps.
fn unwrap_angles(angles: Vec<f64>) -> Vec<f64> {
    if angles.is_empty() {
        return angles;
    }
    let mut out = Vec::with_capacity(angles.len());
    out.push(angles[0]);
    for &a in &angles[1..] {
        let prev = *out.last().unwrap();
        let mut delta = a - prev;
        delta -= (delta / (2.0 * PI)).round() * 2.0 * PI;
        out.push(prev + delta);
    }
    out
}

/// Tessellate a B-spline surface face by sampling its UV parameter domain uniformly.
/// Returns `None` when the surface is not a B-spline or its UV bounds are not finite.
fn try_tessellate_bspline(face: &Face, max_edge_len: f64) -> Option<SurfaceMesh> {
    face.surface
        .as_any()
        .downcast_ref::<BSplineSurfaceWithKnots>()?;

    let surface = face.surface.as_ref();
    let (u0, u1) = surface.u_bounds();
    let (v0, v1) = surface.v_bounds();
    if !u0.is_finite() || !u1.is_finite() || !v0.is_finite() || !v1.is_finite() {
        return None;
    }

    let u_mid = (u0 + u1) / 2.0;
    let v_mid = (v0 + v1) / 2.0;
    let arc_u = sample_arc_length(|t| surface.point(t, v_mid), u0, u1, 32);
    let arc_v = sample_arc_length(|t| surface.point(u_mid, t), v0, v1, 32);

    if arc_u < 1e-10 || arc_v < 1e-10 {
        return None;
    }

    let n_u = ((arc_u / max_edge_len).ceil() as usize).clamp(2, 256) + 1;
    let n_v = ((arc_v / max_edge_len).ceil() as usize).clamp(2, 256) + 1;

    let mut points = Vec::with_capacity(n_u * n_v);
    for j in 0..n_v {
        let v = v0 + (v1 - v0) * j as f64 / (n_v - 1) as f64;
        for i in 0..n_u {
            let u = u0 + (u1 - u0) * i as f64 / (n_u - 1) as f64;
            points.push(surface.point(u, v));
        }
    }

    let mut triangles = Vec::with_capacity((n_u - 1) * (n_v - 1) * 2);
    for j in 0..(n_v - 1) {
        for i in 0..(n_u - 1) {
            let a = j * n_u + i;
            let b = j * n_u + (i + 1);
            let c = (j + 1) * n_u + i;
            let d = (j + 1) * n_u + (i + 1);
            triangles.push([a, b, d]);
            triangles.push([a, d, c]);
        }
    }

    Some(SurfaceMesh { points, triangles })
}

/// Tessellate a flat circular disc (Plane surface with a single closed Circle
/// outer boundary) using a center-fan layout.
fn try_tessellate_disc(face: &Face, max_edge_len: f64) -> Option<SurfaceMesh> {
    face.surface.as_any().downcast_ref::<Plane>()?;

    if face.outer_loop.edges.len() != 1 {
        return None;
    }
    let edge = &face.outer_loop.edges[0];
    if dist3(edge.start, edge.end) >= 1e-10 {
        return None;
    }

    let circle = edge.curve.as_any().downcast_ref::<Circle>()?;
    let radius = circle.radius;
    let axis = &circle.axis;
    let y = axis.y();

    let n_u = ((2.0 * PI * radius / max_edge_len).ceil() as usize).clamp(8, 256);

    let mut points = Vec::with_capacity(n_u + 1);
    for i in 0..n_u {
        let t = 2.0 * PI * i as f64 / n_u as f64;
        let radial = add(scale(axis.x, t.cos()), scale(y, t.sin()));
        points.push(add(axis.origin, scale(radial, radius)));
    }

    points.push(axis.origin);
    let center = n_u;

    let mut triangles = Vec::with_capacity(n_u);
    for i in 0..n_u {
        triangles.push([center, i, (i + 1) % n_u]);
    }

    Some(SurfaceMesh { points, triangles })
}

/// Approximate arc length of a parametric curve `f(t)` over `[t0, t1]`.
fn sample_arc_length<F: Fn(f64) -> [f64; 3]>(f: F, t0: f64, t1: f64, n: usize) -> f64 {
    let mut len = 0.0_f64;
    let mut prev = f(t0);
    for i in 1..=n {
        let t = t0 + (t1 - t0) * i as f64 / n as f64;
        let curr = f(t);
        let d = sub(curr, prev);
        len += (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
        prev = curr;
    }
    len
}

// ── Boundary sampling ──────────────────────────────────────────────────────────

/// Collect all outer-loop edges into a single ordered 3D polygon by sampling
/// intermediate curve points between each edge's start and end vertices.
fn sample_boundary_3d(edges: &[brep::Edge], max_edge_len: f64) -> Vec<[f64; 3]> {
    let mut pts = Vec::with_capacity(edges.len() * 8);

    for edge in edges {
        pts.push(edge.start);

        let chord = dist3(edge.start, edge.end);
        // Closed curves have chord ≈ 0.  For Circle edges use circumference so
        // the boundary ring has the same n_u as the barrel from
        // try_tessellate_cylindrical, which makes stitch() merge the seam correctly.
        let n_intermediate = if chord < 1e-10 {
            if let Some(circle) = edge.curve.as_any().downcast_ref::<Circle>() {
                let n_u = ((2.0 * PI * circle.radius / max_edge_len).ceil() as usize).clamp(8, 256);
                n_u - 1
            } else {
                16
            }
        } else {
            ((chord / max_edge_len).ceil() as usize).clamp(4, 64)
        };

        let samples = sample_edge_curve(edge, n_intermediate);
        // samples[0] ≈ edge.start (already pushed); samples[last] ≈ edge.end
        // (will be the next edge's start), so skip both endpoints.
        if samples.len() > 2 {
            pts.extend_from_slice(&samples[1..samples.len() - 1]);
        }
    }

    pts
}

/// Sample `n_intermediate + 2` points along the edge's curve using the
/// pre-computed parameter interval `[edge.t0, edge.t1]`.
fn sample_edge_curve(edge: &brep::Edge, n_intermediate: usize) -> Vec<[f64; 3]> {
    let n = n_intermediate + 2;
    (0..n)
        .map(|i| {
            let t = edge.t0 + (edge.t1 - edge.t0) * (i as f64) / ((n - 1) as f64);
            edge.curve.point(t)
        })
        .collect()
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
fn project_to_2d(
    pts3d: &[[f64; 3]],
    normal: [f64; 3],
) -> (Vec<Point2>, [f64; 3], [f64; 3], [f64; 3]) {
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
    let eps2 = 1e-20_f64;
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
