// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Curved thin walls collapse to a mid-surface (KOF-448): a cylindrical panel,
//! a sphere segment, a cylinder joined tangentially to a spherical cap, and a
//! sheet-metal bend between two flat legs. Each node of the kept face moves
//! half the wall thickness along its own normal, so the shell lies on the mid
//! surface of the curved wall, not on a plane through it.

#![allow(
    clippy::expect_used,
    clippy::cast_precision_loss,
    reason = "test fixtures: a fixture that fails to build should abort the test, and grid \
              indices are small"
)]

use std::collections::{BTreeSet, HashMap};
use std::f64::consts::PI;

use kofem_shellize::geometry::{cross, dot, sub, tet_mesh_boundary, Vec3};
use kofem_shellize::{
    extract_thin_wall_shells, shell_body_tets, ExtractOptions, ShellExtraction, ShellizeError,
    ShellizeMesh,
};

/// Six tets per grid cell (Kuhn), corners numbered w + 2·u + 4·v.
const KUHN: [[usize; 4]; 6] = [
    [0, 1, 3, 7],
    [0, 3, 2, 7],
    [0, 2, 6, 7],
    [0, 6, 4, 7],
    [0, 4, 5, 7],
    [0, 5, 1, 7],
];

/// Grid indices of a vertex: through the wall (w), across (u), along (v).
type Index = [usize; 3];

/// A structured tet mesh over a mapped (w, u, v) grid of `cells`, body 1:
/// `present` picks the cells, `point` places each grid vertex (the map must
/// keep (w, u, v) right-handed) and `label` names the CAD face of each
/// boundary triangle from its corners' grid indices.
fn mapped_mesh(
    cells: Index,
    present: impl Fn(Index) -> bool,
    point: impl Fn(Index) -> Vec3,
    label: impl Fn([Index; 3]) -> i32,
) -> ShellizeMesh {
    let [nw, nu, nv] = cells;
    let id = |[layer, around, along]: Index| layer + (nw + 1) * (around + (nu + 1) * along);
    let mut indices = vec![[0; 3]; (nw + 1) * (nu + 1) * (nv + 1)];
    let mut vertices = vec![0.0; 3 * indices.len()];
    for along in 0..=nv {
        for around in 0..=nu {
            for layer in 0..=nw {
                let vertex = id([layer, around, along]);
                indices[vertex] = [layer, around, along];
                vertices[3 * vertex..3 * vertex + 3]
                    .copy_from_slice(&point([layer, around, along]));
            }
        }
    }
    let mut tets: Vec<[usize; 4]> = Vec::new();
    for along in 0..nv {
        for around in 0..nu {
            for layer in 0..nw {
                if !present([layer, around, along]) {
                    continue;
                }
                let corner =
                    |bits: usize| id([layer + bits % 2, around + (bits / 2) % 2, along + bits / 4]);
                tets.extend(KUHN.map(|tet| tet.map(corner)));
            }
        }
    }
    // Each boundary triangle wound outward, away from its tet's fourth corner,
    // as Netgen winds a surface mesh.
    let point_of = |vertex: usize| -> Vec3 {
        [
            vertices[3 * vertex],
            vertices[3 * vertex + 1],
            vertices[3 * vertex + 2],
        ]
    };
    let mut fourth: HashMap<[usize; 3], usize> = HashMap::new();
    for tet in &tets {
        for skip in 0..4 {
            let mut key: Vec<usize> = (0..4).filter(|&k| k != skip).map(|k| tet[k]).collect();
            key.sort_unstable();
            fourth.insert([key[0], key[1], key[2]], tet[skip]);
        }
    }
    let surface: Vec<[usize; 3]> = tet_mesh_boundary(&tets)
        .into_iter()
        .map(|tri| {
            let mut key = tri;
            key.sort_unstable();
            let corners = tri.map(point_of);
            let normal = cross(sub(corners[1], corners[0]), sub(corners[2], corners[0]));
            let inward = sub(point_of(fourth[&key]), corners[0]);
            if dot(normal, inward) > 0.0 {
                [tri[0], tri[2], tri[1]]
            } else {
                tri
            }
        })
        .collect();
    let faces: Vec<i32> = surface
        .iter()
        .map(|tri| label(tri.map(|vertex| indices[vertex])))
        .collect();
    let flat = |groups: Vec<u32>| groups;
    let to_u32 = |vertex: usize| u32::try_from(vertex).expect("small mesh");
    ShellizeMesh::new(
        &vertices,
        &flat(tets.iter().flatten().copied().map(to_u32).collect()),
        &vec![1; tets.len()],
        &flat(surface.iter().flatten().copied().map(to_u32).collect()),
        &faces,
    )
    .expect("mapped mesh")
}

