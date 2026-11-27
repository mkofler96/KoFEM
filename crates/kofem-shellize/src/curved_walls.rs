// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Curved thin walls: a tube, or a sheet-metal bend. [`crate::walls`] pairs
//! only opposite PLANAR faces, which is what the shell idealisation can
//! collapse to a mid-surface. A curved wall locks linear tets in bending just
//! the same, so the linear thin-wall check (KOF-312) also measures these.
//!
//! Each curved face is sampled at up to [`SAMPLES`] of its surface triangles:
//! a ray from the triangle's centroid goes into the material, and the first
//! surface triangle it meets is the opposite side. A face is a wall when most
//! rays reach ONE other face of the body within `max_wall`, at a steady
//! distance (an offset surface), arriving square to it. The linear thin-wall
//! check measures these walls, and the shell idealisation collapses them to a
//! mid-surface ([`crate::mid_surface`]).

use std::collections::{HashMap, HashSet};

use kofem_fem::count_as_f64;

use crate::geometry::{
    add, cross, dot, norm, scale, sub, tet_face, triangle_key, ShellizeMesh, Vec3, TET_FACES,
};
use crate::walls::{detect_walls, face_props, FaceProp, PairedWall, PLANAR};

/// A curved thin wall: the sampled `face`, the `partner` face opposite it, the
/// median distance between them and the body.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CurvedWall {
    pub face: i32,
    pub partner: i32,
    pub thickness: f64,
    pub body: i32,
}

/// Rays cast per face; a face with fewer triangles casts one per triangle.
const SAMPLES: usize = 64;
/// Share of a face's rays that must reach the same partner face.
const MIN_AGREEMENT: f64 = 0.6;
/// Spread of the partner distances (10th to 90th percentile) allowed, as a
/// share of their median: an offset surface keeps the gap steady.
const MAX_SPREAD: f64 = 0.25;
/// The ray must meet the partner within this angle of square (|cos| ≥ 0.85,
/// as the planar pass requires of opposite normals).
const MIN_ALIGNMENT: f64 = 0.85;

struct Triangle {
    index: usize,
    corners: [Vec3; 3],
    face: i32,
    /// Unit normal of the flat triangle into the material.
    inward: Vec3,
    /// Unit normal at each corner into the material: the area-weighted mean
    /// of the inward normals of the face's triangles there.
    normals: [Vec3; 3],
}

impl Triangle {
    /// How far the curved surface lies from this flat triangle at the
    /// barycentric point `weights`, along the corner normals (positive into
    /// the material): the quadratic patch through the corners with the
    /// corner normals, (1/2)·Σ_{i<j} λᵢλⱼ·(nⱼ − nᵢ)·(pⱼ − pᵢ), signed so a
    /// convex face, which bulges out of its chords, reads negative.
    fn sag(&self, weights: [f64; 3]) -> f64 {
        let mut offset = 0.0;
        for (first, second) in [(0, 1), (1, 2), (2, 0)] {
            offset += 0.5
                * weights[first]
                * weights[second]
                * dot(
                    sub(self.normals[second], self.normals[first]),
                    sub(self.corners[second], self.corners[first]),
                );
        }
        offset
    }
}

/// Distance along `direction` (unit) from `origin` to the triangle and the
/// barycentric weights of the point it meets, if the ray meets it in front of
/// the origin (Möller–Trumbore).
fn ray_hit(origin: Vec3, direction: Vec3, corners: [Vec3; 3]) -> Option<(f64, [f64; 3])> {
    let edge_a = sub(corners[1], corners[0]);
    let edge_b = sub(corners[2], corners[0]);
    let normal_b = cross(direction, edge_b);
    let det = dot(edge_a, normal_b);
    if det.abs() <= 1e-12 * norm(edge_a) * norm(edge_b) {
        return None;
    }
    let inv = 1.0 / det;
    let offset = sub(origin, corners[0]);
    let along_a = dot(offset, normal_b) * inv;
    if !(-1e-9..=1.0 + 1e-9).contains(&along_a) {
        return None;
    }
    let normal_a = cross(offset, edge_a);
    let along_b = dot(direction, normal_a) * inv;
    if along_b < -1e-9 || along_a + along_b > 1.0 + 1e-9 {
        return None;
    }
    let distance = dot(edge_b, normal_a) * inv;
    (distance > 0.0).then_some((distance, [1.0 - along_a - along_b, along_a, along_b]))
}

fn centroid(corners: [Vec3; 3]) -> Vec3 {
    scale(
        [0, 1, 2].map(|axis| corners[0][axis] + corners[1][axis] + corners[2][axis]),
        1.0 / 3.0,
    )
}

