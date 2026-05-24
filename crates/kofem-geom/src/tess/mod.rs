//! Stage 4: face tessellator — watertight surface mesh from a B-rep.
//!
//! # Milestone order
//! 1. [`fan_tessellate`]  — vertex-only, no surface evaluation (implemented)
//! 2. `tessellate_plane` / `tessellate_cylinder` — UV triangulation (implemented)
//! 3. Stitching pass — merge near-duplicate vertices (implemented)

use std::collections::HashMap;
use std::f64::consts::PI;

/// Build a map from 2D point bits `(x.to_bits(), y.to_bits())` → original 3D position.
/// Used by CDT-based tessellators to recover exact edge-cache 3D positions for boundary
/// vertices after CDT works in the projected 2D tangent plane.
fn build_bnd2d_map(pts2d: &[Point2], pts3d: &[[f64; 3]]) -> HashMap<(u64, u64), [f64; 3]> {
    pts2d
        .iter()
        .zip(pts3d.iter())
        .map(|(p2d, &p3d)| ((p2d.x.to_bits(), p2d.y.to_bits()), p3d))
        .collect()
}

use serde::Serialize;

use kofem_mesh::cdt::{try_triangulate_constrained, try_triangulate_with_interior, CdtError};
use kofem_mesh::geom::{orient2d, point_in_polygon, Point2};

use crate::geom::curve::curve_from_step;
use crate::geom::surface::surface_from_step;
use crate::geom::{
    add, axis2_placement, cross, get_entity, get_real, get_ref, normalize, point3, scale, sub,
    GeomError,
};
use crate::step::parser::{Arg, StepFile};
use crate::step::topology::{BRep, TopoEdge, TopoFace};

// ── Public types ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct SurfaceMesh {
    pub points: Vec<[f64; 3]>,
    pub triangles: Vec<[usize; 3]>,
}

pub struct TessOptions {
    /// Maximum edge length in model units — controls straight-edge and non-circular
    /// surface grid density. For circular arcs, `chord_height_tol` takes precedence.
    pub max_edge_len: f64,
    /// Sagitta (chord-height) tolerance for circular arcs in model units.
    /// The deviation between a chord and the true arc is kept ≤ this value.
    /// Typical CAD default: 0.2 mm.  Set to 0.0 to disable (fall back to `max_edge_len`).
    pub chord_height_tol: f64,
    /// Minimum angle passed to Ruppert refinement.
    pub min_angle_deg: f64,
}

impl Default for TessOptions {
    fn default() -> Self {
        Self {
            max_edge_len: 1.0,
            chord_height_tol: 0.2,
            min_angle_deg: 20.0,
        }
    }
}

/// Number of segments needed to tessellate a circular arc of `radius` spanning `angle`
/// radians such that the sagitta (chord-height) does not exceed `opts.chord_height_tol`.
///
/// Falls back to the arc-length criterion when `chord_height_tol` is zero or when
/// the radius is at or below the tolerance.
fn n_segs_for_arc(radius: f64, angle: f64, opts: &TessOptions) -> usize {
    if radius <= 0.0 || angle <= 0.0 {
        return 2;
    }
    let tol = opts.chord_height_tol;
    if tol <= 0.0 || tol >= radius {
        // Chord-height disabled or degenerate tiny circle: arc-length fallback.
        let arc_len = radius * angle;
        return ((arc_len / opts.max_edge_len).ceil() as usize).max(2);
    }
    // h = R(1 − cos(θ/2)) ≤ tol  →  θ/2 ≤ acos(1 − tol/R)  →  n ≥ angle / (2·acos(1 − tol/R))
    let half_max = (1.0 - tol / radius).clamp(-1.0, 1.0).acos();
    if half_max < 1e-12 {
        return 512;
    }
    ((angle / (2.0 * half_max)).ceil() as usize).max(2)
}

#[derive(Debug, thiserror::Error)]
pub enum TessError {
    #[error("geometry error on surface #{0}: {1}")]
    Geom(u64, #[source] GeomError),

    /// The outer boundary of a face has too few usable vertices to triangulate.
    #[error("surface #{surface_id} ({surface_type}): degenerate face — {reason}")]
    DegenerateFace {
        surface_id: u64,
        surface_type: String,
        reason: &'static str,
    },

    /// The constrained Delaunay triangulation failed because two projected
    /// constraint edges cross each other.  Indicates that the 2-D projection
    /// of the boundary (or a hole) is self-intersecting.
    #[error(
        "surface #{surface_id} ({surface_type}): CDT failed — projected constraint edges \
         ({ea0},{ea1}) and ({eb0},{eb1}) intersect in the 2-D plane"
    )]
    ConstraintIntersection {
        surface_id: u64,
        surface_type: String,
        ea0: usize,
        ea1: usize,
        eb0: usize,
        eb1: usize,
    },
}

// ── Edge cache ─────────────────────────────────────────────────────────────────

/// Maps each EDGE_CURVE entity id to its pre-computed vertex sequence in
/// the EDGE_CURVE's canonical (non-reversed) direction, including both endpoints.
///
/// Two adjacent faces that reference the same EDGE_CURVE receive the identical
/// `Vec<[f64;3]>` pointer (just reversed when traversal direction differs), so
/// their shared boundary positions are bitwise equal — no stitching heuristic
/// can fail to merge them.
type EdgeCache = HashMap<u64, Vec<[f64; 3]>>;

/// Pre-compute boundary vertices for every unique EDGE_CURVE in the B-rep.
fn build_edge_cache(brep: &BRep, file: &StepFile, opts: &TessOptions) -> EdgeCache {
    let mut cache = EdgeCache::new();
    for face in &brep.faces {
        for loop_edges in std::iter::once(face.outer_loop.as_slice())
            .chain(face.inner_loops.iter().map(Vec::as_slice))
        {
            for edge in loop_edges {
                cache.entry(edge.edge_id).or_insert_with(|| {
                    // Canonical = EDGE_CURVE natural direction (reversed == false).
                    // When this occurrence is reversed, swap start/end before sampling.
                    let (canonical_start, canonical_end) = if edge.reversed {
                        (edge.end, edge.start)
                    } else {
                        (edge.start, edge.end)
                    };
                    // curve_reversed: the curve parameter runs opposite to vertex order
                    // when EDGE_CURVE.same_sense = .F.
                    let curve_reversed = !edge.curve_same_sense;
                    discretise_edge(
                        file,
                        edge.curve_id,
                        canonical_start,
                        canonical_end,
                        curve_reversed,
                        opts,
                    )
                });
            }
        }
    }
    cache
}

/// Sample all vertices of one edge in [start → end] direction (including endpoints).
///
/// `curve_reversed`: when true the curve parameter runs opposite to the start→end
/// direction (EDGE_CURVE.same_sense = .F.).
fn discretise_edge(
    file: &StepFile,
    curve_id: u64,
    start: [f64; 3],
    end: [f64; 3],
    curve_reversed: bool,
    opts: &TessOptions,
) -> Vec<[f64; 3]> {
    let chord = dist3(start, end);
    let n_intermediate = if chord < 1e-10 {
        // Closed curve — treat as full circle: use chord-height criterion.
        if let Some(r) = circle_radius_from_curve(file, curve_id) {
            let n_u = n_segs_for_arc(r, 2.0 * PI, opts).clamp(8, 512);
            n_u - 1
        } else {
            16
        }
    } else if let Some(arc_len) = circle_arc_length(file, curve_id, start, end, curve_reversed) {
        // Circular arc: prefer chord-height over arc-length.
        let r = circle_radius_from_curve(file, curve_id).unwrap_or(1.0);
        let angle = arc_len / r;
        let n_u = n_segs_for_arc(r, angle, opts).clamp(2, 512);
        n_u.saturating_sub(1).max(1)
    } else {
        // Non-circular edges: estimate actual arc length for density.
        // Using chord (straight-line distance) underestimates curved B-splines,
        // producing too few points → sparse boundary → tessellation failures.
        let arc_len = {
            let curve_ok = curve_from_step(curve_id, file);
            if let Ok(curve) = curve_ok {
                let (t0, t1) = curve_t_range(file, curve_id, start, end, curve_reversed);
                sample_arc_length(|t| curve.point(t), t0, t1, 16)
            } else {
                chord
            }
        };
        ((arc_len / opts.max_edge_len).ceil() as usize).saturating_sub(1)
    };
    sample_curve(file, curve_id, start, end, curve_reversed, n_intermediate)
}