fn all(corners: [Index; 3], axis: usize, value: usize) -> bool {
    corners.iter().all(|corner| corner[axis] == value)
}

fn extract(mesh: &ShellizeMesh) -> Result<ShellExtraction, ShellizeError> {
    extract_thin_wall_shells(
        mesh,
        &ExtractOptions {
            max_wall: 15.0,
            shell_body_ids: Some(vec![1]),
        },
    )
}

fn nodes_of_face(mesh: &ShellizeMesh, face: i32) -> BTreeSet<usize> {
    mesh.surface_triangles()
        .iter()
        .zip(mesh.surface_faces())
        .filter(|&(_, &id)| id == face)
        .flat_map(|(tri, _)| tri.iter().copied())
        .collect()
}

fn radius_xy(point: Vec3) -> f64 {
    point[0].hypot(point[1])
}

fn length(point: Vec3) -> f64 {
    (point[0] * point[0] + point[1] * point[1] + point[2] * point[2]).sqrt()
}

// ── Cylindrical panel ─────────────────────────────────────────────────────────

/// Faces of the cylindrical panel and the sphere segment.
const OUTER: i32 = 1;
const INNER: i32 = 2;
const SIDE_START: i32 = 3;

const MID_RADIUS: f64 = 1000.0;
const PANEL_THICKNESS: f64 = 10.0;

/// A 30° cylindrical panel about z, r = 995…1005 mm (t = 10 mm, mid radius
/// 1000 mm), 500 mm long: 2 layers through the wall, 12 cells around, 10 along.
/// Faces: 1 outer, 2 inner, 3 side θ = 0, 4 side θ = 30°, 5 end z = 0,
/// 6 end z = 500.
fn cylindrical_panel() -> ShellizeMesh {
    let cells = [2, 12, 10];
    mapped_mesh(
        cells,
        |_| true,
        |[layer, around, along]| {
            let radius = MID_RADIUS - PANEL_THICKNESS / 2.0 + PANEL_THICKNESS * layer as f64 / 2.0;
            let angle = PI / 6.0 * around as f64 / 12.0;
            [
                radius * angle.cos(),
                radius * angle.sin(),
                50.0 * along as f64,
            ]
        },
        |corners| {
            if all(corners, 2, 0) {
                5
            } else if all(corners, 2, cells[2]) {
                6
            } else if all(corners, 1, 0) {
                SIDE_START
            } else if all(corners, 1, cells[1]) {
                4
            } else if all(corners, 0, cells[0]) {
                OUTER
            } else {
                INNER
            }
        },
    )
}

/// Every shell node lies on the mid surface, r = 1000 mm, within 1 % of t.
#[test]
fn cylindrical_panel_collapses_to_its_mid_radius() {
    let shells = extract(&cylindrical_panel()).expect("extraction");
    assert_eq!(shells.shell_body, Some(1));
    assert_ne!(shells.vertices.len(), 0);
    for vertex in &shells.vertices {
        let off = (radius_xy(*vertex) - MID_RADIUS).abs();
        assert!(off < 0.01 * PANEL_THICKNESS, "{vertex:?} is {off} mm off");
    }
}

/// Every facet carries the wall thickness.
#[test]
fn cylindrical_panel_facets_carry_the_wall_thickness() {
    let shells = extract(&cylindrical_panel()).expect("extraction");
    assert_ne!(shells.thicknesses.len(), 0);
    for &thickness in &shells.thicknesses {
        assert!(
            (thickness - PANEL_THICKNESS).abs() < 0.01 * PANEL_THICKNESS,
            "{thickness}"
        );
    }
}

/// One wall, kept on its outer (convex) face: one shell node per node of it.
#[test]
fn cylindrical_panel_keeps_one_node_per_outer_face_node() {
    let mesh = cylindrical_panel();
    let shells = extract(&mesh).expect("extraction");
    assert_eq!(shells.walls.len(), 1, "{:?}", shells.walls);
    assert_eq!(shells.walls[0].keep, OUTER);
    assert_eq!(shells.vertices.len(), nodes_of_face(&mesh, OUTER).len());
    assert!(shells.triangle_source.iter().all(|&face| face == OUTER));
}

