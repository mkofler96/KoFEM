// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Thermal loads on solid meshes through the whole static solve: free thermal
//! expansion (no stress), a fully restrained block (pure thermal stress,
//! balanced by the support reactions) and a linear temperature field in a
//! free body, on linear and quadratic tetrahedra and hexahedra.

#![allow(
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "test fixtures: small structured meshes whose indices fit any integer type, \
              and a fixture that fails to build should abort the test"
)]

#[allow(
    dead_code,
    reason = "only the mesh of the shared box fixture is used here"
)]
mod support;

use kofem_fem::element::{
    hex27_reference_gradients, hex8_reference_gradients, hex_gradients, tet10_gradients,
    tet4_gradients, CENTROID, HEX_CENTRE,
};
use kofem_fem::{
    assemble_stiffness, solve_static, thermal_load, thermal_strain_at_centre,
    thermal_strains_at_centres, CgSettings, ElementOrder, ElementShape, FemError, Isotropic,
    PreconditionerChoice, StoppingRule, TetMesh,
};
use support::box_mesh;

const SETTINGS: CgSettings = CgSettings {
    relative_tolerance: 1e-12,
    max_iterations: 20_000,
    stopping: StoppingRule::ResidualNorm,
};
const GS: PreconditionerChoice = PreconditionerChoice::SymmetricGaussSeidel;
const YOUNG: f64 = 210_000.0;
const POISSON: f64 = 0.3;
/// Steel, 1/°C.
const ALPHA: f64 = 1.2e-5;
const SIZE: [f64; 3] = [2.0, 1.0, 1.5];

fn steel() -> Isotropic {
    Isotropic::new(0, YOUNG, POISSON).expect("valid material")
}

/// A box of `cells` hexahedra over `SIZE`; with `distort`, interior vertices
/// move off the grid so the hexes are not parallelepipeds.
fn hex_box(cells: [usize; 3], distort: bool) -> TetMesh {
    let [nx, ny, nz] = cells;
    let index = |ix: usize, iy: usize, iz: usize| (ix + (nx + 1) * (iy + (ny + 1) * iz)) as u32;
    let mut vertices = Vec::new();
    for iz in 0..=nz {
        for iy in 0..=ny {
            for ix in 0..=nx {
                let interior = ix > 0 && ix < nx && iy > 0 && iy < ny && iz > 0 && iz < nz;
                let shift = if distort && interior {
                    let seed = (ix * 7 + iy * 13 + iz * 5) % 5;
                    0.15 * (seed as f64 - 2.0) / 2.0
                } else {
                    0.0
                };
                vertices.extend([
                    SIZE[0] * (ix as f64 + shift) / nx as f64,
                    SIZE[1] * (iy as f64 - shift) / ny as f64,
                    SIZE[2] * (iz as f64 + 0.5 * shift) / nz as f64,
                ]);
            }
        }
    }
    let mut hexes = Vec::new();
    for iz in 0..nz {
        for iy in 0..ny {
            for ix in 0..nx {
                hexes.extend([
                    index(ix, iy, iz),
                    index(ix + 1, iy, iz),
                    index(ix + 1, iy + 1, iz),
                    index(ix, iy + 1, iz),
                    index(ix, iy, iz + 1),
                    index(ix + 1, iy, iz + 1),
                    index(ix + 1, iy + 1, iz + 1),
                    index(ix, iy + 1, iz + 1),
                ]);
            }
        }
    }
    let materials = vec![0; hexes.len() / 8];
    TetMesh::with_hexahedra(&vertices, &[], &hexes, &materials, vec![steel()]).expect("valid box")
}

fn tet_box(cells: [usize; 3]) -> TetMesh {
    box_mesh(cells, SIZE, steel()).mesh
}

fn quadratic(mesh: TetMesh) -> TetMesh {
    mesh.with_order(ElementOrder::Quadratic)
        .expect("quadratic mesh")
}

/// The vertex at `point`.
fn vertex_at(mesh: &TetMesh, point: [f64; 3]) -> usize {
    mesh.vertices()
        .iter()
        .position(|vertex| (0..3).all(|axis| (vertex[axis] - point[axis]).abs() < 1e-12))
        .expect("vertex exists")
}

