// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The mortar integrals ties and contact share: the diagonal slave matrix D,
//! the coupling matrix M, nodal normals and weighted gaps.
//!
//! * Over two parallel, non-matching surfaces a distance g apart, every
//!   covered slave node has the slave surface's normal, Σₖ Mⱼₖ = Dⱼⱼ (a
//!   rigid motion opens no gap), and weighted gap g·Dⱼⱼ.
//! * The tie weights are D⁻¹M of the same integrals.
//! * A nodal normal averages the normals of the slave faces around the node,
//!   weighted by the node's share of each face.

#![allow(
    clippy::expect_used,
    clippy::cast_precision_loss,
    reason = "test fixtures: small structured surfaces, and a fixture that fails to build should \
              abort the test"
)]

use kofem_fem::{mortar_integrals, mortar_weights, MortarFace};

/// A flat grid of `cells` quadrilaterals (or two triangles each) over
/// [0, `size`]² at height `height`, its nodes numbered from `first`, bounding
/// elements on the `below` side.
fn grid(cells: [usize; 2], size: f64, height: f64, first: usize, below: bool) -> Vec<MortarFace> {
    let [nx, ny] = cells;
    let point = |i: usize, j: usize| {
        [
            size * i as f64 / nx as f64,
            size * j as f64 / ny as f64,
            height,
        ]
    };
    let id = |i: usize, j: usize| first + i + (nx + 1) * j;
    let outward = if below { -1.0 } else { 1.0 };
    let mut faces = Vec::new();
    for j in 0..ny {
        for i in 0..nx {
            let corners = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
            let face = |local: &[usize]| {
                let points: Vec<[f64; 3]> = local
                    .iter()
                    .map(|&k| point(corners[k][0], corners[k][1]))
                    .collect();
                let mut centroid = [0.0; 3];
                for point in &points {
                    for axis in 0..3 {
                        centroid[axis] += point[axis] / points.len() as f64;
                    }
                }
                centroid[2] += outward * size / nx as f64;
                MortarFace {
                    nodes: local
                        .iter()
                        .map(|&k| id(corners[k][0], corners[k][1]))
                        .collect(),
                    points,
                    element_centroid: centroid,
                }
            };
            if (i + j) % 2 == 0 {
                faces.push(face(&[0, 1, 2, 3]));
            } else {
                faces.push(face(&[0, 1, 2]));
                faces.push(face(&[0, 2, 3]));
            }
        }
    }
    faces
}

const GAP: f64 = 0.25;

/// The slave surface is the top of a lower body (normal +z); the master the
/// bottom of an upper body, `GAP` above.
fn parallel() -> (Vec<MortarFace>, Vec<MortarFace>) {
    (
        grid([5, 4], 2.0, 0.0, 0, true),
        grid([3, 3], 2.0, GAP, 1000, false),
    )
}

#[test]
fn parallel_surfaces_have_the_slave_normal_and_a_uniform_gap() {
    let (slave, master) = parallel();
    let integrals = mortar_integrals(&slave, &master, f64::INFINITY).expect("mortar integrals");
    assert_eq!(integrals.len(), 6 * 5, "every slave node is covered");
    for node in &integrals {
        assert!(node.diagonal > 0.0);
        let sum: f64 = node.coupling.iter().sum();
        assert!(
            (sum - node.diagonal).abs() <= 1e-14 * node.diagonal,
            "node {}: Σ M = {sum}, D = {}",
            node.slave,
            node.diagonal
        );
        assert!(
            (node.normal[2] - 1.0).abs() < 1e-14
                && node.normal[0].abs() < 1e-14
                && node.normal[1].abs() < 1e-14,
            "node {} normal {:?}",
            node.slave,
            node.normal
        );
        let gap = node.weighted_gap / node.diagonal;
        assert!(
            (gap - GAP).abs() < 1e-13,
            "node {}: gap {gap}, expected {GAP}",
            node.slave
        );
    }
}

#[test]
fn tie_weights_are_d_inverse_m() {
    let (slave, master) = parallel();
    let integrals = mortar_integrals(&slave, &master, f64::INFINITY).expect("mortar integrals");
    let rows = mortar_weights(&slave, &master, f64::INFINITY).expect("mortar weights");
    assert_eq!(rows.len(), integrals.len());
    for (row, node) in rows.iter().zip(&integrals) {
        assert_eq!(row.slave, node.slave);
        for (master, weight) in row.masters.iter().zip(&row.weights) {
            let index = node
                .masters
                .iter()
                .position(|other| other == master)
                .expect("a tie master is a mortar master");
            let expected = node.coupling[index] / node.diagonal;
            assert!(
                (weight - expected).abs() < 1e-12,
                "node {} master {master}: {weight} vs D⁻¹M {expected}",
                node.slave
            );
        }
    }
}

#[test]
fn a_nodal_normal_averages_the_faces_around_the_node() {
    // A roof: two unit squares meeting at the ridge x = 0, sloped ±30°, the
    // body below. The ridge nodes' normal is the bisector, +z.
    let (sin, cos) = 30_f64.to_radians().sin_cos();
    let roof = |side: f64, nodes: [usize; 4]| {
        let points = vec![
            [0.0, 0.0, 0.0],
            [side * cos, 0.0, -sin],
            [side * cos, 1.0, -sin],
            [0.0, 1.0, 0.0],
        ];
        MortarFace {
            nodes: nodes.to_vec(),
            points,
            element_centroid: [side * 0.5 * cos, 0.5, -1.0],
        }
    };
    let slave = vec![roof(1.0, [0, 1, 2, 3]), roof(-1.0, [0, 4, 5, 3])];
    let master = grid([4, 4], 4.0, 0.5, 1000, false)
        .into_iter()
        .map(|mut face| {
            for point in &mut face.points {
                point[0] -= 2.0;
                point[1] -= 1.5;
            }
            face.element_centroid[0] -= 2.0;
            face.element_centroid[1] -= 1.5;
            face
        })
        .collect::<Vec<_>>();
    let integrals = mortar_integrals(&slave, &master, f64::INFINITY).expect("mortar integrals");
    for node in &integrals {
        let expected = match node.slave {
            0 | 3 => [0.0, 0.0, 1.0],
            1 | 2 => [sin, 0.0, cos],
            _ => [-sin, 0.0, cos],
        };
        for axis in 0..3 {
            assert!(
                (node.normal[axis] - expected[axis]).abs() < 1e-12,
                "node {}: normal {:?}, expected {expected:?}",
                node.slave,
                node.normal
            );
        }
    }
    assert!(integrals.iter().any(|node| node.slave == 0));
}