fn triangle_normal(corners: [Vec3; 3]) -> Option<Vec3> {
    let raw = cross(sub(corners[1], corners[0]), sub(corners[2], corners[0]));
    let length = norm(raw);
    (length > 0.0).then(|| scale(raw, 1.0 / length))
}

/// Value at quantile `share` of sorted `values`.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "an index into a short, non-empty list"
)]
fn quantile(values: &[f64], share: f64) -> f64 {
    values[(count_as_f64(values.len() - 1) * share).round() as usize]
}

/// One ray into the material: the surface triangle it starts from, its origin
/// (that triangle's centroid) and its unit direction.
#[derive(Clone, Copy)]
struct Ray {
    source: usize,
    origin: Vec3,
    inward: Vec3,
}

/// The surface triangles of each body, and the rays of each candidate face.
struct Sampling {
    by_body: HashMap<i32, Vec<Triangle>>,
    rays: HashMap<i32, Vec<Ray>>,
}

/// A surface triangle with its body and its unit normal into the material.
struct Flat {
    index: usize,
    body: i32,
    face: i32,
    corners: [Vec3; 3],
    vertices: [usize; 3],
    inward: Vec3,
}

fn sample(mesh: &ShellizeMesh, candidates: &HashSet<i32>) -> Sampling {
    // Each surface triangle's inward direction: towards the fourth vertex of
    // the tet it bounds. Winding is not trusted.
    let mut inside: HashMap<[usize; 3], (usize, i32)> = HashMap::new();
    for (element, &tet) in mesh.tets.iter().enumerate() {
        for face in TET_FACES {
            // Corners are 0..=3, so the one a face leaves out is 6 − Σ face.
            let opposite = tet[6 - face.iter().sum::<usize>()];
            inside.insert(tet_face(tet, face).1, (opposite, mesh.body[element]));
        }
    }
    // Each surface triangle with its body and inward normal; the corner
    // normals of each face, area-weighted, from them.
    let mut flats: Vec<Flat> = Vec::new();
    let mut corner_normals: HashMap<(i32, usize), Vec3> = HashMap::new();
    for (index, &tri) in mesh.surf_tris.iter().enumerate() {
        let Some(&(opposite, body)) = inside.get(&triangle_key(tri)) else {
            continue;
        };
        let corners = tri.map(|vertex| mesh.vertices[vertex]);
        let Some(normal) = triangle_normal(corners) else {
            continue;
        };
        let inward = if dot(normal, sub(mesh.vertices[opposite], centroid(corners))) > 0.0 {
            normal
        } else {
            scale(normal, -1.0)
        };
        let area = 0.5
            * norm(cross(
                sub(corners[1], corners[0]),
                sub(corners[2], corners[0]),
            ));
        let face = mesh.surf_face[index];
        for &vertex in &tri {
            let sum = corner_normals.entry((face, vertex)).or_insert([0.0; 3]);
            *sum = [0, 1, 2].map(|axis| sum[axis] + area * inward[axis]);
        }
        flats.push(Flat {
            index,
            body,
            face,
            corners,
            vertices: tri,
            inward,
        });
    }
    let unit = |sum: Vec3| {
        let length = norm(sum);
        if length > 0.0 {
            scale(sum, 1.0 / length)
        } else {
            sum
        }
    };
    let mut sampling = Sampling {
        by_body: HashMap::new(),
        rays: HashMap::new(),
    };
    for flat in flats {
        let triangle = Triangle {
            index: flat.index,
            corners: flat.corners,
            face: flat.face,
            inward: flat.inward,
            normals: flat
                .vertices
                .map(|vertex| unit(corner_normals[&(flat.face, vertex)])),
        };
        // The ray starts on the curved surface, not on the flat triangle,
        // which a curved face's chords cut by the sag.
        let origin = add(
            centroid(flat.corners),
            scale(flat.inward, triangle.sag([1.0 / 3.0; 3])),
        );
        let face = flat.face;
        sampling
            .by_body
            .entry(flat.body)
            .or_default()
            .push(triangle);
        if candidates.contains(&face) {
            sampling.rays.entry(face).or_default().push(Ray {
                source: flat.index,
                origin,
                inward: flat.inward,
            });
        }
    }
    sampling
}

