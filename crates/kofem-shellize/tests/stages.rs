// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

#![allow(
    clippy::expect_used,
    clippy::float_cmp,
    reason = "test fixtures: a fixture that fails to build should abort the test, and grid \
              coordinates are exact binary fractions"
)]

mod support;

use kofem_shellize::coupling_set::{CouplingKind, CouplingSet, ALL_DOF_MASK};
use kofem_shellize::ties::{TieCouplingDrop, TieCouplingReport, TieSide};
use kofem_shellize::{
    build_coupled_model, build_explicit_coupled_model, build_shell_transition_model,
    extract_thin_wall_shells, shell_body_tets, shell_wall_tets, CouplingOptions, ExtractOptions,
    ShellExtraction, ShellizeError, ShellizeMesh, TieSurfaces,
};
use std::collections::{HashMap, HashSet};

use support::{boxes, boxes_labelled, BoxSpec};

fn extract(mesh: &ShellizeMesh, max_wall: f64, ids: Option<Vec<i32>>) -> ShellExtraction {
    extract_thin_wall_shells(
        mesh,
        &ExtractOptions {
            max_wall,
            shell_body_ids: ids,
        },
    )
    .expect("extraction")
}

fn plate(thickness: f64, body: i32, face_base: i32, origin: [f64; 3]) -> BoxSpec {
    BoxSpec {
        min: origin,
        max: [origin[0] + 40.0, origin[1] + 20.0, origin[2] + thickness],
        cells: [8, 4, 2],
        body,
        face_base,
    }
}

/// A 2 mm plate is one wall, 2 mm thick, its mid-surface at t/2, and every one
/// of its tets is wall material.
#[test]
fn plate_is_one_wall_at_its_mid_plane() {
    let mesh = boxes(&[plate(2.0, 1, 0, [0.0; 3])]);
    let shells = extract(&mesh, 15.0, None);
    assert_eq!(shells.shell_body, Some(1));
    assert_eq!(shells.walls.len(), 1);
    assert!((shells.walls[0].thickness - 2.0).abs() < 1e-12);
    assert!(shells
        .vertices
        .iter()
        .all(|vertex| (vertex[2] - 1.0).abs() < 1e-12));
    // The kept outer face's 9×5 grid, welded into one sheet.
    assert_eq!(shells.vertices.len(), 45);
    assert_eq!(shells.triangles.len(), 64);
    assert!(shells.thicknesses.iter().all(|&value| value == 2.0));
    let tets = shell_body_tets(&mesh, &shells).expect("fully covered");
    assert_eq!(tets.len(), mesh.tets().len());
}

/// The wall-thickness window: 20 mm is no wall at max 15 but one at max 25,
/// 0.04 mm is below the 0.05 mm floor, and a wall exactly max thick is a wall
/// even when its measured gap rounds a few ulps above it.
#[test]
fn wall_thickness_window() {
    let block = boxes(&[plate(20.0, 1, 0, [0.0; 3])]);
    assert_eq!(extract(&block, 15.0, None).shell_body, None);
    assert_eq!(extract(&block, 25.0, None).shell_body, Some(1));
    let limit = boxes(&[plate(15.0, 1, 0, [0.0; 3])]);
    assert_eq!(
        extract(&limit, 15.0 * (1.0 - 1e-9), None).shell_body,
        Some(1)
    );
    let sliver = boxes(&[plate(0.04, 1, 0, [0.0; 3])]);
    assert_eq!(extract(&sliver, 15.0, None).shell_body, None);
}

/// `shell_body_ids` picks the body; an empty choice means all-solid; without a
/// choice the body with the largest wall wins.
#[test]
fn shell_body_choice() {
    let mesh = boxes(&[
        plate(2.0, 1, 0, [0.0; 3]),
        BoxSpec {
            min: [0.0, 0.0, 10.0],
            max: [60.0, 30.0, 13.0],
            cells: [6, 3, 2],
            body: 2,
            face_base: 10,
        },
    ]);
    assert_eq!(extract(&mesh, 15.0, None).shell_body, Some(2));
    assert_eq!(extract(&mesh, 15.0, Some(vec![1])).shell_body, Some(1));
    assert_eq!(extract(&mesh, 15.0, Some(vec![])).shell_body, None);
    let first = extract(&mesh, 15.0, Some(vec![1]));
    assert!(first.walls.iter().all(|wall| wall.body == 1));
}