/// Minimal statically determinate supports of the box: the origin fixed, the
/// corner on the x axis held in y and z, the corner on the y axis in z.
fn three_two_one(mesh: &TetMesh) -> Vec<u32> {
    let origin = vertex_at(mesh, [0.0; 3]);
    let on_x = vertex_at(mesh, [SIZE[0], 0.0, 0.0]);
    let on_y = vertex_at(mesh, [0.0, SIZE[1], 0.0]);
    [
        3 * origin,
        3 * origin + 1,
        3 * origin + 2,
        3 * on_x + 1,
        3 * on_x + 2,
        3 * on_y + 2,
    ]
    .map(|dof| dof as u32)
    .to_vec()
}

fn solve(mesh: &TetMesh, fixed: &[u32], forces: &[f64]) -> Vec<f64> {
    let stiffness = assemble_stiffness(mesh);
    let values = vec![0.0; fixed.len()];
    solve_static(mesh, &stiffness, fixed, &values, forces, SETTINGS, GS)
        .expect("solve converges")
        .displacements
}

/// Displacement gradient `∂u_i/∂x_j` of `element` at its centre, the point
/// where stresses are recovered.
fn centre_gradient(mesh: &TetMesh, element: usize, displacements: &[f64]) -> [[f64; 3]; 3] {
    let gradients: Vec<[f64; 3]> = match mesh.shape(element) {
        ElementShape::Tetrahedron => {
            let (corner, _) = tet4_gradients(&mesh.corners(element));
            match mesh.order() {
                ElementOrder::Linear => corner.to_vec(),
                ElementOrder::Quadratic => tet10_gradients(&corner, CENTROID).to_vec(),
            }
        }
        ElementShape::Hexahedron => {
            let corners = mesh.hex_corners(element - mesh.tets().len());
            match mesh.order() {
                ElementOrder::Linear => {
                    let reference = hex8_reference_gradients(HEX_CENTRE);
                    hex_gradients(&corners, &reference, HEX_CENTRE).0.to_vec()
                }
                ElementOrder::Quadratic => {
                    let reference = hex27_reference_gradients(HEX_CENTRE);
                    hex_gradients(&corners, &reference, HEX_CENTRE).0.to_vec()
                }
            }
        }
    };
    let mut gradient = [[0.0; 3]; 3];
    for (node, shape) in mesh.element_nodes(element).iter().zip(&gradients) {
        for (row, entries) in gradient.iter_mut().enumerate() {
            for (col, entry) in entries.iter_mut().enumerate() {
                *entry += displacements[3 * *node as usize + row] * shape[col];
            }
        }
    }
    gradient
}

/// Stress `σ = D·(ε − ε_th·I)` of `element` at its centre.
fn centre_stress(
    mesh: &TetMesh,
    element: usize,
    displacements: &[f64],
    alpha: &[f64],
    delta_t: &[f64],
) -> [[f64; 3]; 3] {
    let gradient = centre_gradient(mesh, element, displacements);
    let thermal =
        thermal_strain_at_centre(mesh, element, alpha, delta_t).expect("valid thermal input");
    let (lambda, mu) = mesh.material(element).lame();
    let mut mechanical = [[0.0; 3]; 3];
    for (row, entries) in mechanical.iter_mut().enumerate() {
        for (col, entry) in entries.iter_mut().enumerate() {
            *entry = f64::midpoint(gradient[row][col], gradient[col][row]);
            if row == col {
                *entry -= thermal;
            }
        }
    }
    let trace = mechanical[0][0] + mechanical[1][1] + mechanical[2][2];
    let mut stress = [[0.0; 3]; 3];
    for (row, entries) in stress.iter_mut().enumerate() {
        for (col, entry) in entries.iter_mut().enumerate() {
            *entry =
                2.0 * mu * mechanical[row][col] + if row == col { lambda * trace } else { 0.0 };
        }
    }
    stress
}

fn max_abs(matrix: &[[f64; 3]; 3]) -> f64 {
    matrix
        .iter()
        .flatten()
        .fold(0.0, |most, value| most.max(value.abs()))
}

