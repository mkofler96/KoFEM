// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

#![allow(
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "test fixtures: small structured meshes whose indices fit any integer type, \
              and a fixture that fails to build should abort the test"
)]

mod support;

use kofem_fem::{
    assemble_stiffness, solve_static, von_mises, AmgSettings, BoundaryFaces, CgSettings, FemError,
    Isotropic, PreconditionerChoice, StoppingRule, SurfaceLoadKind,
};
use support::{box_mesh, BoxMesh};

const SIZE: [f64; 3] = [4.0, 2.0, 1.0];

fn steel() -> Isotropic {
    Isotropic::new(0, 210_000.0, 0.3).expect("valid material")
}

/// Every element face whose three corners lie on the plane `axis` = `value`:
/// on a box those are exactly the boundary triangles of that side.
fn side(built: &BoxMesh, axis: usize, value: f64) -> Vec<[u32; 3]> {
    let on = |vertex: u32| (built.vertices[vertex as usize][axis] - value).abs() < 1e-12;
    let mut faces = Vec::new();
    for tet in built.mesh.tets() {
        for skip in 0..4 {
            let face: Vec<u32> = (0..4)
                .filter(|&corner| corner != skip)
                .map(|corner| tet[corner])
                .collect();
            if face.iter().all(|&vertex| on(vertex)) {
                faces.push([face[0], face[1], face[2]]);
            }
        }
    }
    faces
}

fn resultant(forces: &[f64]) -> [f64; 3] {
    let mut sum = [0.0; 3];
    for (index, force) in forces.iter().enumerate() {
        sum[index % 3] += force;
    }
    sum
}

fn close(lhs: [f64; 3], rhs: [f64; 3]) -> bool {
    lhs.iter()
        .zip(rhs)
        .all(|(left, right)| (left - right).abs() <= 1e-9 * (1.0 + right.abs()))
}

#[test]
fn pressure_pushes_along_the_inward_normal() {
    let built = box_mesh([4, 2, 2], SIZE, steel());
    let boundary = BoundaryFaces::new(&built.mesh);
    let mut forces = vec![0.0; 3 * built.vertices.len()];
    // The far end (x = 4) has outward normal +x and area 2·1.
    let report = boundary
        .apply(
            &built.mesh,
            0,
            &side(&built, 0, built.size[0]),
            &[],
            SurfaceLoadKind::Pressure(5.0),
            &mut forces,
        )
        .expect("applies");
    assert_eq!(report.unmatched, 0);
    assert!(close(resultant(&forces), [-10.0, 0.0, 0.0]));
    // The bottom (z = 0) has outward normal −z and area 4·2.
    let mut bottom = vec![0.0; forces.len()];
    boundary
        .apply(
            &built.mesh,
            1,
            &side(&built, 2, 0.0),
            &[],
            SurfaceLoadKind::Pressure(1.0),
            &mut bottom,
        )
        .expect("applies");
    assert!(close(resultant(&bottom), [0.0, 0.0, 8.0]));
}

#[test]
fn total_force_and_traction_have_the_right_resultant() {
    let built = box_mesh([4, 2, 2], SIZE, steel());
    let boundary = BoundaryFaces::new(&built.mesh);
    let top = side(&built, 2, built.size[2]);
    let mut forces = vec![0.0; 3 * built.vertices.len()];
    boundary
        .apply(
            &built.mesh,
            0,
            &top,
            &[],
            SurfaceLoadKind::Force([1.0, -2.0, 30.0]),
            &mut forces,
        )
        .expect("applies");
    assert!(close(resultant(&forces), [1.0, -2.0, 30.0]));
    let mut traction = vec![0.0; forces.len()];
    boundary
        .apply(
            &built.mesh,
            1,
            &top,
            &[],
            SurfaceLoadKind::Traction([0.0, 0.5, 0.0]),
            &mut traction,
        )
        .expect("applies");
    assert!(close(resultant(&traction), [0.0, 4.0, 0.0]));
}

#[test]
fn duplicates_count_once_and_interior_faces_are_reported() {
    let built = box_mesh([2, 1, 1], [2.0, 1.0, 1.0], steel());
    let boundary = BoundaryFaces::new(&built.mesh);
    let mut end = side(&built, 0, 2.0);
    let first = end[0];
    // The same face again, listed in another order.
    end.push([first[2], first[0], first[1]]);
    // An interior face: the plane x = 1 between the two cubes.
    let interior = side(&built, 0, 1.0);
    end.push(interior[0]);
    let mut forces = vec![0.0; 3 * built.vertices.len()];
    let report = boundary
        .apply(
            &built.mesh,
            0,
            &end,
            &[],
            SurfaceLoadKind::Force([6.0, 0.0, 0.0]),
            &mut forces,
        )
        .expect("applies");
    assert_eq!(report.matched, side(&built, 0, 2.0).len());
    assert_eq!(report.unmatched, 1);
    assert!(close(resultant(&forces), [6.0, 0.0, 0.0]));

    assert_eq!(
        boundary
            .apply(
                &built.mesh,
                3,
                &interior,
                &[],
                SurfaceLoadKind::Pressure(1.0),
                &mut forces
            )
            .err(),
        Some(FemError::SurfaceLoadUnmatched {
            load: 3,
            faces: interior.len()
        })
    );
}

/// Patch test: a box on rollers pulled by a uniform traction is in uniform
/// uniaxial stress, which linear tets reproduce exactly — every element's
/// von Mises stress equals the applied traction.
#[test]
fn uniaxial_tension_gives_uniform_von_mises() {
    let built = box_mesh([6, 3, 2], SIZE, steel());
    let mut fixed = Vec::new();
    for (node, point) in built.vertices.iter().enumerate() {
        for (axis, coordinate) in point.iter().enumerate() {
            if coordinate.abs() < 1e-12 {
                fixed.push((3 * node + axis) as u32);
            }
        }
    }
    let boundary = BoundaryFaces::new(&built.mesh);
    let mut forces = vec![0.0; 3 * built.vertices.len()];
    let stress = 120.0;
    boundary
        .apply(
            &built.mesh,
            0,
            &side(&built, 0, built.size[0]),
            &[],
            SurfaceLoadKind::Traction([stress, 0.0, 0.0]),
            &mut forces,
        )
        .expect("applies");
    let stiffness = assemble_stiffness(&built.mesh);
    let settings = CgSettings {
        relative_tolerance: 1e-10,
        max_iterations: 1_000,
        stopping: StoppingRule::ResidualNorm,
    };
    let solution = solve_static(
        &built.mesh,
        &stiffness,
        &fixed,
        &vec![0.0; fixed.len()],
        &forces,
        settings,
        PreconditionerChoice::SmoothedAggregation(AmgSettings::default()),
    )
    .expect("solves");
    let stresses = von_mises(&built.mesh, &solution.displacements).expect("matching length");
    assert_eq!(stresses.len(), built.mesh.tets().len());
    for value in stresses {
        assert!((value - stress).abs() < 1e-6 * stress, "von Mises {value}");
    }
    assert!(matches!(
        von_mises(&built.mesh, &solution.displacements[1..]),
        Err(FemError::DisplacementLength { .. })
    ));
}