/// Two 2 mm walls meeting at an L: the shared CAD edge lands on the line where
/// the two mid-planes cross (x = 1, z = 1), and every wall tet is claimed
/// (KOF-191).
#[test]
fn junction_lands_on_both_mid_planes() {
    // CAD faces by plane, as the L's own B-rep has them: 1 = A outer (z = 0),
    // 2 = A inner (z = 2), 3 = B outer (x = 0, the full height), 4 = B inner
    // (x = 2), 5.. = sides and ends.
    let on = |corners: [[f64; 3]; 3], axis: usize, at: f64| {
        corners.iter().all(|point| (point[axis] - at).abs() < 1e-9)
    };
    let label = |corners: [[f64; 3]; 3]| -> i32 {
        [
            (2, 0.0),
            (2, 2.0),
            (0, 0.0),
            (0, 2.0),
            (1, 0.0),
            (1, 20.0),
            (0, 40.0),
            (2, 30.0),
        ]
        .iter()
        .position(|&(axis, at)| on(corners, axis, at))
        .map(|position| i32::try_from(position).expect("small") + 1)
        .expect("boundary triangle on a known plane")
    };
    let mesh = boxes_labelled(
        &[
            BoxSpec {
                min: [0.0, 0.0, 0.0],
                max: [40.0, 20.0, 2.0],
                cells: [20, 4, 1],
                body: 1,
                face_base: 0,
            },
            BoxSpec {
                min: [0.0, 0.0, 2.0],
                max: [2.0, 20.0, 30.0],
                cells: [1, 4, 14],
                body: 1,
                face_base: 10,
            },
        ],
        label,
    );
    let shells = extract(&mesh, 15.0, None);
    assert_eq!(shells.walls.len(), 2, "{:?}", shells.walls);
    let corner_nodes = shells
        .vertices
        .iter()
        .filter(|vertex| (vertex[0] - 1.0).abs() < 1e-9 && (vertex[2] - 1.0).abs() < 1e-9)
        .count();
    assert_eq!(corner_nodes, 5, "one junction node per y grid line");
    let wall_tets = shell_wall_tets(&mesh, &shells, 1.0).expect("grid");
    assert_eq!(wall_tets.len(), mesh.tets().len());
}

/// An I-section `length` mm long (6 cells along it), labelled as `test_files/I_beam.step`'s B-rep is:
/// each flange's inner side is two faces split by the web (KOF-205). Web
/// y ∈ [−30, 30], 15 mm thick about z = 0; flanges z ∈ [−40, 40], 10 mm thick
/// about y = ±35. The flange grid has no line at z = 0, so the web's mid-surface
/// edge lands inside the flange facets and must be imprinted there.
fn i_beam(length: f64) -> ShellizeMesh {
    let near = |value: f64, at: f64| (value - at).abs() < 1e-9;
    let label = |corners: [[f64; 3]; 3]| -> i32 {
        let all = |axis: usize, at: f64| corners.iter().all(|point| near(point[axis], at));
        let positive_z = corners.iter().all(|point| point[2] >= 7.5 - 1e-9);
        let top = corners.iter().all(|point| point[1] > 0.0);
        if all(1, 40.0) {
            8
        } else if all(1, -40.0) {
            2
        } else if all(1, 30.0) {
            if positive_z {
                10
            } else {
                6
            }
        } else if all(1, -30.0) {
            if positive_z {
                12
            } else {
                4
            }
        } else if all(2, 7.5) {
            11
        } else if all(2, -7.5) {
            5
        } else if all(2, 40.0) {
            if top {
                9
            } else {
                1
            }
        } else if all(2, -40.0) {
            if top {
                7
            } else {
                3
            }
        } else if all(0, 0.0) {
            14
        } else if all(0, length) {
            13
        } else {
            // Off the I-section: the fixture itself is wrong.
            0
        }
    };
    let piece = |span_y: [f64; 2], span_z: [f64; 2], cells: [usize; 3]| BoxSpec {
        min: [0.0, span_y[0], span_z[0]],
        max: [length, span_y[1], span_z[1]],
        cells,
        body: 1,
        face_base: 0,
    };
    let mut specs = vec![piece([-30.0, 30.0], [-7.5, 7.5], [6, 6, 1])];
    for flange in [[30.0, 40.0], [-40.0, -30.0]] {
        specs.push(piece(flange, [-40.0, -7.5], [6, 1, 3]));
        specs.push(piece(flange, [-7.5, 7.5], [6, 1, 1]));
        specs.push(piece(flange, [7.5, 40.0], [6, 1, 3]));
    }
    boxes_labelled(&specs, label)
}

/// Union–find root with path halving.
fn find(root: &mut [usize], mut node: usize) -> usize {
    while root[node] != node {
        root[node] = root[root[node]];
        node = root[node];
    }
    node
}

/// Each I-beam junction line (6 web facet edges along x) is carried by 3
/// facets — the web and the flange on both sides.
fn assert_conforming_junctions(shells: &ShellExtraction) {
    let on_junction = |node: usize| {
        let vertex = shells.vertices[node];
        vertex[2].abs() < 1e-9 && (vertex[1].abs() - 35.0).abs() < 1e-9
    };
    let junction: Vec<usize> = edge_uses(shells)
        .into_iter()
        .filter(|&((first, second), _)| on_junction(first) && on_junction(second))
        .map(|(_, uses)| uses)
        .collect();
    assert_eq!(junction, vec![3; 12], "two junction lines of 6 edges each");
}