/// A support on the side face θ = 0 reaches the shell's rim: every node of
/// that face is nearest to a shell node on the rim, and every rim node is hit.
#[test]
fn cylindrical_panel_side_face_maps_onto_the_rim() {
    let mesh = cylindrical_panel();
    let shells = extract(&mesh).expect("extraction");
    let mut hit: BTreeSet<usize> = BTreeSet::new();
    for node in nodes_of_face(&mesh, SIDE_START) {
        let point = mesh.vertices()[node];
        let nearest = (0..shells.vertices.len())
            .min_by(|&left, &right| {
                let distance = |index: usize| {
                    let shell: Vec3 = shells.vertices[index];
                    length([0, 1, 2].map(|axis| shell[axis] - point[axis]))
                };
                distance(left).total_cmp(&distance(right))
            })
            .expect("shell nodes");
        let rim = shells.vertices[nearest];
        // On the side plane y = 0 (θ = 0), to within 5 % of t.
        assert!(rim[1].abs() < 0.05 * PANEL_THICKNESS, "{rim:?}");
        hit.insert(nearest);
    }
    // The 11 rim nodes along z.
    assert_eq!(hit.len(), 11);
}

/// The wall names its partner face, and every facet is wound along the kept
/// face's outward normal (here: radially out), so a pressure on either face
/// can be put on the facets with the right sign — whichever way the surface
/// mesh is wound.
#[test]
fn cylindrical_panel_facets_face_out_of_the_kept_face() {
    let outward = cylindrical_panel();
    let inward = rewound(&outward);
    for mesh in [outward, inward] {
        let shells = extract(&mesh).expect("extraction");
        assert_eq!(shells.walls[0].partner, INNER);
        assert_facets_face_radially_out(&shells);
    }
}

/// `mesh` with every surface triangle wound the other way.
fn rewound(mesh: &ShellizeMesh) -> ShellizeMesh {
    let to_u32 = |vertex: usize| u32::try_from(vertex).expect("small mesh");
    let vertices: Vec<f64> = mesh.vertices().iter().flatten().copied().collect();
    let tets: Vec<u32> = mesh.tets().iter().flatten().copied().map(to_u32).collect();
    let triangles: Vec<u32> = mesh
        .surface_triangles()
        .iter()
        .flat_map(|tri| [tri[0], tri[2], tri[1]])
        .map(to_u32)
        .collect();
    ShellizeMesh::new(
        &vertices,
        &tets,
        mesh.body(),
        &triangles,
        mesh.surface_faces(),
    )
    .expect("rewound mesh")
}

fn assert_facets_face_radially_out(shells: &ShellExtraction) {
    for tri in &shells.triangles {
        let [first, second, third] = tri.map(|node| shells.vertices[node]);
        let normal = cross(sub(second, first), sub(third, first));
        let centroid = [0, 1, 2].map(|axis| (first[axis] + second[axis] + third[axis]) / 3.0);
        let radial = [centroid[0], centroid[1], 0.0];
        assert!(dot(normal, radial) > 0.0, "{tri:?} faces inward");
    }
}

/// The shells replace every tet of the panel: none is left uncovered.
#[test]
fn cylindrical_panel_is_fully_covered() {
    let mesh = cylindrical_panel();
    let shells = extract(&mesh).expect("extraction");
    let tets = shell_body_tets(&mesh, &shells).expect("fully covered");
    assert_eq!(tets.len(), mesh.tets().len());
}

// ── Sphere segment ────────────────────────────────────────────────────────────

/// A sphere segment about the origin, r = 995…1005 mm, polar angle 30°…60°,
/// azimuth 0…30°: 2 layers, 10 × 10 cells. Faces as the panel's: 1 outer,
/// 2 inner, 3…6 the four cut faces.
fn sphere_segment() -> ShellizeMesh {
    let cells = [2, 10, 10];
    mapped_mesh(
        cells,
        |_| true,
        |[layer, around, along]| {
            let radius = MID_RADIUS - PANEL_THICKNESS / 2.0 + PANEL_THICKNESS * layer as f64 / 2.0;
            let polar = PI / 6.0 + PI / 6.0 * around as f64 / 10.0;
            let azimuth = PI / 6.0 * along as f64 / 10.0;
            [
                radius * polar.sin() * azimuth.cos(),
                radius * polar.sin() * azimuth.sin(),
                radius * polar.cos(),
            ]
        },
        |corners| {
            if all(corners, 2, 0) {
                5
            } else if all(corners, 2, cells[2]) {
                6
            } else if all(corners, 1, 0) {
                SIDE_START
            } else if all(corners, 1, cells[1]) {
                4
            } else if all(corners, 0, cells[0]) {
                OUTER
            } else {
                INNER
            }
        },
    )
}

