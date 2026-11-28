// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! What the Mesh step lists per body (KOF-497): the mean element edge length,
//! the volume, and the mass from the body's density.

use kofem_fem::{body_statistics, BodyMesh, ElementOrder, FemError, Isotropic, TetMesh};

/// A unit cube's corners in CHEXA order: the bottom face, then the top face.
const CUBE: [f64; 24] = [
    0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0, //
    0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 1.0, 1.0,
];

/// The cube as six tetrahedra about its 0–6 diagonal: every face is cut by
/// one diagonal, so the mesh has 12 unit edges, 6 face diagonals and the
/// space diagonal.
const CUBE_TETS: [u32; 24] = [
    0, 1, 2, 6, 0, 2, 3, 6, 0, 3, 7, 6, 0, 7, 4, 6, 0, 4, 5, 6, 0, 5, 1, 6,
];

/// Steel in N·mm·t: 7850 kg/m³.
const STEEL: f64 = 7.85e-9;

fn mesh<'a>(points: &'a [f64], bodies: &'a [u32]) -> BodyMesh<'a> {
    BodyMesh {
        points,
        tets: &[],
        tet_nodes: 4,
        hexes: &[],
        hex_nodes: 8,
        shell_triangles: &[],
        shell_thicknesses: &[],
        bodies,
    }
}

fn close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() <= 1e-12 * expected.abs().max(1.0),
        "{actual} is not {expected}"
    );
}

fn cube_edge_mean() -> f64 {
    (12.0 + 6.0 * 2.0_f64.sqrt() + 3.0_f64.sqrt()) / 19.0
}

#[test]
fn a_unit_cube_of_tetrahedra_has_its_volume_mass_and_mean_edge() {
    let bodies = [1; 6];
    let input = BodyMesh {
        tets: &CUBE_TETS,
        ..mesh(&CUBE, &bodies)
    };
    let stats = body_statistics(&input, &[(1, STEEL)]).unwrap();
    assert_eq!(stats.len(), 1);
    assert_eq!(stats[0].body, 1);
    assert_eq!(stats[0].elements, 6);
    close(stats[0].volume, 1.0);
    close(stats[0].mean_edge_length, cube_edge_mean());
    close(stats[0].mass.unwrap(), STEEL);
}

#[test]
fn a_hexahedron_has_its_volume_and_its_twelve_edges() {
    let points: Vec<f64> = CUBE
        .chunks(3)
        .flat_map(|point| [2.0 * point[0], point[1], point[2]])
        .collect();
    let hexes: Vec<u32> = (0..8).collect();
    let input = BodyMesh {
        hexes: &hexes,
        ..mesh(&points, &[3])
    };
    let stats = body_statistics(&input, &[(3, STEEL)]).unwrap();
    close(stats[0].volume, 2.0);
    close(stats[0].mean_edge_length, 16.0 / 12.0);
    close(stats[0].mass.unwrap(), 2.0 * STEEL);
}

#[test]
fn a_tapered_hexahedron_has_the_volume_of_its_frustum() {
    // A 2×2 base under a centred 1×1 top, 1 high: V = h/3 (A₁ + A₂ + √(A₁A₂)).
    let points = [
        0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 2.0, 2.0, 0.0, 0.0, 2.0, 0.0, //
        0.5, 0.5, 1.0, 1.5, 0.5, 1.0, 1.5, 1.5, 1.0, 0.5, 1.5, 1.0,
    ];
    let hexes: Vec<u32> = (0..8).collect();
    let input = BodyMesh {
        hexes: &hexes,
        ..mesh(&points, &[1])
    };
    let stats = body_statistics(&input, &[]).unwrap();
    close(stats[0].volume, 7.0 / 3.0);
}

#[test]
fn a_mirrored_element_counts_with_a_positive_volume() {
    let mirrored: Vec<u32> = CUBE_TETS
        .chunks(4)
        .flat_map(|tet| [tet[1], tet[0], tet[2], tet[3]])
        .collect();
    let hexes = [3, 2, 1, 0, 7, 6, 5, 4];
    let tet_bodies = [1; 6];
    let tets = body_statistics(
        &BodyMesh {
            tets: &mirrored,
            ..mesh(&CUBE, &tet_bodies)
        },
        &[],
    )
    .unwrap();
    let hex = body_statistics(
        &BodyMesh {
            hexes: &hexes,
            ..mesh(&CUBE, &[1])
        },
        &[],
    )
    .unwrap();
    close(tets[0].volume, 1.0);
    close(hex[0].volume, 1.0);
}

/// Node coordinates, tet and hex connectivity, nodes per tet and per hex.
type SolverMesh = (Vec<f64>, Vec<u32>, Vec<u32>, usize, usize);