/// Facet edges as unordered node pairs, with the number of facets on each.
fn edge_uses(shells: &ShellExtraction) -> std::collections::HashMap<(usize, usize), usize> {
    let mut uses = std::collections::HashMap::new();
    for tri in &shells.triangles {
        for corner in 0..3 {
            let (first, second) = (tri[corner], tri[(corner + 1) % 3]);
            *uses
                .entry((first.min(second), first.max(second)))
                .or_insert(0) += 1;
        }
    }
    uses
}

/// The I-beam idealises as web + both flanges, welded into ONE shell along the
/// two T-junction lines: the web's mid-surface reaches the flange mid-planes
/// (y = ±35) and every web edge on a junction line is a flange facet edge too.
#[test]
fn i_beam_flanges_pair_and_weld_at_t_junctions() {
    let mesh = i_beam(60.0);
    assert!(
        !mesh.surface_faces().contains(&0),
        "every boundary triangle labelled"
    );
    let shells = extract(&mesh, 15.0, None);
    let mut walls: Vec<(i32, f64)> = shells
        .walls
        .iter()
        .map(|wall| (wall.keep, wall.thickness))
        .collect();
    walls.sort_by_key(|wall| wall.0);
    assert_eq!(walls.len(), 3, "web and both flanges: {walls:?}");
    let expected = [(2, 10.0), (5, 15.0), (8, 10.0)];
    for (wall, (keep, thickness)) in walls.iter().zip(expected) {
        // Flanges keep their full outer face; the web either of its sides.
        assert!(wall.0 == keep || (keep == 5 && wall.0 == 11), "{walls:?}");
        assert!((wall.1 - thickness).abs() < 1e-9, "{walls:?}");
    }

    // Every node on a mid-plane: web z = 0, flanges y = ±35.
    assert!(shells
        .vertices
        .iter()
        .all(|vertex| { vertex[2].abs() < 1e-9 || (vertex[1].abs() - 35.0).abs() < 1e-9 }));
    let web_reach = shells
        .vertices
        .iter()
        .filter(|vertex| vertex[2].abs() < 1e-9)
        .map(|vertex| vertex[1].abs())
        .fold(0.0, f64::max);
    assert!(
        (web_reach - 35.0).abs() < 1e-9,
        "web reaches the flange mid-planes"
    );

    // One connected shell.
    let mut root: Vec<usize> = (0..shells.vertices.len()).collect();
    for tri in &shells.triangles {
        for corner in 1..3 {
            let (first, second) = (find(&mut root, tri[0]), find(&mut root, tri[corner]));
            root[first] = second;
        }
    }
    let components: std::collections::HashSet<usize> =
        (0..root.len()).map(|node| find(&mut root, node)).collect();
    assert_eq!(components.len(), 1, "web and flanges are one shell");

    assert_conforming_junctions(&shells);

    // No sliver facets from the imprint.
    for tri in &shells.triangles {
        let corners = tri.map(|node| shells.vertices[node]);
        let side = |first: usize, second: usize| {
            let delta = [0, 1, 2].map(|axis| corners[first][axis] - corners[second][axis]);
            delta.iter().map(|value| value * value).sum::<f64>()
        };
        let squared = side(0, 1) + side(1, 2) + side(2, 0);
        let edge_a = [0, 1, 2].map(|axis| corners[1][axis] - corners[0][axis]);
        let edge_b = [0, 1, 2].map(|axis| corners[2][axis] - corners[0][axis]);
        let normal = [
            edge_a[1] * edge_b[2] - edge_a[2] * edge_b[1],
            edge_a[2] * edge_b[0] - edge_a[0] * edge_b[2],
            edge_a[0] * edge_b[1] - edge_a[1] * edge_b[0],
        ];
        let area = 0.5 * normal.iter().map(|value| value * value).sum::<f64>().sqrt();
        let quality = 4.0 * 3.0_f64.sqrt() * area / squared;
        assert!(
            quality > 0.2,
            "sliver facet {corners:?} (quality {quality})"
        );
    }

    // The three walls cover the whole body, junction blocks included.
    let tets = shell_body_tets(&mesh, &shells).expect("fully covered");
    assert_eq!(tets.len(), mesh.tets().len());
}