/// Free expansion under a uniform ΔT: u = α·ΔT·x from the origin, strain
/// α·ΔT in every direction and no stress, on every element.
fn assert_free_expansion(mesh: &TetMesh) {
    let delta_t = 80.0;
    let alpha = vec![ALPHA; mesh.element_count()];
    let temperatures = vec![delta_t; mesh.node_count()];
    let forces = thermal_load(mesh, &alpha, &temperatures).expect("valid thermal input");
    let displacements = solve(mesh, &three_two_one(mesh), &forces);
    let strain = ALPHA * delta_t;
    let scale = strain * SIZE[0];
    for (node, point) in mesh.node_coordinates().iter().enumerate() {
        for axis in 0..3 {
            let expected = strain * point[axis];
            let actual = displacements[3 * node + axis];
            assert!(
                (actual - expected).abs() <= 1e-8 * scale,
                "node {node} axis {axis}: {actual} vs {expected}"
            );
        }
    }
    // The stress a fully restrained block would carry, for scale.
    let restrained = YOUNG * strain / (1.0 - 2.0 * POISSON);
    for element in 0..mesh.element_count() {
        let gradient = centre_gradient(mesh, element, &displacements);
        for (axis, row) in gradient.iter().enumerate() {
            assert!((row[axis] - strain).abs() <= 1e-8 * strain);
        }
        let centre = thermal_strain_at_centre(mesh, element, &alpha, &temperatures)
            .expect("valid thermal input");
        assert!((centre - strain).abs() <= 1e-14);
        let stress = centre_stress(mesh, element, &displacements, &alpha, &temperatures);
        assert!(
            max_abs(&stress) <= 1e-7 * restrained,
            "element {element}: stress {stress:?}"
        );
    }
}

#[test]
fn uniform_temperature_expands_a_free_tet4_block_without_stress() {
    assert_free_expansion(&tet_box([3, 2, 2]));
}

#[test]
fn uniform_temperature_expands_a_free_tet10_block_without_stress() {
    assert_free_expansion(&quadratic(tet_box([2, 2, 2])));
}

#[test]
fn uniform_temperature_expands_a_free_hex8_block_without_stress() {
    assert_free_expansion(&hex_box([3, 3, 3], true));
}

#[test]
fn uniform_temperature_expands_a_free_hex27_block_without_stress() {
    assert_free_expansion(&quadratic(hex_box([3, 3, 3], true)));
}

/// Every node component on a face normal to it held at zero: the six faces of
/// the box restrained against their normal motion.
fn normal_supports(mesh: &TetMesh) -> Vec<u32> {
    let mut fixed = Vec::new();
    for (node, point) in mesh.node_coordinates().iter().enumerate() {
        for axis in 0..3 {
            if point[axis].abs() < 1e-12 || (point[axis] - SIZE[axis]).abs() < 1e-12 {
                fixed.push((3 * node + axis) as u32);
            }
        }
    }
    fixed
}