/// Every shell node of the sphere segment lies on the mid sphere, every facet
/// carries t, and the outer face's nodes are the shell's nodes.
#[test]
fn sphere_segment_collapses_to_its_mid_sphere() {
    let mesh = sphere_segment();
    let shells = extract(&mesh).expect("extraction");
    assert_eq!(shells.walls.len(), 1, "{:?}", shells.walls);
    assert_eq!(shells.walls[0].keep, OUTER);
    assert_eq!(shells.vertices.len(), nodes_of_face(&mesh, OUTER).len());
    for vertex in &shells.vertices {
        let off = (length(*vertex) - MID_RADIUS).abs();
        assert!(off < 0.01 * PANEL_THICKNESS, "{vertex:?} is {off} mm off");
    }
    for &thickness in &shells.thicknesses {
        assert!(
            (thickness - PANEL_THICKNESS).abs() < 0.01 * PANEL_THICKNESS,
            "{thickness}"
        );
    }
    let tets = shell_body_tets(&mesh, &shells).expect("fully covered");
    assert_eq!(tets.len(), mesh.tets().len());
}

// ── Cylinder with a tangent spherical cap ─────────────────────────────────────

/// A quarter cylinder (z = −300…0) running tangentially into a quarter sphere
/// cap (latitude 0…72°, an 18° polar hole), r = 995…1005 mm. v runs along the
/// meridian: 6 cells on the cylinder, 8 on the cap. Faces: 1 outer cylinder,
/// 2 outer cap, 3 inner cylinder, 4 inner cap, 5…8 the cuts and ends.
fn capsule() -> ShellizeMesh {
    let cells = [2, 9, 14];
    let on_cylinder = 6;
    mapped_mesh(
        cells,
        |_| true,
        |[layer, around, along]| {
            let radius = MID_RADIUS - PANEL_THICKNESS / 2.0 + PANEL_THICKNESS * layer as f64 / 2.0;
            // u runs around: azimuth 90° → 0, so (r, azimuth, meridian) stays
            // right-handed with v climbing the meridian.
            let azimuth = PI / 2.0 * (1.0 - around as f64 / 9.0);
            let (ring, height) = if along <= on_cylinder {
                (radius, -300.0 + 50.0 * along as f64)
            } else {
                let latitude = 0.4 * PI * (along - on_cylinder) as f64 / 8.0;
                (radius * latitude.cos(), radius * latitude.sin())
            };
            [ring * azimuth.cos(), ring * azimuth.sin(), height]
        },
        |corners| {
            let cap = corners.iter().any(|corner| corner[2] > on_cylinder);
            if all(corners, 2, 0) {
                5
            } else if all(corners, 2, cells[2]) {
                6
            } else if all(corners, 1, 0) {
                7
            } else if all(corners, 1, cells[1]) {
                8
            } else if all(corners, 0, cells[0]) {
                if cap {
                    2
                } else {
                    1
                }
            } else if cap {
                4
            } else {
                3
            }
        },
    )
}

/// The cylinder and the cap are two walls, both kept on their outer faces,
/// welded along the tangent ring into one sheet on the mid surface.
#[test]
fn tangent_cylinder_and_cap_weld_on_the_mid_surface() {
    let mesh = capsule();
    let shells = extract(&mesh).expect("extraction");
    let kept: BTreeSet<i32> = shells.walls.iter().map(|wall| wall.keep).collect();
    assert_eq!(kept, BTreeSet::from([1, 2]), "{:?}", shells.walls);
    let outer: BTreeSet<usize> = nodes_of_face(&mesh, 1)
        .union(&nodes_of_face(&mesh, 2))
        .copied()
        .collect();
    // The ring nodes are shared, not doubled.
    assert_eq!(shells.vertices.len(), outer.len());
    for vertex in &shells.vertices {
        let mid = if vertex[2] <= 1e-9 {
            radius_xy(*vertex)
        } else {
            length(*vertex)
        };
        let off = (mid - MID_RADIUS).abs();
        assert!(off < 0.01 * PANEL_THICKNESS, "{vertex:?} is {off} mm off");
    }
    // The ring nodes carry facets of both walls.
    let ring: Vec<usize> = (0..shells.vertices.len())
        .filter(|&node| shells.vertices[node][2].abs() < 1e-9)
        .collect();
    assert_eq!(ring.len(), 10);
    for node in ring {
        let sources: BTreeSet<i32> = shells
            .triangles
            .iter()
            .zip(&shells.triangle_source)
            .filter(|(tri, _)| tri.contains(&node))
            .map(|(_, &source)| source)
            .collect();
        assert_eq!(sources, BTreeSet::from([1, 2]), "ring node {node}");
    }
}