/// Whether a junction is welded depends on where it runs, not on how long its
/// facet edges are: a 6 m I-beam with six cells along it (1 m facet edges,
/// far longer than their distance to the flange edges) welds the same way.
#[test]
fn long_coarse_i_beam_still_welds() {
    let shells = extract(&i_beam(6000.0), 15.0, None);
    assert_eq!(shells.walls.len(), 3, "{:?}", shells.walls);
    let web_reach = shells
        .vertices
        .iter()
        .filter(|vertex| vertex[2].abs() < 1e-9)
        .map(|vertex| vertex[1].abs())
        .fold(0.0, f64::max);
    assert!(
        (web_reach - 35.0).abs() < 1e-9,
        "web reaches the flange mid-planes"
    );
    assert_conforming_junctions(&shells);
}

/// A Shell body with a thick block the walls do not cover is refused, with the
/// share of it the shells would drop.
#[test]
fn uncovered_shell_body_is_refused() {
    // A 16 mm cube on a corner of the plate: its sides are 16 mm apart (no
    // wall at max 15) and it covers too little of the plate to spoil its pair.
    let mesh = boxes(&[
        BoxSpec {
            min: [0.0; 3],
            max: [40.0, 20.0, 2.0],
            cells: [10, 5, 2],
            body: 1,
            face_base: 0,
        },
        BoxSpec {
            min: [0.0, 0.0, 2.0],
            max: [16.0, 16.0, 18.0],
            cells: [4, 4, 4],
            body: 1,
            face_base: 10,
        },
    ]);
    let shells = extract(&mesh, 15.0, Some(vec![1]));
    let error = shell_body_tets(&mesh, &shells).expect_err("block is not wall");
    assert!(matches!(
        error,
        ShellizeError::UncoveredShellBody { body: 1, .. }
    ));
    assert!(error.to_string().contains("marked \"Shell\""));
}

/// A 2 mm plate standing on a block (thin plate on a block): the transition
/// cuts the solid 3 t into the wall, the shell starts at the cut, and the cut
/// section follows the shell edge through footprint couplings whose two
/// weights interpolate along the edge.
#[test]
fn plate_on_block_couples_through_its_footprint() {
    let mesh = boxes(&[
        BoxSpec {
            min: [0.0, 0.0, 0.0],
            max: [40.0, 20.0, 10.0],
            cells: [40, 4, 2],
            body: 1,
            face_base: 0,
        },
        BoxSpec {
            min: [19.0, 0.0, 10.0],
            max: [21.0, 20.0, 40.0],
            cells: [2, 4, 6],
            body: 2,
            face_base: 10,
        },
    ]);
    let shells = extract(&mesh, 15.0, Some(vec![2]));
    assert_eq!(shells.shell_body, Some(2));
    let transition = build_shell_transition_model(&mesh, &shells).expect("transition");
    let cut = 10.0 + 3.0 * 2.0;
    assert!(transition
        .shells
        .vertices
        .iter()
        .all(|vertex| vertex[2] >= cut - 1e-9));
    let coupling = &transition.model.coupling;
    coupling.validate().expect("well-formed coupling set");
    let footprints: Vec<usize> = (0..coupling.len())
        .filter(|&k| coupling.kind[k] == CouplingKind::Footprint)
        .collect();
    assert_ne!(
        footprints,
        [] as [usize; 0],
        "the cut section follows the shell edge"
    );
    for k in footprints {
        let range = coupling.offsets[k]..coupling.offsets[k + 1];
        assert_eq!(range.len(), 2);
        let weights = &coupling.weights[range];
        assert!((weights[0] + weights[1] - 1.0).abs() < 1e-12);
        let solid = transition.model.pool[coupling.reference[k]];
        assert!(
            (solid[2] - cut).abs() < 1e-9,
            "footprint node on the cut section"
        );
    }
    // Solid tets now reach up to the cut on the plate's side.
    let highest = transition
        .model
        .tets
        .iter()
        .flatten()
        .map(|&node| transition.model.pool[node][2])
        .fold(f64::NEG_INFINITY, f64::max);
    assert!((highest - cut).abs() < 1e-9);
}