/// The face a ray from `face` first meets square-on within `max_wall`, and
/// the distance: `None` when it meets nothing, its own face, or a face at a
/// slant.
fn opposite(ray: Ray, face: i32, triangles: &[Triangle], max_wall: f64) -> Option<(i32, f64)> {
    let mut nearest: Option<(f64, [f64; 3], &Triangle)> = None;
    for triangle in triangles {
        if triangle.index == ray.source {
            continue;
        }
        if let Some((distance, weights)) = ray_hit(ray.origin, ray.inward, triangle.corners) {
            if nearest.is_none_or(|(best, _, _)| distance < best) {
                nearest = Some((distance, weights, triangle));
            }
        }
    }
    let (flat_distance, weights, hit) = nearest?;
    // To the curved surface behind the flat triangle the ray met.
    let distance = flat_distance + hit.sag(weights) * dot(hit.inward, ray.inward);
    if hit.face == face || distance > max_wall {
        return None;
    }
    let square = dot(triangle_normal(hit.corners)?, ray.inward).abs() >= MIN_ALIGNMENT;
    square.then_some((hit.face, distance))
}

/// The wall behind `face`: up to [`SAMPLES`] of its rays must mostly reach one
/// partner face at a steady distance.
fn measure(
    face: i32,
    body: i32,
    rays: &[Ray],
    triangles: &[Triangle],
    max_wall: f64,
) -> Option<CurvedWall> {
    let stride = rays.len().div_ceil(SAMPLES);
    let cast: Vec<Ray> = rays.iter().step_by(stride).copied().collect();
    let mut hits: HashMap<i32, Vec<f64>> = HashMap::new();
    for &ray in &cast {
        if let Some((partner, distance)) = opposite(ray, face, triangles, max_wall) {
            hits.entry(partner).or_default().push(distance);
        }
    }
    let (partner, mut distances) = hits
        .into_iter()
        .max_by(|left, right| left.1.len().cmp(&right.1.len()).then(right.0.cmp(&left.0)))?;
    let agreement = count_as_f64(distances.len()) / count_as_f64(cast.len());
    if agreement < MIN_AGREEMENT {
        return None;
    }
    distances.sort_by(f64::total_cmp);
    let median = quantile(&distances, 0.5);
    if quantile(&distances, 0.9) - quantile(&distances, 0.1) > MAX_SPREAD * median {
        return None;
    }
    Some(CurvedWall {
        face,
        partner,
        thickness: median,
        body,
    })
}

/// The curved thin walls of every body, each wall reported once (by the larger
/// of its two faces). Faces the planar pass pairs, planar faces, and faces
/// under 1 % of the largest face are not sampled, as in [`crate::walls`].
#[must_use]
pub fn detect_curved_walls(mesh: &ShellizeMesh, max_wall: f64) -> Vec<CurvedWall> {
    let faces = face_props(mesh);
    let planar = detect_walls(mesh, &faces, max_wall);
    curved_walls(mesh, &faces, &planar, max_wall)
}

/// [`detect_curved_walls`] over the measured `faces` (largest first), leaving
/// out the faces of the `planar` walls.
pub(crate) fn curved_walls(
    mesh: &ShellizeMesh,
    faces: &[FaceProp],
    planar: &[PairedWall],
    max_wall: f64,
) -> Vec<CurvedWall> {
    let Some(largest) = faces.first() else {
        return Vec::new();
    };
    let paired: HashSet<i32> = planar
        .iter()
        .flat_map(|paired| std::iter::once(paired.wall.keep).chain(paired.partners.iter().copied()))
        .collect();
    let candidates: HashSet<i32> = faces
        .iter()
        .filter(|face| face.body.is_some() && face.flat < PLANAR && face.area > 0.01 * largest.area)
        .filter(|face| !paired.contains(&face.id))
        .map(|face| face.id)
        .collect();
    let sampling = sample(mesh, &candidates);
    let mut walls: Vec<CurvedWall> = Vec::new();
    // Largest face first, so a wall is reported by its larger face.
    for face in faces {
        let (Some(body), Some(rays)) = (face.body, sampling.rays.get(&face.id)) else {
            continue;
        };
        if walls.iter().any(|wall| wall.partner == face.id) {
            continue;
        }
        let triangles = &sampling.by_body[&body];
        if let Some(mut wall) = measure(face.id, body, rays, triangles, max_wall) {
            // Measured back from the partner as well: a ray starts at a
            // triangle centroid, which lies inside a curved surface by the
            // chord sag, and ends on a chord; from both faces the two sags
            // cancel to first order.
            let back = sampling
                .rays
                .get(&wall.partner)
                .and_then(|partner_rays| {
                    measure(wall.partner, body, partner_rays, triangles, max_wall)
                })
                .filter(|back| back.partner == face.id);
            if let Some(back) = back {
                wall.thickness = f64::midpoint(wall.thickness, back.thickness);
            }
            walls.push(wall);
        }
    }
    walls
}