// ── Sheet-metal bend between two flat legs ────────────────────────────────────

const BEND_INNER: f64 = 20.0;
const SHEET: f64 = 2.0;

/// An L-bracket of 2 mm sheet, 40 mm wide (y): a leg down along x = ρ, a
/// quarter bend about the y axis (ρ = 20…22 mm) and a leg along −x at z = ρ.
/// `slant` lengthens the inner side of each leg's end, so the flat legs'
/// inner faces are the larger ones. Faces: 1 leg-1 outer, 2 bend outer,
/// 3 leg-2 outer, 4 leg-1 inner, 5 bend inner, 6 leg-2 inner, 7 y = 0,
/// 8 y = 40, 9 leg-1 end, 10 leg-2 end.
fn bend(slant: f64) -> ShellizeMesh {
    let (leg, arc) = (5, 6);
    let cells = [1, 4, 2 * leg + arc];
    let flat = 30.0;
    mapped_mesh(
        cells,
        |_| true,
        |[layer, around, along]| {
            let rho = BEND_INNER + SHEET * layer as f64;
            let width = 10.0 * around as f64;
            let reach = flat + slant * (1 - layer) as f64;
            if along <= leg {
                // Leg 1, climbing towards the bend at z = 0.
                [rho, width, -reach * (1.0 - along as f64 / leg as f64)]
            } else if along <= leg + arc {
                let angle = PI / 2.0 * (along - leg) as f64 / arc as f64;
                [rho * angle.cos(), width, rho * angle.sin()]
            } else {
                [-reach * (along - leg - arc) as f64 / leg as f64, width, rho]
            }
        },
        |corners| {
            let max_v = corners.iter().map(|corner| corner[2]).max().unwrap_or(0);
            let min_v = corners.iter().map(|corner| corner[2]).min().unwrap_or(0);
            let region = if max_v <= leg {
                0
            } else if min_v >= leg + arc {
                2
            } else {
                1
            };
            if all(corners, 2, 0) {
                9
            } else if all(corners, 2, cells[2]) {
                10
            } else if all(corners, 1, 0) {
                7
            } else if all(corners, 1, cells[1]) {
                8
            } else if all(corners, 0, cells[0]) {
                1 + region
            } else {
                4 + region
            }
        },
    )
}

/// Each shell node of the bracket on the mid surface: x = 21 on leg 1,
/// z = 21 on leg 2, ρ = 21 in the bend.
fn assert_on_bracket_mid_surface(shells: &ShellExtraction) {
    let mid = BEND_INNER + SHEET / 2.0;
    for vertex in &shells.vertices {
        let along = if vertex[2] < -1e-9 {
            vertex[0]
        } else if vertex[0] < -1e-9 {
            vertex[2]
        } else {
            vertex[0].hypot(vertex[2])
        };
        let off = (along - mid).abs();
        assert!(off < 0.01 * SHEET, "{vertex:?} is {off} mm off");
    }
}

/// The two flat legs (planar walls) and the bend (a curved wall) are kept on
/// one side and welded where they meet: one sheet on the mid surface.
#[test]
fn bend_welds_to_its_flat_legs() {
    let mesh = bend(0.0);
    let shells = extract(&mesh).expect("extraction");
    assert_eq!(shells.walls.len(), 3, "{:?}", shells.walls);
    let kept: BTreeSet<i32> = shells.walls.iter().map(|wall| wall.keep).collect();
    let side: BTreeSet<usize> = kept
        .iter()
        .flat_map(|&face| nodes_of_face(&mesh, face))
        .collect();
    assert!(
        kept == BTreeSet::from([1, 2, 3]) || kept == BTreeSet::from([4, 5, 6]),
        "{kept:?}"
    );
    assert_eq!(shells.vertices.len(), side.len());
    assert_on_bracket_mid_surface(&shells);
    let tets = shell_body_tets(&mesh, &shells).expect("fully covered");
    assert_eq!(tets.len(), mesh.tets().len());
}