/// Without the transition, the plate's root still joins the block — here
/// through its footprint, since the root is a through-thickness section — and
/// a declared tie across a gap is distributing. The explicit model of the same
/// mixed mesh rebuilds the same coupling kinds.
#[test]
fn seam_and_tie_couplings() {
    let mesh = boxes(&[
        BoxSpec {
            min: [0.0, 0.0, 0.0],
            max: [40.0, 20.0, 10.0],
            cells: [40, 4, 2],
            body: 1,
            face_base: 0,
        },
        BoxSpec {
            min: [19.0, 0.0, 10.0],
            max: [21.0, 20.0, 40.0],
            cells: [2, 4, 6],
            body: 2,
            face_base: 10,
        },
        BoxSpec {
            min: [0.0, 0.0, -12.0],
            max: [40.0, 20.0, -2.0],
            cells: [8, 4, 2],
            body: 3,
            face_base: 20,
        },
    ]);
    let shells = extract(&mesh, 15.0, Some(vec![2]));
    let wall_tets = shell_body_tets(&mesh, &shells).expect("covered");
    let bottom_of_block: Vec<usize> = (0..mesh.vertices().len())
        .filter(|&vertex| mesh.vertices()[vertex][2] == 0.0)
        .collect();
    let top_of_lower: Vec<usize> = (0..mesh.vertices().len())
        .filter(|&vertex| mesh.vertices()[vertex][2] == -2.0)
        .collect();
    let options = CouplingOptions {
        ties: vec![TieSurfaces {
            name: "gap".to_owned(),
            vertices_a: bottom_of_block,
            vertices_b: top_of_lower,
            max_separation: f64::INFINITY,
        }],
        ..CouplingOptions::default()
    };
    let model = build_coupled_model(&mesh, &shells, &wall_tets, &options).expect("model");
    model.coupling.validate().expect("well-formed");
    let count = |kind| {
        model
            .coupling
            .kind
            .iter()
            .filter(|&&value| value == kind)
            .count()
    };
    assert!(
        count(CouplingKind::Footprint) > 0,
        "plate root joins the block"
    );
    assert!(count(CouplingKind::Distributing) > 0, "gap tie");
    assert_eq!(model.tie_reports.len(), 1);
    assert!(model.tie_reports[0].coupled > 0);
    assert!((model.tie_reports[0].gap - 2.0).abs() < 1e-9);
    assert!(model.tie_reports[0].problem().is_none());
    for k in 0..model.coupling.len() {
        let reference = model.coupling.reference[k];
        if model.coupling.kind[k] == CouplingKind::RelaxedMpc {
            assert!(model.is_shell_pool_index(reference));
        }
        let partners = model.coupling.partners(k).len();
        if model.coupling.kind[k] == CouplingKind::Footprint {
            assert_eq!(partners, 2, "a footprint follows one shell edge");
        } else {
            assert!(partners >= 3, "an RBE3/MPC needs three partners");
        }
    }

    explicit_model_rebuilds_shell_solid_couplings(&model);
}

/// A tie surface picked partly on a wall that becomes a shell: the vertices
/// left with no solid pool node are counted on the tie's report, not dropped
/// silently, and the rest of the tie still couples.
#[test]
fn tie_vertices_without_a_pool_node_are_counted() {
    let mesh = boxes(&[
        BoxSpec {
            min: [0.0, 0.0, 0.0],
            max: [40.0, 20.0, 10.0],
            cells: [40, 4, 2],
            body: 1,
            face_base: 0,
        },
        BoxSpec {
            min: [19.0, 0.0, 10.0],
            max: [21.0, 20.0, 40.0],
            cells: [2, 4, 6],
            body: 2,
            face_base: 10,
        },
        BoxSpec {
            min: [0.0, 0.0, -12.0],
            max: [40.0, 20.0, -2.0],
            cells: [8, 4, 2],
            body: 3,
            face_base: 20,
        },
    ]);
    let shells = extract(&mesh, 15.0, Some(vec![2]));
    let wall_tets = shell_body_tets(&mesh, &shells).expect("covered");
    let points = mesh.vertices();
    let on_wall: Vec<usize> = (0..points.len())
        .filter(|&vertex| points[vertex][2] > 10.0 + 1e-9)
        .collect();
    assert!(
        !on_wall.is_empty(),
        "the shelled wall has vertices above the block"
    );
    let mut vertices_a: Vec<usize> = (0..points.len())
        .filter(|&vertex| points[vertex][2] == 0.0)
        .collect();
    vertices_a.extend(&on_wall);
    let options = CouplingOptions {
        ties: vec![TieSurfaces {
            name: "gap".to_owned(),
            vertices_a,
            vertices_b: (0..points.len())
                .filter(|&vertex| points[vertex][2] == -2.0)
                .collect(),
            max_separation: f64::INFINITY,
        }],
        ..CouplingOptions::default()
    };
    let model = build_coupled_model(&mesh, &shells, &wall_tets, &options).expect("model");
    let report = &model.tie_reports[0];
    assert!(report.coupled > 0);
    assert_eq!(report.unmapped, on_wall.len());
    assert!(report.problem().is_none());
}