/// A block whose six faces are held against normal motion does not move; it
/// carries σ = −E·α·ΔT/(1 − 2ν) in every direction, and the reactions on
/// each face balance that stress over its area.
fn assert_restrained(mesh: &TetMesh) {
    let delta_t = 60.0;
    let alpha = vec![ALPHA; mesh.element_count()];
    let temperatures = vec![delta_t; mesh.node_count()];
    let forces = thermal_load(mesh, &alpha, &temperatures).expect("valid thermal input");
    let fixed = normal_supports(mesh);
    let displacements = solve(mesh, &fixed, &forces);
    let strain = ALPHA * delta_t;
    let peak = displacements
        .iter()
        .fold(0.0_f64, |most, value| most.max(value.abs()));
    assert!(peak <= 1e-10 * strain * SIZE[0], "displacement {peak}");

    let expected = -YOUNG * strain / (1.0 - 2.0 * POISSON);
    for element in 0..mesh.element_count() {
        let stress = centre_stress(mesh, element, &displacements, &alpha, &temperatures);
        for (row, entries) in stress.iter().enumerate() {
            for (col, value) in entries.iter().enumerate() {
                let target = if row == col { expected } else { 0.0 };
                assert!(
                    (value - target).abs() <= 1e-8 * expected.abs(),
                    "element {element} σ[{row}][{col}] = {value}, expected {target}"
                );
            }
        }
    }

    // Reactions R = K·u − f at the supports; with u = 0 they are −f.
    let stiffness = assemble_stiffness(mesh);
    let mut internal = vec![0.0; mesh.dof_count()];
    stiffness.mul_vec(&displacements, &mut internal);
    for axis in 0..3 {
        let area = SIZE[(axis + 1) % 3] * SIZE[(axis + 2) % 3];
        let mut far_face = 0.0;
        let mut near_face = 0.0;
        for (node, point) in mesh.node_coordinates().iter().enumerate() {
            let dof = 3 * node + axis;
            let reaction = internal[dof] - forces[dof];
            if (point[axis] - SIZE[axis]).abs() < 1e-12 {
                far_face += reaction;
            } else if point[axis].abs() < 1e-12 {
                near_face += reaction;
            }
        }
        // The far face pushes in (−axis) on a body that wants to expand: the
        // reaction there is σ·A, the near one −σ·A.
        assert!((far_face - expected * area).abs() <= 1e-9 * (expected * area).abs());
        assert!((near_face + expected * area).abs() <= 1e-9 * (expected * area).abs());
    }
    // Interior and tangential components carry no thermal load.
    let free: Vec<usize> = (0..mesh.dof_count())
        .filter(|dof| !fixed.contains(&(*dof as u32)))
        .collect();
    let largest = forces
        .iter()
        .fold(0.0_f64, |most, value| most.max(value.abs()));
    for dof in free {
        assert!(
            forces[dof].abs() <= 1e-10 * largest,
            "dof {dof}: {}",
            forces[dof]
        );
    }
}

#[test]
fn restrained_tet4_block_carries_the_full_thermal_stress() {
    assert_restrained(&tet_box([3, 2, 2]));
}

#[test]
fn restrained_hex8_block_carries_the_full_thermal_stress() {
    assert_restrained(&hex_box([2, 2, 2], true));
}

#[test]
fn restrained_tet10_block_carries_the_full_thermal_stress() {
    assert_restrained(&quadratic(tet_box([2, 1, 1])));
}

/// ΔT = T0 + a·x + b·y + c·z: a linear temperature field in a free body is
/// compatible (θ_,ij = 0), so the body deforms without stress. Quadratic
/// elements represent the quadratic displacement exactly.
fn linear_field(point: [f64; 3]) -> f64 {
    20.0 + 30.0 * point[0] - 15.0 * point[1] + 40.0 * point[2]
}

/// Largest centre stress of the free body under the linear field, relative
/// to the stress a fully restrained body would carry at the hottest point.
fn linear_field_stress(mesh: &TetMesh) -> f64 {
    let alpha = vec![ALPHA; mesh.element_count()];
    let temperatures: Vec<f64> = mesh
        .node_coordinates()
        .iter()
        .map(|point| linear_field(*point))
        .collect();
    let forces = thermal_load(mesh, &alpha, &temperatures).expect("valid thermal input");
    let displacements = solve(mesh, &three_two_one(mesh), &forces);
    let hottest = temperatures
        .iter()
        .fold(0.0_f64, |most, value| most.max(value.abs()));
    let restrained = YOUNG * ALPHA * hottest / (1.0 - 2.0 * POISSON);
    (0..mesh.element_count())
        .map(|element| {
            max_abs(&centre_stress(
                mesh,
                element,
                &displacements,
                &alpha,
                &temperatures,
            ))
        })
        .fold(0.0, f64::max)
        / restrained
}

#[test]
fn linear_temperature_field_leaves_a_free_tet10_block_unstressed() {
    let relative = linear_field_stress(&quadratic(tet_box([2, 2, 2])));
    assert!(relative <= 1e-7, "relative stress {relative}");
}

#[test]
fn linear_temperature_field_leaves_a_free_hex27_block_unstressed() {
    let relative = linear_field_stress(&quadratic(hex_box([2, 2, 2], true)));
    assert!(relative <= 1e-7, "relative stress {relative}");
}