/// The cube as tets and, apart from it two along x, as a hex, raised to
/// `order` by the solver's own mesh: the connectivity the solve sees.
fn solver_mesh(order: ElementOrder) -> Result<SolverMesh, FemError> {
    let mut points = CUBE.to_vec();
    points.extend(
        CUBE.chunks(3)
            .flat_map(|point| [point[0] + 2.0, point[1], point[2]]),
    );
    let hex: Vec<u32> = (8..16).collect();
    let material = Isotropic::new(0, 210_000.0, 0.3)?;
    let solid = TetMesh::with_hexahedra(&points, &CUBE_TETS, &hex, &[0; 7], vec![material])?
        .with_order(order)?;
    let nodes = solid.node_coordinates().iter().flatten().copied().collect();
    let tets: Vec<u32> = (0..6)
        .flat_map(|element| solid.element_nodes(element).to_vec())
        .collect();
    let hexes = solid.element_nodes(6).to_vec();
    Ok((
        nodes,
        tets,
        hexes,
        solid.element_nodes(0).len(),
        solid.element_nodes(6).len(),
    ))
}

#[test]
fn quadratic_elements_have_the_statistics_of_their_corners() {
    let bodies = [1, 1, 1, 1, 1, 1, 2];
    let statistics = |order| {
        let (points, tets, hexes, tet_nodes, hex_nodes) = solver_mesh(order).unwrap();
        body_statistics(
            &BodyMesh {
                tets: &tets,
                tet_nodes,
                hexes: &hexes,
                hex_nodes,
                ..mesh(&points, &bodies)
            },
            &[(1, STEEL), (2, STEEL)],
        )
        .unwrap()
    };
    let linear = statistics(ElementOrder::Linear);
    let quadratic = statistics(ElementOrder::Quadratic);
    assert_eq!(linear, quadratic);
    close(quadratic[0].volume, 1.0);
    close(quadratic[0].mean_edge_length, cube_edge_mean());
    close(quadratic[1].volume, 1.0);
    close(quadratic[1].mean_edge_length, 1.0);
}

#[test]
fn a_shell_facet_weighs_its_area_times_its_thickness() {
    let points = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    let input = BodyMesh {
        shell_triangles: &[0, 1, 2],
        shell_thicknesses: &[2.0],
        ..mesh(&points, &[5])
    };
    let stats = body_statistics(&input, &[(5, STEEL)]).unwrap();
    close(stats[0].volume, 1.0);
    close(stats[0].mean_edge_length, (2.0 + 2.0_f64.sqrt()) / 3.0);
    close(stats[0].mass.unwrap(), STEEL);
}

#[test]
fn each_body_counts_its_own_elements_and_edges() {
    let (points, tets, hexes, _, _) = solver_mesh(ElementOrder::Linear).unwrap();
    let bodies = [2, 2, 2, 2, 2, 2, 1];
    let input = BodyMesh {
        tets: &tets,
        hexes: &hexes,
        ..mesh(&points, &bodies)
    };
    let stats = body_statistics(&input, &[(2, STEEL)]).unwrap();
    let ids: Vec<u32> = stats.iter().map(|body| body.body).collect();
    assert_eq!(ids, [1, 2]);
    assert_eq!(stats[0].elements, 1);
    assert_eq!(stats[1].elements, 6);
    close(stats[0].mean_edge_length, 1.0);
    close(stats[1].mean_edge_length, cube_edge_mean());
}

#[test]
fn a_body_without_a_density_has_no_mass() {
    let bodies = [1, 1, 1, 1, 1, 1, 2];
    let (points, tets, hexes, _, _) = solver_mesh(ElementOrder::Linear).unwrap();
    let input = BodyMesh {
        tets: &tets,
        hexes: &hexes,
        ..mesh(&points, &bodies)
    };
    // Body 1 has a material of density zero, body 2 no density at all.
    let stats = body_statistics(&input, &[(1, 0.0)]).unwrap();
    assert_eq!(stats[0].mass, None);
    assert_eq!(stats[1].mass, None);
    close(stats[0].volume, 1.0);
}

/// Whether `input` is refused as invalid with a reason that names `about`.
fn rejected(input: &BodyMesh, densities: &[(u32, f64)], about: &str) -> bool {
    matches!(
        body_statistics(input, densities),
        Err(FemError::MeshStatisticsInput { reason }) if reason.contains(about)
    )
}

#[test]
fn malformed_input_is_rejected() {
    let bodies = [1; 6];
    let tets = BodyMesh {
        tets: &CUBE_TETS,
        ..mesh(&CUBE, &bodies)
    };
    assert!(rejected(
        &BodyMesh {
            bodies: &[1; 5],
            ..tets
        },
        &[],
        "body"
    ));
    assert!(rejected(
        &BodyMesh {
            tet_nodes: 5,
            ..tets
        },
        &[],
        "4 or 10"
    ));
    assert!(rejected(
        &BodyMesh {
            hex_nodes: 20,
            ..tets
        },
        &[],
        "8 or 27"
    ));
    assert!(rejected(
        &BodyMesh {
            points: &CUBE[..21],
            ..tets
        },
        &[],
        "node"
    ));
    assert!(rejected(&tets, &[(1, -1.0)], "density"));
    assert!(rejected(&tets, &[(1, f64::NAN)], "density"));
    assert!(rejected(&tets, &[(1, STEEL), (1, STEEL)], "twice"));
    let shell = BodyMesh {
        shell_triangles: &[0, 1, 2],
        shell_thicknesses: &[],
        ..mesh(&CUBE, &[1])
    };
    assert!(rejected(&shell, &[], "thickness"));
}