/// The same model, stored as explicit elements, gets the same shell/solid
/// couplings (no tie in this call, so only those remain).
fn explicit_model_rebuilds_shell_solid_couplings(model: &kofem_shellize::CoupledModel) {
    let pool: Vec<f64> = model.pool.iter().flatten().copied().collect();
    let to_u32 = |values: &[usize]| -> Vec<u32> {
        values
            .iter()
            .map(|&value| u32::try_from(value).expect("small"))
            .collect()
    };
    let tets = to_u32(&model.tets.iter().flatten().copied().collect::<Vec<_>>());
    let triangles = to_u32(
        &model
            .triangles
            .iter()
            .flatten()
            .copied()
            .collect::<Vec<_>>(),
    );
    let explicit = build_explicit_coupled_model(
        &pool,
        &tets,
        &triangles,
        &model.thicknesses,
        &CouplingOptions::default(),
    )
    .expect("explicit model");
    let shell_solid: Vec<CouplingKind> = model
        .coupling
        .kind
        .iter()
        .copied()
        .filter(|&kind| kind != CouplingKind::Distributing)
        .collect();
    assert_eq!(explicit.coupling.kind, shell_solid);
}
#[test]
fn coupling_set_concat_and_fixed_nodes() {
    let mut first = CouplingSet::default();
    first.push_unweighted(10, &[1, 2, 3], CouplingKind::Distributing);
    first.push_unweighted(11, &[4, 5, 6], CouplingKind::Kinematic);
    let mut second = CouplingSet::default();
    second.push(12, &[7, 8], &[0.25, 0.75], CouplingKind::Footprint);
    let all = first.concat(&second);
    all.validate().expect("well-formed");
    assert_eq!(all.offsets, vec![0, 3, 6, 8]);
    assert_eq!(all.partners(2), &[7, 8]);
    assert_eq!(all.weights[6..], [0.25, 0.75]);
    assert!(all.dof_mask.iter().all(|&mask| mask == ALL_DOF_MASK));

    // Fixing node 10 drops its distributing coupling; fixing kinematic
    // reference 11 keeps it (an independent reference may be clamped).
    let kept = all
        .drop_on_fixed_nodes(&[60, 66])
        .expect("no footprint fixed");
    assert_eq!(kept.reference, vec![11, 12]);
    assert_eq!(kept.offsets, vec![0, 3, 5]);
    kept.validate().expect("well-formed");
    // Fixing a footprint node would cut the transition.
    assert_eq!(
        all.drop_on_fixed_nodes(&[6 * 12 + 2]),
        Err(ShellizeError::PrescribedTransitionNode)
    );
}

#[test]
fn tie_problem_sentences() {
    let report = |drop| TieCouplingReport {
        name: "pin".to_owned(),
        coupled: 0,
        partners: 0,
        shared: 0,
        unmapped: 0,
        gap: 0.0,
        drop: Some(drop),
    };
    let side = report(TieCouplingDrop::NoPoolNodes {
        side: TieSide::Both,
    })
    .problem()
    .expect("dropped");
    assert!(side.starts_with("Tie \"pin\" coupled no nodes — neither picked surface"));
    let far = report(TieCouplingDrop::BeyondSearchDistance {
        gap: 2.5,
        reach: 1.0,
    })
    .problem()
    .expect("dropped");
    assert!(far.contains("2.5000 mm, beyond its 1.0000 mm search distance"));
    let shared = TieCouplingReport {
        shared: 2,
        ..report(TieCouplingDrop::OutOfReach { searched: 8.0 })
    };
    assert_eq!(shared.problem(), None, "shared nodes already connect");
}

#[test]
fn malformed_meshes_are_refused() {
    assert!(matches!(
        ShellizeMesh::new(&[0.0; 4], &[], &[], &[], &[]),
        Err(ShellizeError::ArrayLength { .. })
    ));
    assert!(matches!(
        ShellizeMesh::new(&[0.0; 12], &[0, 1, 2, 7], &[1], &[], &[]),
        Err(ShellizeError::VertexOutOfRange { vertex: 7, .. })
    ));
    assert!(matches!(
        ShellizeMesh::new(&[0.0; 12], &[0, 1, 2, 3], &[], &[], &[]),
        Err(ShellizeError::ArrayCount { .. })
    ));
    assert!(matches!(
        ShellizeMesh::new(&[f64::NAN; 3], &[], &[], &[], &[]),
        Err(ShellizeError::NonFinite { .. })
    ));
}

// ── L-corners (KOF-452) ───────────────────────────────────────────────────────
//
// A Z-section and a C-section marked Shell collapse to one welded mid-surface:
// at each corner the two walls meet on the line where their mid-planes cross,
// and the corner block's tets are covered.

/// Equal to fixture round-off.
fn close(value: f64, at: f64) -> bool {
    (value - at).abs() < 1e-9
}

/// Wall thickness, section height, flange width (beyond the web) and length.
const THICK: f64 = 2.0;
const HEIGHT: f64 = 30.0;
const WIDTH: f64 = 12.0;
const LENGTH: f64 = 20.0;

fn section_piece(min: [f64; 3], max: [f64; 3], cells: [usize; 3]) -> BoxSpec {
    BoxSpec {
        min,
        max,
        cells,
        body: 1,
        face_base: 0,
    }
}

/// Label each boundary triangle with its CAD face: one id per (plane, region),
/// as the section's own WIDTH-rep has them. `faces` lists (axis, plane, region
/// test on the triangle's corners).
type FaceTest = (usize, f64, fn([[f64; 3]; 3]) -> bool);