/// Assemble a closed boundary polygon from pre-computed edge vertices.
///
/// For each edge: pushes the traversal-order start vertex and all intermediate
/// vertices (not the endpoint, which becomes the next edge's start).
/// Adjacent faces that share an edge receive bitwise-identical vertices here,
/// so `stitch()` merges them at zero distance rather than relying on an epsilon.
fn sample_boundary_cached(edges: &[TopoEdge], cache: &EdgeCache) -> Vec<[f64; 3]> {
    let mut pts = Vec::new();
    for edge in edges {
        let Some(canonical) = cache.get(&edge.edge_id) else {
            pts.push(edge.start);
            continue;
        };
        if canonical.len() < 2 {
            pts.push(edge.start);
            continue;
        }
        if edge.reversed {
            // Canonical direction: canonical_start → canonical_end.
            // Traversal direction: canonical_end → canonical_start.
            // canonical.last() == canonical_end == edge.start for non-closed edges.
            pts.push(*canonical.last().unwrap());
            for &p in canonical[1..canonical.len() - 1].iter().rev() {
                pts.push(p);
            }
        } else {
            pts.push(canonical[0]);
            for &p in &canonical[1..canonical.len() - 1] {
                pts.push(p);
            }
        }
    }
    pts
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
    // Phase 1: discretise every unique edge once.
    // All adjacent faces will pull from this cache, guaranteeing identical positions
    // on shared boundaries without relying on approximate epsilon-merging.
    let edge_cache = build_edge_cache(brep, file, &opts);

    // Phase 2: tessellate each face using the pre-computed boundary vertices.
    let mut all_points: Vec<[f64; 3]> = Vec::new();
    let mut all_triangles: Vec<[usize; 3]> = Vec::new();

    for face in &brep.faces {
        let face_mesh = tessellate_face(face, &edge_cache, file, &opts)?;
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

fn tessellate_face(
    face: &TopoFace,
    edge_cache: &EdgeCache,
    file: &StepFile,
    opts: &TessOptions,
) -> Result<SurfaceMesh, TessError> {
    let raw = tessellate_face_raw(face, edge_cache, file, opts)?;
    // UV-grid surfaces (cylinder, cone, torus, sphere, B-spline, linear extrusion)
    // generate CCW triangles aligned with ∂P/∂u × ∂P/∂v, so the flip follows same_sense.
    // All other surfaces (PLANE, SURFACE_OF_REVOLUTION, unknown/missing) are tessellated
    // from the boundary polygon (CDT or fan), so the flip follows outer_loop_orientation.
    let is_uv_surface = file
        .get(&face.surface_id)
        .map(|e| {
            matches!(
                e.type_name.as_str(),
                "CYLINDRICAL_SURFACE"
                    | "CONICAL_SURFACE"
                    | "TOROIDAL_SURFACE"
                    | "SPHERICAL_SURFACE"
                    | "B_SPLINE_SURFACE_WITH_KNOTS"
                    | "SURFACE_OF_LINEAR_EXTRUSION"
            ) || (e.type_name.is_empty()
                && e.args.iter().any(|a| {
                    matches!(a, Arg::TypedValue { name, .. } if name == "B_SPLINE_SURFACE_WITH_KNOTS")
                }))
        })
        .unwrap_or(false);
    let flip = if is_uv_surface {
        !face.same_sense
    } else {
        !face.outer_loop_orientation
    };
    Ok(flip_winding_if(raw, flip))
}

fn tessellate_face_raw(
    face: &TopoFace,
    edge_cache: &EdgeCache,
    file: &StepFile,
    opts: &TessOptions,
) -> Result<SurfaceMesh, TessError> {
    let sid = face.surface_id;
    let stype = file
        .get(&sid)
        .map(|e| e.type_name.as_str())
        .unwrap_or("UNKNOWN")
        .to_owned();

    // PLANE faces use the entity's exact axes to avoid numerical precision issues
    // that arise when estimating the projection basis from boundary points.
    if let Some(result) = try_tessellate_plane(face, edge_cache, file, opts) {
        return result;
    }
    if let Some(mesh) = try_tessellate_cylindrical(face, edge_cache, file, opts) {
        return Ok(mesh);
    }
    if let Some(mesh) = try_tessellate_conical(face, edge_cache, file, opts) {
        return Ok(mesh);
    }
    if let Some(mesh) = try_tessellate_toroidal(face, edge_cache, file, opts) {
        return Ok(mesh);
    }
    if let Some(mesh) = try_tessellate_spherical(face, edge_cache, file, opts) {
        return Ok(mesh);
    }
    if let Some(mesh) = try_tessellate_bspline(face, edge_cache, file, opts) {
        return Ok(mesh);
    }
    if let Some(mesh) = try_tessellate_linear_extrusion(face, edge_cache, file, opts) {
        return Ok(mesh);
    }
    if let Some(mesh) = try_tessellate_annular_disc(face, edge_cache, file, opts) {
        return Ok(mesh);
    }
    if let Some(mesh) = try_tessellate_disc(face, edge_cache, file, opts) {
        return Ok(mesh);
    }

    let boundary = sample_boundary_cached(&face.outer_loop, edge_cache);

    if boundary.len() < 3 {
        return Err(TessError::DegenerateFace {
            surface_id: sid,
            surface_type: stype,
            reason: "boundary has fewer than 3 usable vertices",
        });
    }

    let normal = match face_normal(&boundary) {
        Some(n) => n,
        None => {
            return Err(TessError::DegenerateFace {
                surface_id: sid,
                surface_type: stype,
                reason: "face normal could not be computed (collinear or degenerate boundary)",
            })
        }
    };

    let (pts2d, origin, x_axis, y_axis) = project_to_2d(&boundary, normal);

    let pts2d = deduplicate_2d(pts2d);
    if pts2d.len() < 3 {
        return Err(TessError::DegenerateFace {
            surface_id: sid,
            surface_type: stype,
            reason: "fewer than 3 distinct vertices remain after 2-D deduplication",
        });
    }

    let pts2d = ensure_ccw(pts2d);

    if polygon_area_2d(&pts2d).abs() < 1e-20 {
        return Err(TessError::DegenerateFace {
            surface_id: sid,
            surface_type: stype,
            reason: "projected boundary has negligible 2-D area",
        });
    }

    let pts2d = simplify_ring_robust(pts2d);
    if pts2d.len() < 3 {
        return Err(TessError::DegenerateFace {
            surface_id: sid,
            surface_type: stype,
            reason: "boundary collapsed to fewer than 3 vertices after robust simplification",
        });
    }
    let pts2d = repair_adjacent_hairpins(pts2d);
    if pts2d.len() < 3 {
        return Err(TessError::DegenerateFace {
            surface_id: sid,
            surface_type: stype,
            reason: "boundary collapsed to fewer than 3 vertices after hairpin repair",
        });
    }
    let pts2d = uncross_polygon(pts2d);
    if pts2d.len() < 3 {
        return Err(TessError::DegenerateFace {
            surface_id: sid,
            surface_type: stype,
            reason: "boundary collapsed to fewer than 3 vertices after 2-opt uncrossing",
        });
    }

    // Project each inner loop (hole) onto the same 2D plane.
    let holes2d: Vec<Vec<Point2>> = face
        .inner_loops
        .iter()
        .filter_map(|inner_edges| {
            let inner_3d = sample_boundary_cached(inner_edges, edge_cache);
            if inner_3d.len() < 3 {
                return None;
            }
            let h: Vec<Point2> = inner_3d
                .iter()
                .map(|&p| {
                    let d = sub(p, origin);
                    Point2::new(dot3(d, x_axis), dot3(d, y_axis))
                })
                .collect();
            let h = simplify_ring_robust(h);
            let h = repair_adjacent_hairpins(h);
            let h = uncross_polygon(h);
            if h.len() < 3 {
                None
            } else {
                Some(h)
            }
        })
        .collect();

    let hole_slices: Vec<&[Point2]> = holes2d.iter().map(|h| h.as_slice()).collect();
    let mesh2d = match try_triangulate_constrained(&pts2d, &hole_slices) {
        Ok(m) => m,
        Err(CdtError::IntersectingConstraints { edge_a, edge_b }) => {
            return Err(TessError::ConstraintIntersection {
                surface_id: sid,
                surface_type: stype,
                ea0: edge_a.0,
                ea1: edge_a.1,
                eb0: edge_b.0,
                eb1: edge_b.1,
            });
        }
    };
    let bw_pts2d = mesh2d.points;
    let bw_tris: Vec<[usize; 3]> = mesh2d.triangles.iter().map(|t| t.v).collect();

    let points: Vec<[f64; 3]> = bw_pts2d
        .iter()
        .map(|p| add(origin, add(scale(x_axis, p.x), scale(y_axis, p.y))))
        .collect();

    Ok(SurfaceMesh {
        points,
        triangles: bw_tris,
    })
}

/// `true` iff the open interiors of segment `(p,q)` and `(r,s)` intersect.
///
/// Mirrors `segments_properly_intersect` from the CDT module so that
/// `try_tessellate_plane` can pre-check for crossings without depending on CDT
/// internal details.
#[inline]
fn segs_cross(p: Point2, q: Point2, r: Point2, s: Point2) -> bool {
    let d1 = orient2d(p, q, r);
    let d2 = orient2d(p, q, s);
    let d3 = orient2d(r, s, p);
    let d4 = orient2d(r, s, q);
    ((d1 > 0.0 && d2 < 0.0) || (d1 < 0.0 && d2 > 0.0))
        && ((d3 > 0.0 && d4 < 0.0) || (d3 < 0.0 && d4 > 0.0))
}

/// Repair "adjacent-with-gap" hairpin crossings in a polygon ring.
///
/// An adjacent-with-gap crossing is where constraint edges `(i, i+1)` and
/// `(i+2, i+3)` (cyclically) appear to intersect — the polygon doubles back on
/// itself over a span of exactly two edges.  Such hairpins arise from nearly-
/// complete circular arcs (e.g. ~350 °) whose first and last discretised
/// segments straddle the closure gap.
///
/// Each iteration removes the two "tip" vertices of the hairpin (reducing the
/// polygon by two vertices) and retries until no adjacent-with-gap crossing
/// remains or the polygon degenerates.  At most 16 repair rounds are attempted
/// to avoid infinite loops on truly degenerate input.
fn repair_adjacent_hairpins(mut pts: Vec<Point2>) -> Vec<Point2> {
    for _ in 0..16 {
        let n = pts.len();
        if n < 4 {
            break;
        }
        let mut repaired = false;
        for i in 0..n {
            let a = i;
            let b = (i + 1) % n;
            let c = (i + 2) % n;
            let d = (i + 3) % n;
            if segs_cross(pts[a], pts[b], pts[c], pts[d]) {
                // Remove the two hairpin-tip vertices b and c.
                let keep_b = b;
                let keep_c = c;
                pts = pts
                    .into_iter()
                    .enumerate()
                    .filter(|&(j, _)| j != keep_b && j != keep_c)
                    .map(|(_, p)| p)
                    .collect();
                repaired = true;
                break;
            }
        }
        if !repaired {
            break;
        }
    }
    pts
}

/// 2-opt polygon uncrossing: fix self-intersecting rings by reversing the
/// subpath between any crossing pair.
///
/// Used only as a pre-processing step for non-PLANE surfaces.  PLANE faces
/// use `split_and_triangulate_2d` instead, which preserves geometry.
fn uncross_polygon(mut pts: Vec<Point2>) -> Vec<Point2> {
    for _ in 0..200 {
        let n = pts.len();
        if n < 4 {
            break;
        }
        let mut found = false;
        'outer_2opt: for i in 0..n {
            let a = i;
            let b = (i + 1) % n;
            for j in (i + 2)..n {
                let c = j;
                let d = (j + 1) % n;
                if d == a {
                    continue;
                }
                if segs_cross(pts[a], pts[b], pts[c], pts[d]) {
                    if b <= c {
                        pts[b..=c].reverse();
                    }
                    found = true;
                    break 'outer_2opt;
                }
            }
        }
        if !found {
            break;
        }
    }
    pts
}

/// Replicate CDT's `preprocess_ring` so our vertex indices stay aligned with the
/// indices CDT reports in `CdtError::IntersectingConstraints`.
///
/// CDT removes consecutive duplicate vertices and exact-collinear interior vertices
/// (`orient2d == 0.0`).  Applying the same pass before calling CDT ensures the error
/// indices correspond 1-to-1 to positions in our ring.
fn cdt_preprocess(ring: Vec<Point2>) -> Vec<Point2> {
    if ring.len() < 2 {
        return ring;
    }
    // Pass 1: consecutive duplicates (including last == first wrap).
    let mut deduped: Vec<Point2> = Vec::with_capacity(ring.len());
    for &p in &ring {
        if deduped.last() != Some(&p) {
            deduped.push(p);
        }
    }
    while deduped.len() >= 2 && deduped.last() == deduped.first() {
        deduped.pop();
    }
    if deduped.len() < 3 {
        return deduped;
    }
    // Pass 2: exact collinear (orient2d == 0.0).
    let n = deduped.len();
    let mut result: Vec<Point2> = Vec::with_capacity(n);
    for i in 0..n {
        let prev = deduped[(i + n - 1) % n];
        let curr = deduped[i];
        let next = deduped[(i + 1) % n];
        if orient2d(prev, curr, next) != 0.0 {
            result.push(curr);
        }
    }
    if result.len() < 3 {
        deduped
    } else {
        result
    }
}

/// Compute the intersection point of segments `p1→p2` and `p3→p4`.
/// Returns `None` only if the segments are exactly parallel (denom == 0).
/// Caller is expected to have already verified that the segments properly
/// intersect (e.g. via CDT's `segments_properly_intersect`).
fn segment_intersection_2d(p1: Point2, p2: Point2, p3: Point2, p4: Point2) -> Option<Point2> {
    let dx1 = p2.x - p1.x;
    let dy1 = p2.y - p1.y;
    let dx2 = p4.x - p3.x;
    let dy2 = p4.y - p3.y;
    let denom = dx1 * dy2 - dy1 * dx2;
    if denom == 0.0 {
        return None;
    }
    let t = ((p3.x - p1.x) * dy2 - (p3.y - p1.y) * dx2) / denom;
    Some(Point2::new(p1.x + t * dx1, p1.y + t * dy1))
}

/// Triangulate a 2D polygon, splitting at self-intersections when CDT fails.
///
/// When `try_triangulate_constrained` reports crossing constraint edges:
/// - If both crossing edges lie in the outer ring (both vertex indices < `n_outer`),
///   the polygon is split at the geometric intersection point into two simple
///   sub-polygons which are triangulated independently.
/// - If one crossing edge comes from a hole (vertex index ≥ `n_outer`), that hole
///   is dropped and CDT is retried.
///
/// Returns the flat (pts, tris) pair for the complete triangulation.
/// `depth` bounds recursion; returns `None` when the limit is exceeded.
fn split_and_triangulate_2d(
    outer: Vec<Point2>,
    holes: Vec<Vec<Point2>>,
    depth: usize,
) -> Option<(Vec<Point2>, Vec<[usize; 3]>)> {
    if depth > 8 {
        return None;
    }

    // Pre-apply CDT's exact preprocessing so that the vertex indices in any
    // CdtError::IntersectingConstraints align 1-to-1 with positions in `outer`.
    let outer = cdt_preprocess(outer);
    if outer.len() < 3 {
        return None;
    }

    let n_outer_approx = outer.len();
    let hole_slices: Vec<&[Point2]> = holes.iter().map(|h| h.as_slice()).collect();

    match try_triangulate_constrained(&outer, &hole_slices) {
        Ok(m) => {
            let pts = m.points;
            let tris: Vec<[usize; 3]> = m.triangles.iter().map(|t| t.v).collect();
            Some((pts, tris))
        }
        Err(CdtError::IntersectingConstraints {
            edge_a: (a, b),
            edge_b: (c, d),
        }) => {
            // CDT uses an approximation of n_outer (after its own preprocessing).
            // We use our pre-processed outer length as an approximation.
            let both_in_outer = a < n_outer_approx
                && b < n_outer_approx
                && c < n_outer_approx
                && d < n_outer_approx;

            if both_in_outer {
                if d == 0 {
                    // Closing-edge crossing: the polygon is a near-complete arc whose
                    // closing segment crosses an earlier edge.  2-opt (reversing the
                    // subpath between the two crossing edges) unzips the arc correctly
                    // without splitting the polygon into separate sectors.
                    let uncrossed = uncross_polygon(outer);
                    if uncrossed.len() < 3 {
                        return None;
                    }
                    // Simplify after uncrossing to remove residual near-collinear vertices.
                    let uncrossed = simplify_ring_robust(repair_adjacent_hairpins(uncrossed));
                    if uncrossed.len() < 3 {
                        return None;
                    }
                    split_and_triangulate_2d(uncrossed, holes, depth + 1)
                } else {
                    // Middle crossing: the polygon genuinely folds back on itself (figure-8).
                    // Split at the geometric intersection point into two simple sub-polygons.
                    let ip = segment_intersection_2d(outer[a], outer[b], outer[c], outer[d])?;

                    // Poly1 = outer[0..=a] + ip + outer[d..]
                    // Poly2 = outer[b..=c] + ip
                    let mut p1 = outer[..=a].to_vec();
                    p1.push(ip);
                    p1.extend_from_slice(&outer[d..]);
                    let mut p2 = outer[b..=c].to_vec();
                    p2.push(ip);

                    // Apply simplify+hairpin-repair to each sub-polygon to remove
                    // near-collinear vertices that cause false CDT crossings.
                    let poly1 = simplify_ring_robust(repair_adjacent_hairpins(p1));
                    let poly2 = simplify_ring_robust(repair_adjacent_hairpins(p2));
                    if poly1.len() < 3 || poly2.len() < 3 {
                        return None;
                    }

                    // Pass all holes to both sub-polygon triangulations.
                    // CDT's classify_interior will naturally ignore holes whose
                    // centroids fall outside the respective sub-polygon's outer ring.
                    let h_clone: Vec<Vec<Point2>> = holes.clone();
                    let (pts1, tris1) = split_and_triangulate_2d(poly1, holes, depth + 1)?;
                    let (pts2, tris2) = split_and_triangulate_2d(poly2, h_clone, depth + 1)?;

                    let n1 = pts1.len();
                    let mut all_pts = pts1;
                    let mut all_tris = tris1;
                    all_pts.extend(pts2);
                    for t in tris2 {
                        all_tris.push([t[0] + n1, t[1] + n1, t[2] + n1]);
                    }
                    Some((all_pts, all_tris))
                }
            } else {
                // One crossing edge is in a hole: find and drop that hole.
                let mut cumulative = n_outer_approx;
                let bad_hole = holes.iter().position(|h| {
                    let start = cumulative;
                    cumulative += h.len();
                    let end = cumulative;
                    let edge_in = |x: usize| x >= start && x < end;
                    edge_in(a) || edge_in(b) || edge_in(c) || edge_in(d)
                });

                if let Some(idx) = bad_hole {
                    let new_holes: Vec<Vec<Point2>> = holes
                        .into_iter()
                        .enumerate()
                        .filter(|(i, _)| *i != idx)
                        .map(|(_, h)| h)
                        .collect();
                    split_and_triangulate_2d(outer, new_holes, depth + 1)
                } else {
                    None
                }
            }
        }
    }
}

/// Remove polygon vertices whose triangle area with their two neighbours is
/// below a *relative* threshold.
///
/// The standard [`preprocess_ring`] inside the CDT uses `orient2d == 0.0`
/// (exact arithmetic).  For PLANE faces projected from 3D arc discretisations,
/// some vertices are *nearly* collinear — orient2d is tiny but non-zero — and
/// the resulting two barely-off-parallel adjacent segments can trigger the CDT's
/// strict "properly intersecting" check even though no genuine crossing exists.
///
/// This function eliminates such vertices before CDT sees them.  The geometric
/// error introduced is at most `eps / edge_length ≈ scale × 1e-10 / 1mm`,
/// which for a 260 mm model amounts to ~ 3 nm — far below tessellation
/// tolerance.
fn simplify_ring_robust(pts: Vec<Point2>) -> Vec<Point2> {
    let n = pts.len();
    if n < 3 {
        return pts;
    }
    let max_coord = pts
        .iter()
        .map(|p| p.x.abs().max(p.y.abs()))
        .fold(0.0_f64, f64::max);
    let eps = max_coord * max_coord * 1e-10;

    let mut result: Vec<Point2> = Vec::with_capacity(n);
    for i in 0..n {
        let prev = pts[(i + n - 1) % n];
        let curr = pts[i];
        let next = pts[(i + 1) % n];
        if orient2d(prev, curr, next).abs() > eps {
            result.push(curr);
        }
    }

    if result.len() < 3 {
        pts
    } else {
        result
    }
}

// ── Planar-surface tessellation ───────────────────────────────────────────────

/// Tessellate a `PLANE` face using the exact coordinate axes stored in the STEP
/// entity (not estimated from boundary points).
///
/// Returns `None` when the surface is not a PLANE.  Returns `Some(Err(_))` when
/// the face is a PLANE but tessellation fails (degenerate boundary or
/// self-intersecting constraints).
///
/// Using the PLANE entity's own axes eliminates the small angular errors that
/// arise when the projection basis is estimated from the discretised boundary,
/// and prevents CDT from detecting spurious constraint intersections in large
/// complex PLANE faces.
fn try_tessellate_plane(
    face: &TopoFace,
    edge_cache: &EdgeCache,
    file: &StepFile,
    _opts: &TessOptions,
) -> Option<Result<SurfaceMesh, TessError>> {
    let e = file.get(&face.surface_id)?;
    if e.type_name != "PLANE" {
        return None;
    }

    let sid = face.surface_id;
    let ax_id = get_ref(e, 1).ok()?;
    let axis = axis2_placement(file, ax_id).ok()?;

    // Use the PLANE's exact axes — no numerical estimation from boundary.
    let origin = axis.origin;
    let x_axis = axis.x;
    let y_axis = axis.y();

    let project = |p: [f64; 3]| -> Point2 {
        let d = sub(p, origin);
        Point2::new(dot3(d, x_axis), dot3(d, y_axis))
    };

    let boundary_3d = sample_boundary_cached(&face.outer_loop, edge_cache);
    if boundary_3d.len() < 3 {
        return Some(Err(TessError::DegenerateFace {
            surface_id: sid,
            surface_type: "PLANE".to_owned(),
            reason: "boundary has fewer than 3 usable vertices",
        }));
    }

    let pts2d: Vec<Point2> = boundary_3d.iter().map(|&p| project(p)).collect();
    let pts2d = deduplicate_2d(pts2d);
    if pts2d.len() < 3 {
        return Some(Err(TessError::DegenerateFace {
            surface_id: sid,
            surface_type: "PLANE".to_owned(),
            reason: "fewer than 3 distinct vertices remain after 2-D deduplication",
        }));
    }
    // Track whether the projected boundary is CW before ensure_ccw reverses it.
    // The outer tessellate_face flip logic expects the raw mesh to have the same
    // winding as the boundary (matching the general tessellator's convention):
    //   CCW boundary → CCW triangles → outer flip corrects as needed.
    //   CW boundary  → the general tessellator mirrors axes → CW triangles.
    // We compensate by post-flipping the CDT output when the boundary was CW.
    let boundary_was_cw = polygon_area_2d(&pts2d) < 0.0;
    let pts2d = ensure_ccw(pts2d);
    if polygon_area_2d(&pts2d).abs() < 1e-20 {
        return Some(Err(TessError::DegenerateFace {
            surface_id: sid,
            surface_type: "PLANE".to_owned(),
            reason: "projected boundary has negligible 2-D area",
        }));
    }
    // Remove adjacent-with-gap hairpin crossings from nearly-complete circular arcs.
    // (We skip the relative-epsilon collinear simplification here so that genuine
    // self-intersecting boundaries reach split_and_triangulate_2d intact.)
    let pts2d = repair_adjacent_hairpins(pts2d);
    if pts2d.len() < 3 {
        return Some(Err(TessError::DegenerateFace {
            surface_id: sid,
            surface_type: "PLANE".to_owned(),
            reason: "boundary collapsed to fewer than 3 vertices after hairpin repair",
        }));
    }

    let holes2d: Vec<Vec<Point2>> = face
        .inner_loops
        .iter()
        .filter_map(|inner_edges| {
            let inner_3d = sample_boundary_cached(inner_edges, edge_cache);
            if inner_3d.len() < 3 {
                return None;
            }
            let h = inner_3d.iter().map(|&p| project(p)).collect();
            let h = repair_adjacent_hairpins(h);
            if h.len() < 3 {
                None
            } else {
                Some(h)
            }
        })
        .collect();

    // Use the splitting CDT: if constraints cross, split the polygon at the
    // geometric intersection point and triangulate each piece independently.
    // This correctly handles self-intersecting outer rings (e.g. from complex
    // arc boundaries) without distorting the polygon shape.
    let (bw_pts2d, bw_tris) = match split_and_triangulate_2d(pts2d.clone(), holes2d, 0) {
        Some(result) => result,
        None => {
            // Splitting failed (exceeded recursion depth or parallel edges).
            // At this point the face is genuinely untriangulable; report the
            // first crossing that CDT found so the caller can see the details.
            let hole_slices: Vec<&[Point2]> = Vec::new();
            return match try_triangulate_constrained(&pts2d, &hole_slices) {
                Err(CdtError::IntersectingConstraints { edge_a, edge_b }) => {
                    Some(Err(TessError::ConstraintIntersection {
                        surface_id: sid,
                        surface_type: "PLANE".to_owned(),
                        ea0: edge_a.0,
                        ea1: edge_a.1,
                        eb0: edge_b.0,
                        eb1: edge_b.1,
                    }))
                }
                Ok(_) => None, // shouldn't happen
            };
        }
    };

    let points: Vec<[f64; 3]> = bw_pts2d
        .iter()
        .map(|p| add(origin, add(scale(x_axis, p.x), scale(y_axis, p.y))))
        .collect();

    // CDT always produces CCW triangles (positive 2-D area).  When the original
    // boundary was CW, the general tessellator would have returned CW triangles
    // because its axis estimation mirrors the coordinate system.  Post-flip here
    // so that tessellate_face's outer flip (`!outer_loop_orientation`) arrives at
    // the same result it would with the general tessellator.
    let bw_tris: Vec<[usize; 3]> = if boundary_was_cw {
        bw_tris.into_iter().map(|[a, b, c]| [a, c, b]).collect()
    } else {
        bw_tris
    };

    Some(Ok(SurfaceMesh {
        points,
        triangles: bw_tris,
    }))
}

// ── Curved-surface tessellation ───────────────────────────────────────────────

/// Tessellate a `CYLINDRICAL_SURFACE` face directly in UV space (u = angle, v = height)
/// and lift back to 3D. Returns `None` when the surface is not cylindrical.
///
/// Full-revolution barrels (detected by a closed-circle boundary edge) generate a u×v
/// grid spanning u ∈ [0, 2π] with v inferred from the boundary axial extents.
/// Partial cylinders (hole walls, fillets, chamfer arcs) invert the boundary to cylinder
/// UV, determine the u-range, then generate a UV grid over [u_min, u_max] × [v_min, v_max].
fn try_tessellate_cylindrical(
    face: &TopoFace,
    edge_cache: &EdgeCache,
    file: &StepFile,
    opts: &TessOptions,
) -> Option<SurfaceMesh> {
    let e = file.get(&face.surface_id)?;
    if e.type_name != "CYLINDRICAL_SURFACE" {
        return None;
    }

    let ax_id = get_ref(e, 1).ok()?;
    let radius = get_real(e, 2).ok()?;
    let axis = axis2_placement(file, ax_id).ok()?;
    let y = axis.y();

    let boundary_3d = sample_boundary_cached(&face.outer_loop, edge_cache);
    if boundary_3d.len() < 3 {
        return None;
    }

    // Full-revolution check: a closed-circle edge has start ≈ end (zero chord).
    let has_closed_circle = face.outer_loop.iter().any(|edge| {
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
    // Annular faces: the outer loop is a single closed circle (all boundary_3d
    // points at the same height), so v_min ≈ v_max.  Extend the v range using
    // inner-loop boundary points so we cover the full axial extent.
    if (v_max - v_min).abs() < 1e-10 {
        for inner_edges in &face.inner_loops {
            for &p in &sample_boundary_cached(inner_edges, edge_cache) {
                let d = sub(p, axis.origin);
                let vv = dot3(d, axis.z);
                v_min = v_min.min(vv);
                v_max = v_max.max(vv);
            }
        }
    }
    if (v_max - v_min).abs() < 1e-10 {
        return None;
    }

    if has_closed_circle {
        // Full-revolution barrel.
        //
        // Derive n_u and the ring vertex positions from the cached closed-circle
        // edge rather than recomputing from `2πi/n_u`.  The disc/annular-disc cap
        // tessellators also read from the same cache entries, so all three faces
        // (barrel + two caps) get bitwise-identical positions on the shared rings.
        // Collect all closed-circle edges so we can use their cached rings for
        // the j=0 and j=n_v rows.
        //
        // Always use the CANONICAL (non-reversed) cache direction — every row
        // (bottom, interior, top) must rotate in the same angular sense so that
        // the barrel's quad triangles have consistent winding.  The traversal
        // direction stored in `edge.reversed` is irrelevant here because the
        // overall face winding is corrected by `flip_winding_if` afterwards.
        let mut cached_rings: Vec<(f64, Vec<[f64; 3]>)> = face
            .outer_loop
            .iter()
            .filter(|e| dist3(e.start, e.end) < 1e-10)
            .filter_map(|e| {
                let cached = edge_cache.get(&e.edge_id)?;
                if cached.len() < 2 {
                    return None;
                }
                // Axial coordinate of this ring.
                let v_ring = dot3(sub(cached[0], axis.origin), axis.z);
                // Canonical: first n_u entries (exclude the duplicated closing point).
                let nu = cached.len() - 1;
                let ring: Vec<[f64; 3]> = cached[..nu].to_vec();
                Some((v_ring, ring))
            })
            .collect();
        // Sort rings by axial coordinate so index 0 = bottom, last = top.
        cached_rings.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

        let n_v = (((v_max - v_min).abs() / opts.max_edge_len).ceil() as usize).max(1);

        // Infer u-angles for interior rows from the bottom ring (or compute from scratch).
        let u_angles: Vec<f64> = if let Some((_, ring)) = cached_rings.first() {
            ring.iter()
                .map(|&p| {
                    let d = sub(p, axis.origin);
                    f64::atan2(dot3(d, y), dot3(d, axis.x))
                })
                .collect()
        } else {
            let n_u_fallback = n_segs_for_arc(radius, 2.0 * PI, opts).clamp(8, 512);
            (0..n_u_fallback)
                .map(|i| 2.0 * PI * i as f64 / n_u_fallback as f64)
                .collect()
        };

        let n_u_actual = u_angles.len().max(8);
        let mut points = Vec::with_capacity(n_u_actual * (n_v + 1));

        for j in 0..=n_v {
            let v = v_min + (v_max - v_min) * j as f64 / n_v as f64;

            // Use a cached ring for the boundary rows when one is available at
            // this axial level; fall back to UV evaluation for interior rows.
            let cached_ring = cached_rings
                .iter()
                .find(|(v_ring, _)| (v_ring - v).abs() < (v_max - v_min) * 1e-4 + 1e-8)
                .map(|(_, ring)| ring);

            if let Some(ring) = cached_ring {
                for i in 0..n_u_actual {
                    points.push(ring[i % ring.len()]);
                }
            } else {
                for &u in &u_angles {
                    let radial = add(scale(axis.x, u.cos()), scale(y, u.sin()));
                    points.push(add(
                        axis.origin,
                        add(scale(radial, radius), scale(axis.z, v)),
                    ));
                }
            }
        }

        let mut triangles = Vec::with_capacity(n_u_actual * n_v * 2);
        for j in 0..n_v {
            for i in 0..n_u_actual {
                let ni = (i + 1) % n_u_actual;
                let a = j * n_u_actual + i;
                let b = j * n_u_actual + ni;
                let c = (j + 1) * n_u_actual + i;
                let d = (j + 1) * n_u_actual + ni;
                triangles.push([a, b, d]);
                triangles.push([a, d, c]);
            }
        }

        Some(SurfaceMesh { points, triangles })
    } else {
        // Partial cylinder: invert boundary to find the angular u-range.
        let surface = surface_from_step(face.surface_id, file).ok()?;

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

        // Build UV boundary polygon for triangle clipping.
        let uv_bnd: Vec<Point2> = u_vals
            .iter()
            .zip(boundary_3d.iter())
            .map(|(&u, &p)| {
                let d = sub(p, axis.origin);
                Point2::new(u, dot3(d, axis.z))
            })
            .collect();

        let arc_v = (v_max - v_min).abs();
        let n_u = n_segs_for_arc(radius, u_max - u_min, opts).clamp(2, 512);
        let n_v = ((arc_v / opts.max_edge_len).ceil() as usize).clamp(1, 512);

        let mut points = Vec::with_capacity((n_u + 1) * (n_v + 1));
        let mut uv_grid = Vec::with_capacity((n_u + 1) * (n_v + 1));
        for j in 0..=n_v {
            let v = v_min + (v_max - v_min) * j as f64 / n_v as f64;
            for i in 0..=n_u {
                let u = u_min + (u_max - u_min) * i as f64 / n_u as f64;
                points.push(surface.point(u, v));
                uv_grid.push(Point2::new(u, v));
            }
        }

        let n_cols = n_u + 1;
        let triangles: Vec<[usize; 3]> = (0..n_v)
            .flat_map(|j| {
                (0..n_u).flat_map(move |i| {
                    let a = j * n_cols + i;
                    let b = j * n_cols + (i + 1);
                    let c = (j + 1) * n_cols + i;
                    let d = (j + 1) * n_cols + (i + 1);
                    [[a, b, d], [a, d, c]]
                })
            })
            .filter(|&[a, b, c]| {
                let cu = (uv_grid[a].x + uv_grid[b].x + uv_grid[c].x) / 3.0;
                let cv = (uv_grid[a].y + uv_grid[b].y + uv_grid[c].y) / 3.0;
                point_in_polygon(Point2::new(cu, cv), &uv_bnd)
            })
            .collect();

        Some(SurfaceMesh { points, triangles })
    }
}

/// Tessellate a `CONICAL_SURFACE` face directly in UV space (u = angle, v = slant distance)
/// and lift back to 3D. Returns `None` when the surface is not conical.
///
/// Full-revolution cones (detected by a closed-circle boundary edge) generate a u×v grid
/// spanning u ∈ [0, 2π] with v inferred from the boundary axial extents.
/// Partial cones (chamfers, tapered transitions that do not wrap fully) invert the boundary
/// to cone UV, determine the u-range, then generate a UV grid over [u_min, u_max] × [v_min, v_max].
fn try_tessellate_conical(
    face: &TopoFace,
    edge_cache: &EdgeCache,
    file: &StepFile,
    opts: &TessOptions,
) -> Option<SurfaceMesh> {
    let e = file.get(&face.surface_id)?;
    if e.type_name != "CONICAL_SURFACE" {
        return None;
    }

    let ax_id = get_ref(e, 1).ok()?;
    let radius = get_real(e, 2).ok()?;
    // STEP stores plane_angle_measure in degrees; convert to radians.
    let semi_angle = get_real(e, 3).ok()?.to_radians();
    let axis = axis2_placement(file, ax_id).ok()?;
    let y = axis.y();

    let surface = surface_from_step(face.surface_id, file).ok()?;

    let boundary_3d = sample_boundary_cached(&face.outer_loop, edge_cache);
    if boundary_3d.len() < 3 {
        return None;
    }

    // Full-revolution check: a closed-circle edge has start ≈ end (zero chord).
    let has_closed_circle = face.outer_loop.iter().any(|edge| {
        let d = sub(edge.start, edge.end);
        d[0] * d[0] + d[1] * d[1] + d[2] * d[2] < 1e-16
    });

    // Degenerate flat cone (φ ≈ ±90°): cos(φ) ≈ 0 means v is undefined.
    let cos_phi = semi_angle.cos();
    if cos_phi.abs() < 1e-10 {
        return None;
    }

    // Invert boundary points to slant parameter v = axial_projection / cos(φ).
    let mut v_min = f64::INFINITY;
    let mut v_max = f64::NEG_INFINITY;
    for &p in &boundary_3d {
        let d = sub(p, axis.origin);
        let v = dot3(d, axis.z) / cos_phi;
        v_min = v_min.min(v);
        v_max = v_max.max(v);
    }
    // Annular cone faces: the outer loop is a single closed circle (v_min ≈ v_max).
    // Extend the v range using inner-loop boundary points.
    if (v_max - v_min).abs() < 1e-10 {
        for inner_edges in &face.inner_loops {
            for &p in &sample_boundary_cached(inner_edges, edge_cache) {
                let d = sub(p, axis.origin);
                let vv = dot3(d, axis.z) / cos_phi;
                v_min = v_min.min(vv);
                v_max = v_max.max(vv);
            }
        }
    }
    if (v_max - v_min).abs() < 1e-10 {
        return None;
    }

    // Radius at the midpoint v for density estimation.
    let v_mid = (v_min + v_max) / 2.0;
    let r_mid = (radius + v_mid * semi_angle.sin()).abs();

    if has_closed_circle {
        // Full-revolution cone — same ring-from-cache strategy as the cylinder.
        // Same canonical-direction rule as the cylinder barrel: all rows must
        // share a consistent angular sense; flip_winding_if corrects the face.
        let mut cached_rings: Vec<(f64, Vec<[f64; 3]>)> = face
            .outer_loop
            .iter()
            .filter(|e| dist3(e.start, e.end) < 1e-10)
            .filter_map(|e| {
                let cached = edge_cache.get(&e.edge_id)?;
                if cached.len() < 2 {
                    return None;
                }
                let v_ring = dot3(sub(cached[0], axis.origin), axis.z) / cos_phi;
                let nu = cached.len() - 1;
                let ring: Vec<[f64; 3]> = cached[..nu].to_vec();
                Some((v_ring, ring))
            })
            .collect();
        cached_rings.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

        let n_u = cached_rings
            .first()
            .map(|(_, r)| r.len())
            .unwrap_or_else(|| n_segs_for_arc(r_mid, 2.0 * PI, opts).clamp(8, 512));
        let n_v = (((v_max - v_min).abs() / opts.max_edge_len).ceil() as usize).max(1);

        let u_angles: Vec<f64> = cached_rings
            .first()
            .map(|(_, ring)| {
                ring.iter()
                    .map(|&p| {
                        let d = sub(p, axis.origin);
                        f64::atan2(dot3(d, y), dot3(d, axis.x))
                    })
                    .collect()
            })
            .unwrap_or_else(|| (0..n_u).map(|i| 2.0 * PI * i as f64 / n_u as f64).collect());

        let mut points = Vec::with_capacity(n_u * (n_v + 1));
        for j in 0..=n_v {
            let v = v_min + (v_max - v_min) * j as f64 / n_v as f64;
            let cached_ring = cached_rings
                .iter()
                .find(|(v_ring, _)| (v_ring - v).abs() < (v_max - v_min) * 1e-4 + 1e-8)
                .map(|(_, ring)| ring);

            if let Some(ring) = cached_ring {
                for i in 0..n_u {
                    points.push(ring[i % ring.len()]);
                }
            } else {
                for &u in &u_angles {
                    points.push(surface.point(u, v));
                }
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
        // Partial cone: invert boundary to find the angular u-range.
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

        // Build UV boundary polygon for triangle clipping.
        let uv_bnd: Vec<Point2> = u_vals
            .iter()
            .zip(boundary_3d.iter())
            .map(|(&u, &p)| {
                let d = sub(p, axis.origin);
                Point2::new(u, dot3(d, axis.z) / cos_phi)
            })
            .collect();

        let arc_v = (v_max - v_min).abs();
        let n_u = n_segs_for_arc(r_mid, u_max - u_min, opts).clamp(2, 512);
        let n_v = ((arc_v / opts.max_edge_len).ceil() as usize).clamp(1, 512);

        let mut points = Vec::with_capacity((n_u + 1) * (n_v + 1));
        let mut uv_grid = Vec::with_capacity((n_u + 1) * (n_v + 1));
        for j in 0..=n_v {
            let v = v_min + (v_max - v_min) * j as f64 / n_v as f64;
            for i in 0..=n_u {
                let u = u_min + (u_max - u_min) * i as f64 / n_u as f64;
                points.push(surface.point(u, v));
                uv_grid.push(Point2::new(u, v));
            }
        }

        let n_cols = n_u + 1;
        let triangles: Vec<[usize; 3]> = (0..n_v)
            .flat_map(|j| {
                (0..n_u).flat_map(move |i| {
                    let a = j * n_cols + i;
                    let b = j * n_cols + (i + 1);
                    let c = (j + 1) * n_cols + i;
                    let d = (j + 1) * n_cols + (i + 1);
                    [[a, b, d], [a, d, c]]
                })
            })
            .filter(|&[a, b, c]| {
                let cu = (uv_grid[a].x + uv_grid[b].x + uv_grid[c].x) / 3.0;
                let cv = (uv_grid[a].y + uv_grid[b].y + uv_grid[c].y) / 3.0;
                point_in_polygon(Point2::new(cu, cv), &uv_bnd)
            })
            .collect();

        Some(SurfaceMesh { points, triangles })
    }
}

/// Tessellate a `TOROIDAL_SURFACE` face (blend fillet or full ring) directly
/// in UV space (u = angle around the major circle, v = angle around the tube)
/// and lift back to 3D.  Returns `None` when the surface is not toroidal.
///
/// Full-revolution tori (all boundary edges are degenerate seam edges with
/// start ≈ end) generate a u×v grid spanning [0, 2π] × [0, 2π].
/// Partial toroidal patches infer u and v ranges by inverting the boundary.
fn try_tessellate_toroidal(
    face: &TopoFace,
    edge_cache: &EdgeCache,
    file: &StepFile,
    opts: &TessOptions,
) -> Option<SurfaceMesh> {
    let e = file.get(&face.surface_id)?;
    if e.type_name != "TOROIDAL_SURFACE" {
        return None;
    }

    let ax_id = get_ref(e, 1).ok()?;
    let major_radius = get_real(e, 2).ok()?;
    let minor_radius = get_real(e, 3).ok()?;
    let axis = axis2_placement(file, ax_id).ok()?;
    let y = axis.y();

    let surface = surface_from_step(face.surface_id, file).ok()?;

    // Full-revolution check: all boundary edges are degenerate seam edges
    // (start ≈ end).  OCC exports a full torus with SEAM_CURVE edges only.
    let all_closed = !face.outer_loop.is_empty()
        && face.outer_loop.iter().all(|edge| {
            let d = sub(edge.start, edge.end);
            d[0] * d[0] + d[1] * d[1] + d[2] * d[2] < 1e-10
        });

    if all_closed {
        // Full torus: chord-height criterion on the outer equator (u) and tube (v).
        let n_u = n_segs_for_arc(major_radius + minor_radius, 2.0 * PI, opts).clamp(8, 512);
        let n_v = n_segs_for_arc(minor_radius, 2.0 * PI, opts).clamp(8, 512);

        let mut points = Vec::with_capacity(n_u * n_v);
        for j in 0..n_v {
            let v = 2.0 * PI * j as f64 / n_v as f64;
            for i in 0..n_u {
                let u = 2.0 * PI * i as f64 / n_u as f64;
                points.push(surface.point(u, v));
            }
        }

        let mut triangles = Vec::with_capacity(n_u * n_v * 2);
        for j in 0..n_v {
            let nj = (j + 1) % n_v;
            for i in 0..n_u {
                let ni = (i + 1) % n_u;
                let a = j * n_u + i;
                let b = j * n_u + ni;
                let c = nj * n_u + i;
                let d = nj * n_u + ni;
                triangles.push([a, b, d]);
                triangles.push([a, d, c]);
            }
        }

        return Some(SurfaceMesh { points, triangles });
    }

    let boundary_3d = sample_boundary_cached(&face.outer_loop, edge_cache);
    if boundary_3d.len() < 3 {
        return None;
    }

    // Invert boundary points to (u, v).
    // u = atan2(dot(p-o, y), dot(p-o, x))   — major angle
    // v = atan2(dot(p-o, z), |proj_xy| - R) — tube angle
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

    // Unwrap both angular parameters to a contiguous range.
    let u_vals = unwrap_angles(raw_uv.iter().map(|&(u, _)| u).collect());
    let v_vals = unwrap_angles(raw_uv.iter().map(|&(_, v)| v).collect());

    let u_min = u_vals.iter().cloned().fold(f64::INFINITY, f64::min);
    let u_max = u_vals.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let v_min = v_vals.iter().cloned().fold(f64::INFINITY, f64::min);
    let v_max = v_vals.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

    if (u_max - u_min) < 1e-10 || (v_max - v_min) < 1e-10 {
        return None;
    }

    let n_u = n_segs_for_arc(major_radius + minor_radius, u_max - u_min, opts).clamp(2, 512);
    let n_v = n_segs_for_arc(minor_radius, v_max - v_min, opts).clamp(2, 512);

    let mut points = Vec::with_capacity((n_u + 1) * (n_v + 1));
    for j in 0..=n_v {
        let v = v_min + (v_max - v_min) * j as f64 / n_v as f64;
        for i in 0..=n_u {
            let u = u_min + (u_max - u_min) * i as f64 / n_u as f64;
            points.push(surface.point(u, v));
        }
    }

    // Toroidal patches in engineering models are always rectangular in UV space,
    // so no polygon clipping is needed — the grid already covers exactly the face.
    let n_cols = n_u + 1;
    let triangles: Vec<[usize; 3]> = (0..n_v)
        .flat_map(|j| {
            (0..n_u).flat_map(move |i| {
                let a = j * n_cols + i;
                let b = j * n_cols + (i + 1);
                let c = (j + 1) * n_cols + i;
                let d = (j + 1) * n_cols + (i + 1);
                [[a, b, d], [a, d, c]]
            })
        })
        .collect();

    Some(SurfaceMesh { points, triangles })
}

/// Tessellate a `SPHERICAL_SURFACE` face directly in UV space (u = longitude around z,
/// v = latitude from equator) and lift back to 3D.  Returns `None` when the surface is
/// not spherical.
///
/// Spherical patches are always treated as partial: u and v ranges are inferred from the
/// boundary rather than assumed to be full [0, 2π] × [-π/2, π/2].  This handles fillets,
/// ball-end slots, domes, and other partial sphere features common in NIST AP242 models.
fn try_tessellate_spherical(
    face: &TopoFace,
    edge_cache: &EdgeCache,
    file: &StepFile,
    opts: &TessOptions,
) -> Option<SurfaceMesh> {
    let e = file.get(&face.surface_id)?;
    if e.type_name != "SPHERICAL_SURFACE" {
        return None;
    }

    let ax_id = get_ref(e, 1).ok()?;
    let radius = get_real(e, 2).ok()?;
    let axis = axis2_placement(file, ax_id).ok()?;
    let y = axis.y();

    let surface = surface_from_step(face.surface_id, file).ok()?;

    let boundary_3d = sample_boundary_cached(&face.outer_loop, edge_cache);
    if boundary_3d.len() < 3 {
        return None;
    }

    // Invert boundary points to spherical (u, v).
    // u = atan2(dot(p-o, y), dot(p-o, x)) — longitude
    // v = asin(dot(p-o, z) / R)           — latitude
    let raw_uv: Vec<(f64, f64)> = boundary_3d
        .iter()
        .map(|&p| {
            let d = sub(p, axis.origin);
            let dx = dot3(d, axis.x);
            let dy = dot3(d, y);
            let dz = dot3(d, axis.z);
            let u = f64::atan2(dy, dx);
            // Clamp the asin argument to [-1, 1] to handle numerical noise
            let sin_v = (dz / radius).clamp(-1.0, 1.0);
            let v = sin_v.asin();
            (u, v)
        })
        .collect();

    // Unwrap both angular parameters to a contiguous range.
    let u_vals = unwrap_angles(raw_uv.iter().map(|&(u, _)| u).collect());
    let v_vals: Vec<f64> = raw_uv.iter().map(|&(_, v)| v).collect();

    let u_min = u_vals.iter().cloned().fold(f64::INFINITY, f64::min);
    let u_max = u_vals.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let v_min = v_vals.iter().cloned().fold(f64::INFINITY, f64::min);
    let v_max = v_vals.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

    // Spherical cap: boundary ring sits at approximately constant latitude —
    // the pole is enclosed.  Subdivide the dome with concentric latitude rings
    // so each triangle approximates the curved surface to within chord_height_tol.
    if (v_max - v_min) < 1e-10 {
        let v_rim = (v_min + v_max) / 2.0;
        let pole_v = if v_rim >= 0.0 { PI / 2.0 } else { -PI / 2.0 };
        let angle_span = (pole_v - v_rim).abs();

        // Derive angular positions from the boundary ring (exact cache positions).
        let n_u = boundary_3d.len();
        let u_angles: Vec<f64> = boundary_3d
            .iter()
            .map(|&p| {
                let d = sub(p, axis.origin);
                f64::atan2(dot3(d, y), dot3(d, axis.x))
            })
            .collect();

        // Latitude steps: chord-height criterion along a meridian arc.
        let n_v = n_segs_for_arc(radius, angle_span, opts).clamp(2, 64);

        let mut points = boundary_3d; // first n_u points = the boundary ring
        for j in 1..n_v {
            let v = v_rim + (pole_v - v_rim) * j as f64 / n_v as f64;
            for &u in &u_angles {
                points.push(surface.point(u, v));
            }
        }
        let pole_idx = points.len();
        points.push(surface.point(0.0, pole_v));

        let mut triangles: Vec<[usize; 3]> = Vec::new();
        // Rings from j=0 (boundary) up to j=n_v-2 (last interior ring before pole)
        for j in 0..n_v - 1 {
            let row = j * n_u;
            let next = (j + 1) * n_u;
            for i in 0..n_u {
                let ni = (i + 1) % n_u;
                triangles.push([row + i, row + ni, next + ni]);
                triangles.push([row + i, next + ni, next + i]);
            }
        }
        // Fan from the last interior ring to the pole
        let last_row = (n_v - 1) * n_u;
        for i in 0..n_u {
            let ni = (i + 1) % n_u;
            triangles.push([last_row + i, last_row + ni, pole_idx]);
        }
        return Some(SurfaceMesh { points, triangles });
    }

    if (u_max - u_min) < 1e-10 {
        return None;
    }

    // Chord-height criterion: longitude circles have effective radius R*cos(v_mid).
    let v_mid = (v_min + v_max) / 2.0;
    let r_u = radius * v_mid.cos().abs();
    let n_u = n_segs_for_arc(r_u.max(1e-10), u_max - u_min, opts).clamp(2, 512);
    let n_v = n_segs_for_arc(radius, v_max - v_min, opts).clamp(2, 512);

    let mut points = Vec::with_capacity((n_u + 1) * (n_v + 1));
    let mut uv_grid = Vec::with_capacity((n_u + 1) * (n_v + 1));
    for j in 0..=n_v {
        let v = v_min + (v_max - v_min) * j as f64 / n_v as f64;
        for i in 0..=n_u {
            let u = u_min + (u_max - u_min) * i as f64 / n_u as f64;
            points.push(surface.point(u, v));
            uv_grid.push(Point2::new(u, v));
        }
    }

    // Build UV boundary polygon for clipping (handles non-rectangular spherical patches).
    // Downsample to cap O(n_triangles × n_boundary) cost on complex faces.
    let uv_bnd_raw: Vec<Point2> = u_vals
        .iter()
        .zip(v_vals.iter())
        .map(|(&u, &v)| Point2::new(u, v))
        .collect();
    // Cap boundary polygon to 32 vertices — spherical patches can have complex
    // (non-rectangular) UV boundaries, but 32 samples are enough to clip corners.
    let uv_bnd: Vec<Point2> = if uv_bnd_raw.len() > 32 {
        let step = (uv_bnd_raw.len() / 32).max(1);
        uv_bnd_raw.iter().step_by(step).cloned().collect()
    } else {
        uv_bnd_raw
    };

    let n_cols = n_u + 1;
    let triangles: Vec<[usize; 3]> = (0..n_v)
        .flat_map(|j| {
            (0..n_u).flat_map(move |i| {
                let a = j * n_cols + i;
                let b = j * n_cols + (i + 1);
                let c = (j + 1) * n_cols + i;
                let d = (j + 1) * n_cols + (i + 1);
                [[a, b, d], [a, d, c]]
            })
        })
        .filter(|&[a, b, c]| {
            let cu = (uv_grid[a].x + uv_grid[b].x + uv_grid[c].x) / 3.0;
            let cv = (uv_grid[a].y + uv_grid[b].y + uv_grid[c].y) / 3.0;
            point_in_polygon(Point2::new(cu, cv), &uv_bnd)
        })
        .collect();

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

/// Tessellate a B-spline surface face using CDT constrained to the edge-cached
/// boundary, with UV-grid Steiner points providing interior density.
///
/// This replaces the previous centroid-filter approach, which produced triangles
/// that extended beyond the actual face boundary ("triangles going over edges").
/// Now the edge-cached boundary ring is a hard CDT constraint, and UV-grid points
/// that project strictly inside the boundary become Steiner interior nodes.
/// Boundary CDT vertices recover their exact edge-cache 3D positions via a
/// bit-exact 2D→3D map, preserving the "individual edge meshing" invariant
/// that adjacent faces stitch at zero distance.
fn try_tessellate_bspline(
    face: &TopoFace,
    edge_cache: &EdgeCache,
    file: &StepFile,
    opts: &TessOptions,
) -> Option<SurfaceMesh> {
    let e = file.get(&face.surface_id)?;

    let is_bspline = e.type_name == "B_SPLINE_SURFACE_WITH_KNOTS"
        || (e.type_name.is_empty()
            && e.args.iter().any(|a| {
                matches!(a, Arg::TypedValue { name, .. } if name == "B_SPLINE_SURFACE_WITH_KNOTS")
            }));

    if !is_bspline {
        return None;
    }

    let surface = surface_from_step(face.surface_id, file).ok()?;

    let (u0, u1) = surface.u_bounds();
    let (v0, v1) = surface.v_bounds();
    if !u0.is_finite() || !u1.is_finite() || !v0.is_finite() || !v1.is_finite() {
        return None;
    }
    let u_mid = (u0 + u1) / 2.0;
    let v_mid = (v0 + v1) / 2.0;

    // ── Boundary ────────────────────────────────────────────────────────────
    let boundary_3d = sample_boundary_cached(&face.outer_loop, edge_cache);
    if boundary_3d.len() < 3 {
        return None;
    }

    // ── Arc lengths / grid density ──────────────────────────────────────────
    let arc_u = sample_arc_length(|t| surface.point(t, v_mid), u0, u1, 32);
    let arc_v = sample_arc_length(|t| surface.point(u_mid, t), v0, v1, 32);
    if arc_u < 1e-10 || arc_v < 1e-10 {
        return None;
    }
    let n_u = ((arc_u / opts.max_edge_len).ceil() as usize).clamp(2, 256) + 1;
    let n_v = ((arc_v / opts.max_edge_len).ceil() as usize).clamp(2, 256) + 1;

    // ── Try UV-space triangulation ──────────────────────────────────────────
    // Invert each boundary 3D point to its (u,v) parameter on the surface.
    // If all invert successfully we triangulate entirely in UV space, which
    // correctly handles highly curved B-spline patches where a flat tangent-
    // plane projection causes interior UV grid points to fall outside the
    // projected boundary polygon.
    let bnd_uv: Vec<(f64, f64)> = boundary_3d
        .iter()
        .filter_map(|&p| invert_surface_uv(&*surface, p, u0, u1, v0, v1))
        .collect();

    if bnd_uv.len() == boundary_3d.len() {
        let bnd2d_uv_raw: Vec<Point2> = bnd_uv.iter().map(|&(u, v)| Point2::new(u, v)).collect();
        let bnd_map_uv = build_bnd2d_map(&bnd2d_uv_raw, &boundary_3d);
        let bnd2d = ensure_ccw(deduplicate_2d(bnd2d_uv_raw));
        if bnd2d.len() < 3 || polygon_area_2d(&bnd2d).abs() < 1e-20 {
            return None;
        }

        // Holes in UV space.
        let holes_data: Vec<(Vec<[f64; 3]>, Vec<Point2>)> = face
            .inner_loops
            .iter()
            .filter_map(|inner| {
                let inner_3d = sample_boundary_cached(inner, edge_cache);
                if inner_3d.len() < 3 {
                    return None;
                }
                let inner_uv: Vec<(f64, f64)> = inner_3d
                    .iter()
                    .filter_map(|&p| invert_surface_uv(&*surface, p, u0, u1, v0, v1))
                    .collect();
                if inner_uv.len() != inner_3d.len() {
                    return None;
                }
                let inner_2d = inner_uv.iter().map(|&(u, v)| Point2::new(u, v)).collect();
                Some((inner_3d, inner_2d))
            })
            .collect();
        let hole_maps: Vec<HashMap<(u64, u64), [f64; 3]>> = holes_data
            .iter()
            .map(|(h3d, h2d)| build_bnd2d_map(h2d, h3d))
            .collect();
        let holes2d: Vec<Vec<Point2>> = holes_data.iter().map(|(_, h2d)| h2d.clone()).collect();
        let hole_slices: Vec<&[Point2]> = holes2d.iter().map(|h| h.as_slice()).collect();

        // Interior UV grid points — tested in UV space (correct for any curvature).
        let mut interior_3d: Vec<[f64; 3]> = Vec::new();
        let mut interior_2d: Vec<Point2> = Vec::new();
        for j in 0..n_v {
            let v = v0 + (v1 - v0) * j as f64 / (n_v - 1) as f64;
            for i in 0..n_u {
                let u = u0 + (u1 - u0) * i as f64 / (n_u - 1) as f64;
                let p2d = Point2::new(u, v);
                if point_in_polygon(p2d, &bnd2d)
                    && !holes2d.iter().any(|h| point_in_polygon(p2d, h))
                {
                    interior_3d.push(surface.point(u, v));
                    interior_2d.push(p2d);
                }
            }
        }

        let (mesh2d, n_outer, n_holes) =
            match try_triangulate_with_interior(&bnd2d, &hole_slices, &interior_2d) {
                Ok(r) => r,
                Err(_) => return None,
            };
        if mesh2d.triangles.is_empty() {
            return None;
        }

        let n_bnd_total = n_outer + n_holes;
        let points: Vec<[f64; 3]> = mesh2d
            .points
            .iter()
            .enumerate()
            .map(|(i, p2d)| {
                let key = (p2d.x.to_bits(), p2d.y.to_bits());
                if i < n_outer {
                    bnd_map_uv
                        .get(&key)
                        .copied()
                        .unwrap_or_else(|| surface.point(p2d.x, p2d.y))
                } else if i < n_bnd_total {
                    hole_maps
                        .iter()
                        .find_map(|m| m.get(&key).copied())
                        .unwrap_or_else(|| surface.point(p2d.x, p2d.y))
                } else {
                    interior_3d[i - n_bnd_total]
                }
            })
            .collect();

        let triangles: Vec<[usize; 3]> = mesh2d.triangles.iter().map(|t| t.v).collect();
        return Some(SurfaceMesh { points, triangles });
    }

    // ── Fallback: 3D tangent-plane projection ───────────────────────────────
    // UV inversion failed for at least one boundary point (e.g. degenerate
    // surface).  Project to the tangent plane at the UV midpoint and filter
    // interior points with point_in_polygon.
    let surf_n = surface.normal(u_mid, v_mid);
    let normal = if surf_n.iter().all(|x| x.is_finite()) && dot3(surf_n, surf_n) > 1e-20 {
        surf_n
    } else {
        face_normal(&boundary_3d)?
    };
    let (bnd2d_raw, origin, x_axis, y_axis) = project_to_2d(&boundary_3d, normal);
    let bnd_map = build_bnd2d_map(&bnd2d_raw, &boundary_3d);
    let bnd2d = ensure_ccw(deduplicate_2d(bnd2d_raw));
    if bnd2d.len() < 3 || polygon_area_2d(&bnd2d).abs() < 1e-20 {
        return None;
    }

    let holes_data: Vec<(Vec<[f64; 3]>, Vec<Point2>)> = face
        .inner_loops
        .iter()
        .filter_map(|inner| {
            let inner_3d = sample_boundary_cached(inner, edge_cache);
            if inner_3d.len() < 3 {
                return None;
            }
            let inner_2d = inner_3d
                .iter()
                .map(|&p| {
                    let d = sub(p, origin);
                    Point2::new(dot3(d, x_axis), dot3(d, y_axis))
                })
                .collect();
            Some((inner_3d, inner_2d))
        })
        .collect();
    let hole_maps: Vec<HashMap<(u64, u64), [f64; 3]>> = holes_data
        .iter()
        .map(|(h3d, h2d)| build_bnd2d_map(h2d, h3d))
        .collect();
    let holes2d: Vec<Vec<Point2>> = holes_data.iter().map(|(_, h2d)| h2d.clone()).collect();
    let hole_slices: Vec<&[Point2]> = holes2d.iter().map(|h| h.as_slice()).collect();

    let mut interior_3d: Vec<[f64; 3]> = Vec::new();
    let mut interior_2d: Vec<Point2> = Vec::new();
    for j in 0..n_v {
        let v = v0 + (v1 - v0) * j as f64 / (n_v - 1) as f64;
        for i in 0..n_u {
            let u = u0 + (u1 - u0) * i as f64 / (n_u - 1) as f64;
            let p3d = surface.point(u, v);
            let d = sub(p3d, origin);
            let p2d = Point2::new(dot3(d, x_axis), dot3(d, y_axis));
            if point_in_polygon(p2d, &bnd2d) && !holes2d.iter().any(|h| point_in_polygon(p2d, h)) {
                interior_3d.push(p3d);
                interior_2d.push(p2d);
            }
        }
    }

    let (mesh2d, n_outer, n_holes) =
        match try_triangulate_with_interior(&bnd2d, &hole_slices, &interior_2d) {
            Ok(r) => r,
            Err(_) => return None,
        };
    if mesh2d.triangles.is_empty() {
        return None;
    }

    let n_bnd_total = n_outer + n_holes;
    let points: Vec<[f64; 3]> = mesh2d
        .points
        .iter()
        .enumerate()
        .map(|(i, p2d)| {
            let key = (p2d.x.to_bits(), p2d.y.to_bits());
            if i < n_outer {
                bnd_map
                    .get(&key)
                    .copied()
                    .unwrap_or_else(|| add(origin, add(scale(x_axis, p2d.x), scale(y_axis, p2d.y))))
            } else if i < n_bnd_total {
                hole_maps
                    .iter()
                    .find_map(|m| m.get(&key).copied())
                    .unwrap_or_else(|| add(origin, add(scale(x_axis, p2d.x), scale(y_axis, p2d.y))))
            } else {
                interior_3d[i - n_bnd_total]
            }
        })
        .collect();

    let triangles: Vec<[usize; 3]> = mesh2d.triangles.iter().map(|t| t.v).collect();
    Some(SurfaceMesh { points, triangles })
}

/// Tessellate a `SURFACE_OF_LINEAR_EXTRUSION` face using CDT with interior Steiner
/// points.  Boundary vertices come from the edge cache (hard constraints), so adjacent
/// faces share bitwise-identical positions and stitch perfectly.
fn try_tessellate_linear_extrusion(
    face: &TopoFace,
    edge_cache: &EdgeCache,
    file: &StepFile,
    opts: &TessOptions,
) -> Option<SurfaceMesh> {
    let e = file.get(&face.surface_id)?;
    if e.type_name != "SURFACE_OF_LINEAR_EXTRUSION" {
        return None;
    }

    // Parse the extrusion vector — needed to infer the v-range.
    // SURFACE_OF_LINEAR_EXTRUSION(label, swept_curve_ref, extrusion_axis_ref)
    let vec_id = get_ref(e, 2).ok()?;
    let vec_e = file.get(&vec_id)?;
    let dir_id = get_ref(vec_e, 1).ok()?;
    let magnitude = get_real(vec_e, 2).ok()?;
    let dir = normalize(point3(file, dir_id).ok()?);
    let extrusion = scale(dir, magnitude);
    let ext_len_sq = dot3(extrusion, extrusion);
    if ext_len_sq < 1e-20 {
        return None;
    }

    let surface = surface_from_step(face.surface_id, file).ok()?;
    let (u0, u1) = surface.u_bounds();
    if !u0.is_finite() || !u1.is_finite() {
        return None;
    }

    // ── Boundary setup ──────────────────────────────────────────────────────
    let boundary_3d = sample_boundary_cached(&face.outer_loop, edge_cache);
    if boundary_3d.len() < 3 {
        return None;
    }
    let normal = face_normal(&boundary_3d)?;
    let (bnd2d_raw, origin, x_axis, y_axis) = project_to_2d(&boundary_3d, normal);

    let bnd_map = build_bnd2d_map(&bnd2d_raw, &boundary_3d);

    let bnd2d = ensure_ccw(deduplicate_2d(bnd2d_raw));
    if bnd2d.len() < 3 || polygon_area_2d(&bnd2d).abs() < 1e-20 {
        return None;
    }

    // ── Holes ───────────────────────────────────────────────────────────────
    let holes_data: Vec<(Vec<[f64; 3]>, Vec<Point2>)> = face
        .inner_loops
        .iter()
        .filter_map(|inner| {
            let inner_3d = sample_boundary_cached(inner, edge_cache);
            if inner_3d.len() < 3 {
                return None;
            }
            let inner_2d: Vec<Point2> = inner_3d
                .iter()
                .map(|&p| {
                    let d = sub(p, origin);
                    Point2::new(dot3(d, x_axis), dot3(d, y_axis))
                })
                .collect();
            Some((inner_3d, inner_2d))
        })
        .collect();
    let hole_maps: Vec<HashMap<(u64, u64), [f64; 3]>> = holes_data
        .iter()
        .map(|(h3d, h2d)| build_bnd2d_map(h2d, h3d))
        .collect();
    let holes2d: Vec<Vec<Point2>> = holes_data.iter().map(|(_, h2d)| h2d.clone()).collect();
    let hole_slices: Vec<&[Point2]> = holes2d.iter().map(|h| h.as_slice()).collect();

    // ── Interior Steiner points from UV grid ────────────────────────────────
    // Infer v range from boundary projection onto the extrusion direction.
    let c_u0 = surface.point(u0, 0.0);
    let v_min = boundary_3d
        .iter()
        .map(|&p| dot3(sub(p, c_u0), extrusion) / ext_len_sq)
        .fold(f64::INFINITY, f64::min);
    let v_max = boundary_3d
        .iter()
        .map(|&p| dot3(sub(p, c_u0), extrusion) / ext_len_sq)
        .fold(f64::NEG_INFINITY, f64::max);
    if (v_max - v_min).abs() < 1e-10 {
        return None;
    }

    let v_mid = (v_min + v_max) / 2.0;
    let arc_u = sample_arc_length(|t| surface.point(t, v_mid), u0, u1, 32);
    let arc_v = magnitude * (v_max - v_min).abs();
    if arc_u < 1e-10 || arc_v < 1e-10 {
        return None;
    }

    let n_u = ((arc_u / opts.max_edge_len).ceil() as usize).clamp(2, 256) + 1;
    let n_v = ((arc_v / opts.max_edge_len).ceil() as usize).clamp(2, 256) + 1;

    let mut interior_3d: Vec<[f64; 3]> = Vec::new();
    let mut interior_2d: Vec<Point2> = Vec::new();
    for j in 0..n_v {
        let v = v_min + (v_max - v_min) * j as f64 / (n_v - 1) as f64;
        for i in 0..n_u {
            let u = u0 + (u1 - u0) * i as f64 / (n_u - 1) as f64;
            let p3d = surface.point(u, v);
            let d = sub(p3d, origin);
            let p2d = Point2::new(dot3(d, x_axis), dot3(d, y_axis));
            if point_in_polygon(p2d, &bnd2d) && !holes2d.iter().any(|h| point_in_polygon(p2d, h)) {
                interior_3d.push(p3d);
                interior_2d.push(p2d);
            }
        }
    }

    // ── CDT triangulation ───────────────────────────────────────────────────
    let (mesh2d, n_outer, n_holes) =
        match try_triangulate_with_interior(&bnd2d, &hole_slices, &interior_2d) {
            Ok(r) => r,
            Err(_) => return None,
        };

    if mesh2d.triangles.is_empty() {
        return None;
    }

    // ── Lift CDT points back to 3D ──────────────────────────────────────────
    let n_bnd_total = n_outer + n_holes;
    let points: Vec<[f64; 3]> = mesh2d
        .points
        .iter()
        .enumerate()
        .map(|(i, p2d)| {
            let key = (p2d.x.to_bits(), p2d.y.to_bits());
            if i < n_outer {
                bnd_map
                    .get(&key)
                    .copied()
                    .unwrap_or_else(|| add(origin, add(scale(x_axis, p2d.x), scale(y_axis, p2d.y))))
            } else if i < n_bnd_total {
                hole_maps
                    .iter()
                    .find_map(|m| m.get(&key).copied())
                    .unwrap_or_else(|| add(origin, add(scale(x_axis, p2d.x), scale(y_axis, p2d.y))))
            } else {
                interior_3d[i - n_bnd_total]
            }
        })
        .collect();

    let triangles: Vec<[usize; 3]> = mesh2d.triangles.iter().map(|t| t.v).collect();
    Some(SurfaceMesh { points, triangles })
}

/// Tessellate a flat annular disc (PLANE surface, single closed-circle outer loop,
/// single closed-circle inner loop) using a structured O-grid.
///
/// Generates one radial layer of quads between the outer ring (matched to the
/// outer barrel's n_u) and the inner ring, avoiding the solid-disc generation
/// that the general Bowyer-Watson path would produce for this case.
fn try_tessellate_annular_disc(
    face: &TopoFace,
    edge_cache: &EdgeCache,
    file: &StepFile,
    opts: &TessOptions,
) -> Option<SurfaceMesh> {
    // Only for PLANE surfaces with exactly one inner loop.
    let e = file.get(&face.surface_id)?;
    if e.type_name != "PLANE" {
        return None;
    }
    if face.inner_loops.len() != 1 {
        return None;
    }

    // Outer loop must be a single closed CIRCLE edge.
    if face.outer_loop.len() != 1 {
        return None;
    }
    let outer_edge = &face.outer_loop[0];
    if dist3(outer_edge.start, outer_edge.end) >= 1e-10 {
        return None;
    }
    let outer_circle_id = resolve_curve_id(file, outer_edge.curve_id);
    let outer_e = file.get(&outer_circle_id)?;
    if outer_e.type_name != "CIRCLE" {
        return None;
    }

    // Inner loop must also be a single closed CIRCLE edge.
    let inner_loop = &face.inner_loops[0];
    if inner_loop.len() != 1 {
        return None;
    }
    let inner_edge = &inner_loop[0];
    if dist3(inner_edge.start, inner_edge.end) >= 1e-10 {
        return None;
    }
    let inner_circle_id = resolve_curve_id(file, inner_edge.curve_id);
    let inner_e = file.get(&inner_circle_id)?;
    if inner_e.type_name != "CIRCLE" {
        return None;
    }

    let outer_ax_id = get_ref(outer_e, 1).ok()?;
    let outer_radius = get_real(outer_e, 2).ok()?;
    let axis = axis2_placement(file, outer_ax_id).ok()?;
    let y = axis.y();
    let inner_radius = get_real(inner_e, 2).ok()?;

    // Build rings from the edge cache in canonical (non-reversed) order so
    // positions are bitwise identical to any adjacent barrel that shares these
    // circle edges.  Winding is corrected by flip_winding_if afterwards.
    let outer_ring: Vec<[f64; 3]> = if let Some(cached) = edge_cache.get(&outer_edge.edge_id) {
        let nu = cached.len().saturating_sub(1).max(8);
        cached[..nu].to_vec()
    } else {
        let n_u = n_segs_for_arc(outer_radius, 2.0 * PI, opts).clamp(8, 512);
        (0..n_u)
            .map(|i| {
                let u = 2.0 * PI * i as f64 / n_u as f64;
                let radial = add(scale(axis.x, u.cos()), scale(y, u.sin()));
                add(axis.origin, scale(radial, outer_radius))
            })
            .collect()
    };

    let inner_ring: Vec<[f64; 3]> = if let Some(cached) = edge_cache.get(&inner_edge.edge_id) {
        let nu = cached.len().saturating_sub(1).max(8);
        cached[..nu].to_vec()
    } else {
        let n_u = outer_ring.len();
        (0..n_u)
            .map(|i| {
                let u = 2.0 * PI * i as f64 / n_u as f64;
                let radial = add(scale(axis.x, u.cos()), scale(y, u.sin()));
                add(axis.origin, scale(radial, inner_radius))
            })
            .collect()
    };

    let n_outer = outer_ring.len();
    let n_inner = inner_ring.len();
    if n_outer < 3 || n_inner < 3 {
        return None;
    }

    // Outer ring: indices 0..n_outer; inner ring: indices n_outer..n_outer+n_inner.
    let mut points = Vec::with_capacity(n_outer + n_inner);
    points.extend_from_slice(&outer_ring);
    points.extend_from_slice(&inner_ring);

    // Zipper triangulation: advance along whichever ring has its next vertex at a
    // smaller angular fraction of the full circle.  Produces n_outer + n_inner CCW
    // triangles that cover the full 360° annulus even when the two rings have
    // different vertex counts (different radii → different arc-length densities).
    //
    // Winding proof (both rings canonical CCW from above):
    //   Advance outer:  [outer[i], outer[i+1], inner[j]]  — cross-product +z  ✓
    //   Advance inner:  [outer[i], inner[j+1], inner[j]]  — cross-product +z  ✓
    let mut triangles = Vec::with_capacity(n_outer + n_inner);
    let mut i = 0usize; // outer advances completed
    let mut j = 0usize; // inner advances completed

    while i < n_outer || j < n_inner {
        let oi = i % n_outer;
        let oi_next = (i + 1) % n_outer;
        let ii = n_outer + j % n_inner;
        let ii_next = n_outer + (j + 1) % n_inner;

        let advance_outer = if i >= n_outer {
            false
        } else if j >= n_inner {
            true
        } else {
            // Advance outer when its next vertex arrives at a smaller angular fraction:
            // (i+1)/n_outer <= (j+1)/n_inner  ⟺  (i+1)*n_inner <= (j+1)*n_outer
            (i + 1) * n_inner <= (j + 1) * n_outer
        };

        if advance_outer {
            triangles.push([oi, oi_next, ii]);
            i += 1;
        } else {
            triangles.push([oi, ii_next, ii]);
            j += 1;
        }
    }

    Some(SurfaceMesh { points, triangles })
}

/// Tessellate a flat circular disc (PLANE surface with a single closed CIRCLE
/// outer boundary and no inner loops) using a center-fan layout.
///
/// This bypasses the general Bowyer-Watson path, which is numerically unstable
/// for cocircular inputs: all n_u boundary points lie on the same circle, so
/// every in-circumcircle test is degenerate and the triangulation goes wrong.
///
/// The boundary points are taken directly from the edge cache so they are
/// bitwise identical to the corresponding ring produced by
/// `try_tessellate_cylindrical`, guaranteeing zero-distance stitching.
fn try_tessellate_disc(
    face: &TopoFace,
    edge_cache: &EdgeCache,
    file: &StepFile,
    opts: &TessOptions,
) -> Option<SurfaceMesh> {
    // Only for PLANE surfaces with no inner loops.
    let e = file.get(&face.surface_id)?;
    if e.type_name != "PLANE" {
        return None;
    }
    if !face.inner_loops.is_empty() {
        return None;
    }

    // Only for single-edge outer loops with a closed CIRCLE.
    if face.outer_loop.len() != 1 {
        return None;
    }
    let edge = &face.outer_loop[0];
    if dist3(edge.start, edge.end) >= 1e-10 {
        return None;
    }

    // Read circle geometry — unwrap SURFACE_CURVE / SEAM_CURVE first.
    let circle_id = resolve_curve_id(file, edge.curve_id);
    let curve_e = file.get(&circle_id)?;
    if curve_e.type_name != "CIRCLE" {
        return None;
    }
    let ax_id = get_ref(curve_e, 1).ok()?;
    let radius = get_real(curve_e, 2).ok()?;
    let axis = axis2_placement(file, ax_id).ok()?;
    let y = axis.y();

    // Use cached ring in canonical (non-reversed) order so positions are
    // bitwise identical to the adjacent barrel's boundary row.  The fan
    // winding is corrected by flip_winding_if at the end of tessellate_face.
    let ring: Vec<[f64; 3]> = if let Some(cached) = edge_cache.get(&edge.edge_id) {
        let nu = cached.len().saturating_sub(1).max(8);
        cached[..nu].to_vec()
    } else {
        let n_u = n_segs_for_arc(radius, 2.0 * PI, opts).clamp(8, 512);
        (0..n_u)
            .map(|i| {
                let t = 2.0 * PI * i as f64 / n_u as f64;
                let radial = add(scale(axis.x, t.cos()), scale(y, t.sin()));
                add(axis.origin, scale(radial, radius))
            })
            .collect()
    };
    let n_u = ring.len();

    // Boundary ring + center point.
    let mut points = Vec::with_capacity(n_u + 1);
    points.extend_from_slice(&ring);

    // Center point (index n_u).
    points.push(axis.origin);
    let center = n_u;

    // Fan triangles: [center, i, (i+1)%n_u].
    // Winding: for the bottom cap (y = −Y, boundary goes CW from above) the
    // cross product points in −Z, matching the −Z outward normal.  For the top
    // cap (y = +Y, boundary goes CCW) it points in +Z.  Either way this is the
    // raw outward-pointing winding and tessellate_face applies flip_winding_if
    // on top.
    let mut triangles = Vec::with_capacity(n_u);
    for i in 0..n_u {
        triangles.push([center, i, (i + 1) % n_u]);
    }

    Some(SurfaceMesh { points, triangles })
}

/// Approximate arc length of a parametric curve `f(t)` over `[t0, t1]`
/// by sampling at `n` uniform intervals.
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

// ── Curve sampling ─────────────────────────────────────────────────────────────

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

        "SURFACE_CURVE" | "SEAM_CURVE" => {
            // Delegate to the embedded 3D curve.
            if let Ok(inner_id) = get_ref(entity, 1) {
                return curve_t_range(file, inner_id, start, end, reversed);
            }
            (0.0, 1.0)
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

/// Follow SURFACE_CURVE / SEAM_CURVE wrappers to the embedded 3D curve entity id.
fn resolve_curve_id(file: &StepFile, id: u64) -> u64 {
    if let Some(e) = file.get(&id) {
        if e.type_name == "SURFACE_CURVE" || e.type_name == "SEAM_CURVE" {
            if let Ok(inner) = get_ref(e, 1) {
                return inner;
            }
        }
    }
    id
}

/// Return the radius of a CIRCLE curve entity, or `None` for other curve types.
/// Unwraps SURFACE_CURVE / SEAM_CURVE container entities automatically.
fn circle_radius_from_curve(file: &StepFile, curve_id: u64) -> Option<f64> {
    let resolved = resolve_curve_id(file, curve_id);
    let entity = file.get(&resolved)?;
    if entity.type_name != "CIRCLE" {
        return None;
    }
    get_real(entity, 2).ok()
}

/// Arc length of a non-closed circular arc edge, or `None` for non-circle curves.
///
/// Uses `curve_t_range` to obtain the angular span and multiplies by the radius.
/// This is the quantity that `try_tessellate_cylindrical` uses (as `arc_u`) to
/// choose `n_u`, so matching on arc length ensures identical sample counts and
/// positions between the flat-face CDT boundary and the cylinder UV grid.
fn circle_arc_length(
    file: &StepFile,
    curve_id: u64,
    start: [f64; 3],
    end: [f64; 3],
    reversed: bool,
) -> Option<f64> {
    let resolved = resolve_curve_id(file, curve_id);
    let entity = file.get(&resolved)?;
    if entity.type_name != "CIRCLE" {
        return None;
    }
    let radius = get_real(entity, 2).ok()?;
    let (t0, t1) = curve_t_range(file, curve_id, start, end, reversed);
    Some(radius * (t1 - t0).abs())
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
///
/// Uses a spatial grid hash for O(n) average-case performance instead of the
/// naive O(n²) linear scan.
fn stitch(points: Vec<[f64; 3]>, triangles: Vec<[usize; 3]>, eps: f64) -> SurfaceMesh {
    use std::collections::HashMap;

    let eps2 = eps * eps;
    let n = points.len();
    let mut remap = vec![0usize; n];
    let mut unique: Vec<[f64; 3]> = Vec::new();

    // Grid cell size equals eps so that two points within eps must share a cell
    // or be in immediately adjacent cells (at most 3×3×3 = 27 to check).
    let cell_size = eps.max(1e-15);
    // Map from grid cell (ix, iy, iz) to the unique-point index stored there.
    let mut grid: HashMap<(i64, i64, i64), usize> = HashMap::new();

    let cell_coord = |v: f64| (v / cell_size).floor() as i64;

    for (i, &p) in points.iter().enumerate() {
        let cx = cell_coord(p[0]);
        let cy = cell_coord(p[1]);
        let cz = cell_coord(p[2]);

        let mut found = None;
        // Check the 3×3×3 neighbourhood.
        'outer: for dz in -1i64..=1 {
            for dy in -1i64..=1 {
                for dx in -1i64..=1 {
                    if let Some(&j) = grid.get(&(cx + dx, cy + dy, cz + dz)) {
                        let q = unique[j];
                        let d = sub(p, q);
                        if d[0] * d[0] + d[1] * d[1] + d[2] * d[2] <= eps2 {
                            found = Some(j);
                            break 'outer;
                        }
                    }
                }
            }
        }

        match found {
            Some(j) => remap[i] = j,
            None => {
                let j = unique.len();
                remap[i] = j;
                unique.push(p);
                grid.insert((cx, cy, cz), j);
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

/// Find approximate UV parameters for a 3D point that lies on a surface.
/// Uses a coarse grid search to find a good initial guess, then refines with
/// Gauss-Newton iterations.  Returns `None` if convergence fails.
fn invert_surface_uv(
    surface: &dyn crate::geom::surface::Surface,
    p3d: [f64; 3],
    u0: f64,
    u1: f64,
    v0: f64,
    v1: f64,
) -> Option<(f64, f64)> {
    const COARSE_N: usize = 12;
    const MAX_ITER: usize = 25;

    // Coarse grid search for the nearest UV grid point.
    let mut best_u = (u0 + u1) / 2.0;
    let mut best_v = (v0 + v1) / 2.0;
    let mut best_sq = {
        let d = sub(surface.point(best_u, best_v), p3d);
        dot3(d, d)
    };
    for j in 0..=COARSE_N {
        let v = v0 + (v1 - v0) * j as f64 / COARSE_N as f64;
        for i in 0..=COARSE_N {
            let u = u0 + (u1 - u0) * i as f64 / COARSE_N as f64;
            let d = sub(surface.point(u, v), p3d);
            let sq = dot3(d, d);
            if sq < best_sq {
                best_sq = sq;
                best_u = u;
                best_v = v;
            }
        }
    }

    // Gauss-Newton refinement.
    let mut u = best_u;
    let mut v = best_v;
    let eu = (u1 - u0) * 1e-5;
    let ev = (v1 - v0) * 1e-5;
    for _ in 0..MAX_ITER {
        let p = surface.point(u, v);
        let diff = sub(p3d, p);
        if dot3(diff, diff) < 1e-16 {
            break;
        }

        let pu = surface.point((u + eu).min(u1), v);
        let pm = surface.point((u - eu).max(u0), v);
        let h_u = (u + eu).min(u1) - (u - eu).max(u0);
        let su = scale(sub(pu, pm), 1.0 / h_u);

        let pv = surface.point(u, (v + ev).min(v1));
        let qv = surface.point(u, (v - ev).max(v0));
        let h_v = (v + ev).min(v1) - (v - ev).max(v0);
        let sv = scale(sub(pv, qv), 1.0 / h_v);

        let a11 = dot3(su, su);
        let a12 = dot3(su, sv);
        let a22 = dot3(sv, sv);
        let b1 = dot3(su, diff);
        let b2 = dot3(sv, diff);

        let det = a11 * a22 - a12 * a12;
        if det.abs() < 1e-30 {
            break;
        }
        u = (u + (a22 * b1 - a12 * b2) / det).clamp(u0, u1);
        v = (v + (a11 * b2 - a12 * b1) / det).clamp(v0, v1);
    }

    let d = sub(surface.point(u, v), p3d);
    // Accept if the residual is small relative to the UV domain span.
    if dot3(d, d) < 0.01 {
        Some((u, v))
    } else {
        None
    }
}