/// When the flat legs are kept on their inner faces, the bend follows them
/// onto its inner face, so the three walls still share their edge nodes.
#[test]
fn bend_keeps_the_side_its_flat_legs_keep() {
    let mesh = bend(10.0);
    let shells = extract(&mesh).expect("extraction");
    let kept: BTreeSet<i32> = shells.walls.iter().map(|wall| wall.keep).collect();
    let side: BTreeSet<usize> = kept
        .iter()
        .flat_map(|&face| nodes_of_face(&mesh, face))
        .collect();
    assert!(
        kept == BTreeSet::from([1, 2, 3]) || kept == BTreeSet::from([4, 5, 6]),
        "{kept:?}"
    );
    assert_eq!(shells.vertices.len(), side.len());
    assert_on_bracket_mid_surface(&shells);
}

// ── The edges of a flat plate ─────────────────────────────────────────────────

/// A quarter washer, 10 mm thick along z, r = 20…32 mm: a flat plate whose
/// bore and outer edge are cylinders 12 mm apart. Faces: 1 outer edge,
/// 2 bore, 3, 4 the cut edges, 5 bottom, 6 top.
fn quarter_washer() -> ShellizeMesh {
    let cells = [6, 12, 2];
    mapped_mesh(
        cells,
        |_| true,
        |[layer, around, along]| {
            let radius = 20.0 + 2.0 * layer as f64;
            let angle = PI / 2.0 * around as f64 / 12.0;
            [
                radius * angle.cos(),
                radius * angle.sin(),
                5.0 * along as f64,
            ]
        },
        |corners| {
            if all(corners, 2, 0) {
                5
            } else if all(corners, 2, cells[2]) {
                6
            } else if all(corners, 1, 0) {
                3
            } else if all(corners, 1, cells[1]) {
                4
            } else if all(corners, 0, cells[0]) {
                1
            } else {
                2
            }
        },
    )
}

/// The bore and the outer edge of a plate face each other across the plate,
/// but they are the plate's own edges — both faces of the plate's wall meet
/// each of them — not a wall: the plate collapses alone.
#[test]
fn plate_edges_are_no_curved_wall() {
    let mesh = quarter_washer();
    let shells = extract(&mesh).expect("extraction");
    assert_eq!(shells.walls.len(), 1, "{:?}", shells.walls);
    assert!(!shells.walls[0].curved);
    let tets = shell_body_tets(&mesh, &shells).expect("fully covered");
    assert_eq!(tets.len(), mesh.tets().len());
}

// ── A wall standing on a curved wall ──────────────────────────────────────────

/// The cylindrical panel with a 40 mm radial fin standing on its inner face
/// (a 0.1° wedge, about 1.7 mm thick, at θ = 15°). Faces: 1 outer, 2 inner,
/// 3, 4 sides, 5, 6 ends, 7, 8 the fin's sides, 9 the fin's edge.
fn finned_panel() -> ShellizeMesh {
    let cells = [4, 13, 10];
    let fin = 6;
    let radii = [955.0, 975.0, 995.0, 1000.0, 1005.0];
    mapped_mesh(
        cells,
        |[layer, around, _]| layer >= 2 || around == fin,
        |[layer, around, along]| {
            let degrees = if around <= fin {
                2.5 * around as f64
            } else {
                2.5 * (around - 1) as f64 + 0.1
            };
            let angle = degrees.to_radians();
            let radius = radii[layer];
            [
                radius * angle.cos(),
                radius * angle.sin(),
                50.0 * along as f64,
            ]
        },
        |corners| {
            if all(corners, 2, 0) {
                5
            } else if all(corners, 2, cells[2]) {
                6
            } else if all(corners, 1, 0) {
                3
            } else if all(corners, 1, cells[1]) {
                4
            } else if all(corners, 0, cells[0]) {
                1
            } else if all(corners, 0, 0) {
                9
            } else if all(corners, 1, fin) {
                7
            } else if all(corners, 1, fin + 1) {
                8
            } else {
                2
            }
        },
    )
}

/// A wall standing on the inside of a curved wall would need a T-junction
/// weld into the curved mid-surface, which the idealisation does not do: the
/// body is refused with that reason rather than shelled in two loose pieces.
#[test]
fn wall_standing_on_a_curved_wall_is_refused() {
    let error = extract(&finned_panel()).expect_err("refused");
    assert!(
        matches!(error, ShellizeError::CurvedWallJunction { .. }),
        "{error}"
    );
    assert!(error.to_string().contains("curved"), "{error}");
}