fn label_by(faces: &[FaceTest], corners: [[f64; 3]; 3]) -> i32 {
    faces
        .iter()
        .position(|&(axis, at, region)| {
            corners.iter().all(|point| close(point[axis], at)) && region(corners)
        })
        .map_or(0, |index| i32::try_from(index).expect("few faces") + 1)
}

fn anywhere(_: [[f64; 3]; 3]) -> bool {
    true
}

/// A Z-section along y: the bottom flange runs to −x, the top flange to +x,
/// the web x ∈ [0, THICK] between them. Whichever web face is kept lies on the
/// inside of one corner.
fn z_section() -> ShellizeMesh {
    let faces: [FaceTest; 10] = [
        (2, 0.0, anywhere),            // 1 bottom flange outer
        (2, THICK, anywhere),          // 2 bottom flange inner
        (0, -WIDTH, anywhere),         // 3 bottom flange end
        (0, 0.0, anywhere),            // 4 web, left
        (0, THICK, anywhere),          // 5 web, right
        (2, HEIGHT - THICK, anywhere), // 6 top flange inner
        (2, HEIGHT, anywhere),         // 7 top flange outer
        (0, WIDTH + THICK, anywhere),  // 8 top flange end
        (1, 0.0, anywhere),            // 9 section end
        (1, LENGTH, anywhere),         // 10 section end
    ];
    boxes_labelled(
        &[
            section_piece([-WIDTH, 0.0, 0.0], [THICK, LENGTH, THICK], [14, 4, 2]),
            section_piece(
                [0.0, 0.0, THICK],
                [THICK, LENGTH, HEIGHT - THICK],
                [2, 4, 13],
            ),
            section_piece(
                [0.0, 0.0, HEIGHT - THICK],
                [WIDTH + THICK, LENGTH, HEIGHT],
                [14, 4, 2],
            ),
        ],
        |corners| label_by(&faces, corners),
    )
}

/// A C-section along y: both flanges run to +x from the web x ∈ [0, THICK].
fn c_section() -> ShellizeMesh {
    fn low(corners: [[f64; 3]; 3]) -> bool {
        corners.iter().all(|point| point[2] <= THICK + 1e-9)
    }
    fn high(corners: [[f64; 3]; 3]) -> bool {
        corners
            .iter()
            .all(|point| point[2] >= HEIGHT - THICK - 1e-9)
    }
    let faces: [FaceTest; 10] = [
        (2, 0.0, anywhere),            // 1 bottom flange outer
        (2, THICK, anywhere),          // 2 bottom flange inner
        (0, WIDTH + THICK, low),       // 3 bottom flange end
        (0, 0.0, anywhere),            // 4 web outer
        (0, THICK, anywhere),          // 5 web inner
        (2, HEIGHT - THICK, anywhere), // 6 top flange inner
        (2, HEIGHT, anywhere),         // 7 top flange outer
        (0, WIDTH + THICK, high),      // 8 top flange end
        (1, 0.0, anywhere),            // 9 section end
        (1, LENGTH, anywhere),         // 10 section end
    ];
    boxes_labelled(
        &[
            section_piece([0.0, 0.0, 0.0], [WIDTH + THICK, LENGTH, THICK], [14, 4, 2]),
            section_piece(
                [0.0, 0.0, THICK],
                [THICK, LENGTH, HEIGHT - THICK],
                [2, 4, 13],
            ),
            section_piece(
                [0.0, 0.0, HEIGHT - THICK],
                [WIDTH + THICK, LENGTH, HEIGHT],
                [14, 4, 2],
            ),
        ],
        |corners| label_by(&faces, corners),
    )
}

fn extract_section(mesh: &ShellizeMesh) -> ShellExtraction {
    assert!(
        !mesh.surface_faces().contains(&0),
        "every boundary triangle labelled"
    );
    extract_thin_wall_shells(
        mesh,
        &ExtractOptions {
            max_wall: 15.0,
            shell_body_ids: Some(vec![1]),
        },
    )
    .expect("extraction")
}

/// The three walls' mid-planes: web x = t/2, flanges z = t/2 and h − t/2.
/// Returns which of them a facet lies on: 0 bottom flange, 1 web, 2 top.
fn wall_of_facet(shells: &ShellExtraction, facet: usize) -> Option<usize> {
    let corners = shells.triangles[facet].map(|node| shells.vertices[node]);
    let on = |axis: usize, at: f64| corners.iter().all(|point| close(point[axis], at));
    [
        (2, THICK / 2.0),
        (0, THICK / 2.0),
        (2, HEIGHT - THICK / 2.0),
    ]
    .iter()
    .position(|&(axis, at)| on(axis, at))
}