/// Linear tets have constant strain per element, which cannot follow a
/// varying α·ΔT·I across element faces (the jump of a continuous field's
/// gradient is rank one), so a linear field leaves a discretisation stress
/// that shrinks as the mesh is refined.
#[test]
fn linear_temperature_field_stress_on_tet4_vanishes_under_refinement() {
    let coarse = linear_field_stress(&tet_box([2, 1, 1]));
    let fine = linear_field_stress(&tet_box([4, 2, 2]));
    let finer = linear_field_stress(&tet_box([8, 4, 4]));
    assert!(fine < 0.7 * coarse, "coarse {coarse}, fine {fine}");
    assert!(finer < 0.7 * fine, "fine {fine}, finer {finer}");
    assert!(finer < 0.05, "finer {finer}");
}

#[test]
fn centre_strain_interpolates_the_nodal_temperatures() {
    // Element-wise: α·ΔT at the centroid of a linear tet is α × the mean of
    // its four nodal values; the linear field is reproduced exactly at the
    // centre of every element type.
    for mesh in [
        tet_box([2, 1, 1]),
        quadratic(tet_box([2, 1, 1])),
        hex_box([2, 1, 1], false),
        quadratic(hex_box([2, 1, 1], false)),
    ] {
        let alpha: Vec<f64> = (0..mesh.element_count())
            .map(|element| ALPHA * (1.0 + element as f64))
            .collect();
        let temperatures: Vec<f64> = mesh
            .node_coordinates()
            .iter()
            .map(|point| linear_field(*point))
            .collect();
        let all = thermal_strains_at_centres(&mesh, &alpha, &temperatures).expect("valid input");
        assert_eq!(all.len(), mesh.element_count());
        for element in 0..mesh.element_count() {
            let nodes = mesh.element_nodes(element);
            let corners = match mesh.shape(element) {
                ElementShape::Tetrahedron => 4,
                ElementShape::Hexahedron => 8,
            };
            let mut centre = [0.0; 3];
            for node in &nodes[..corners] {
                let point = mesh.node_coordinates()[*node as usize];
                for (total, coordinate) in centre.iter_mut().zip(point) {
                    *total += coordinate / corners as f64;
                }
            }
            let expected = alpha[element] * linear_field(centre);
            let single = thermal_strain_at_centre(&mesh, element, &alpha, &temperatures)
                .expect("valid input");
            assert!((single - expected).abs() <= 1e-12 * expected.abs());
            assert!((all[element] - single).abs() <= 1e-18);
        }
    }
}

#[test]
fn thermal_input_lengths_and_values_are_checked() {
    let mesh = quadratic(tet_box([1, 1, 1]));
    let alpha = vec![ALPHA; mesh.element_count()];
    let temperatures = vec![10.0; mesh.node_count()];
    assert_eq!(
        thermal_load(&mesh, &alpha[1..], &temperatures),
        Err(FemError::ExpansionCoefficientCount {
            count: mesh.element_count() - 1,
            elements: mesh.element_count(),
        })
    );
    // Per node, not per vertex: a quadratic mesh needs its added nodes too.
    assert_eq!(
        thermal_load(&mesh, &alpha, &temperatures[..mesh.vertex_count()]),
        Err(FemError::TemperatureCount {
            count: mesh.vertex_count(),
            nodes: mesh.node_count(),
        })
    );
    let mut bad = temperatures.clone();
    bad[3] = f64::NAN;
    assert!(matches!(
        thermal_load(&mesh, &alpha, &bad),
        Err(FemError::NonFinite { .. })
    ));
    let mut bad_alpha = alpha.clone();
    bad_alpha[0] = f64::INFINITY;
    assert!(matches!(
        thermal_load(&mesh, &bad_alpha, &temperatures),
        Err(FemError::NonFinite { .. })
    ));
    assert_eq!(
        thermal_strain_at_centre(&mesh, mesh.element_count(), &alpha, &temperatures),
        Err(FemError::ElementOutOfRange {
            element: mesh.element_count(),
            count: mesh.element_count(),
        })
    );
}

#[test]
fn zero_temperature_change_gives_no_load() {
    let mesh = hex_box([1, 1, 1], false);
    let forces = thermal_load(&mesh, &[ALPHA], &vec![0.0; mesh.node_count()]).expect("valid input");
    assert!(forces.iter().all(|value| *value == 0.0));
}