/// The section's mid-surface, checked wall by wall: every facet on its wall's
/// mid-plane, each flange ending at the web's mid-plane (no overhang past it,
/// no gap before it), the web ending at both flanges' mid-planes, and each
/// corner line a facet edge of exactly the web and that flange.
fn assert_welded_section(shells: &ShellExtraction, flange_reach: [[f64; 2]; 2]) {
    assert_eq!(
        shells.walls.len(),
        3,
        "web and both flanges: {:?}",
        shells.walls
    );
    let mut span: [[f64; 2]; 3] = [[f64::INFINITY, f64::NEG_INFINITY]; 3];
    let mut nodes_of: [HashSet<usize>; 3] = Default::default();
    for (facet, tri) in shells.triangles.iter().enumerate() {
        let wall = wall_of_facet(shells, facet).expect("every facet on a wall mid-plane");
        // Flanges measured along x, the web along z.
        let axis = if wall == 1 { 2 } else { 0 };
        for &node in tri {
            let value = shells.vertices[node][axis];
            span[wall] = [span[wall][0].min(value), span[wall][1].max(value)];
            nodes_of[wall].insert(node);
        }
    }
    for (flange, reach) in [0, 2].into_iter().zip(flange_reach) {
        assert!(
            close(span[flange][0], reach[0]) && close(span[flange][1], reach[1]),
            "flange {flange} spans x {:?}, expected {reach:?}",
            span[flange]
        );
    }
    assert!(
        close(span[1][0], THICK / 2.0) && close(span[1][1], HEIGHT - THICK / 2.0),
        "web spans z {:?}, expected [THICK/2, HEIGHT − THICK/2]",
        span[1]
    );
    // Each corner node lies on both walls' mid-planes.
    for (flange, height) in [(0, THICK / 2.0), (2, HEIGHT - THICK / 2.0)] {
        let corner: Vec<usize> = nodes_of[1]
            .intersection(&nodes_of[flange])
            .copied()
            .collect();
        assert!(!corner.is_empty(), "web and flange {flange} share no node");
        for node in &corner {
            let vertex = shells.vertices[*node];
            assert!(
                close(vertex[0], THICK / 2.0) && close(vertex[2], height),
                "corner node {vertex:?} off the mid-plane crossing (x {}, z {height})",
                THICK / 2.0
            );
        }
        let reaches = |end: f64| {
            corner
                .iter()
                .any(|&node| close(shells.vertices[node][1], end))
        };
        assert!(
            reaches(0.0) && reaches(LENGTH),
            "corner line runs the full length"
        );
    }
    // Conforming corner lines: each edge along one is used by two facets.
    let mut uses: HashMap<(usize, usize), usize> = HashMap::new();
    for tri in &shells.triangles {
        for corner in 0..3 {
            let (first, second) = (tri[corner], tri[(corner + 1) % 3]);
            *uses
                .entry((first.min(second), first.max(second)))
                .or_insert(0) += 1;
        }
    }
    for (&(first, second), &count) in &uses {
        let [start, end] = [first, second].map(|node| shells.vertices[node]);
        let on_corner = close(start[0], THICK / 2.0)
            && close(end[0], THICK / 2.0)
            && close(start[2], end[2])
            && (close(start[2], THICK / 2.0) || close(start[2], HEIGHT - THICK / 2.0));
        if on_corner {
            assert_eq!(
                count, 2,
                "corner edge {start:?}–{end:?} used by {count} facets"
            );
        }
    }
}

/// The Z-section: the bottom flange runs from its end (x = −WIDTH) to the web's
/// mid-plane, the top flange from the web's mid-plane to its end (x = WIDTH + THICK).
#[test]
fn z_section_welds_at_both_corners() {
    let mesh = z_section();
    let shells = extract_section(&mesh);
    assert_welded_section(
        &shells,
        [[-WIDTH, THICK / 2.0], [THICK / 2.0, WIDTH + THICK]],
    );
}

/// The Z-section's corner blocks are covered by the walls: no tet is lost.
#[test]
fn z_section_corner_tets_are_covered() {
    let mesh = z_section();
    let shells = extract_section(&mesh);
    let tets = shell_body_tets(&mesh, &shells).expect("fully covered");
    assert_eq!(tets.len(), mesh.tets().len());
}

/// The C-section: both flanges run from the web's mid-plane to their ends.
#[test]
fn c_section_welds_at_both_corners() {
    let mesh = c_section();
    let shells = extract_section(&mesh);
    assert_welded_section(
        &shells,
        [[THICK / 2.0, WIDTH + THICK], [THICK / 2.0, WIDTH + THICK]],
    );
}

/// The C-section's corner blocks are covered by the walls: no tet is lost.
#[test]
fn c_section_corner_tets_are_covered() {
    let mesh = c_section();
    let shells = extract_section(&mesh);
    let tets = shell_body_tets(&mesh, &shells).expect("fully covered");
    assert_eq!(tets.len(), mesh.tets().len());
}
