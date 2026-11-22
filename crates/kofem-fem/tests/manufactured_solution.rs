// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Method of manufactured solutions: the order of convergence of linear and
//! quadratic tetrahedra on a smooth exact solution, with no CAD and no mesher
//! in the way (KOF-399).
//!
//! The exact field is a Papkovich–Neuber solution of Navier's equations with
//! no body force, u = 4(1−ν)·ψ − ∇(z·`ψ_z`), with the harmonic potential
//! ψ = (0, 0, eˣ·sin(y·cos α + z·sin α)). It is smooth, not a polynomial (so
//! neither element reproduces it), and not divergence-free, div u =
//! 2(1−2ν)·∂`ψ_z`/∂z, so the λ part of the stiffness is exercised too. Every
//! boundary node is held at the exact value, and the unit cube is meshed with
//! n³ Kuhn cubes of six tetrahedra each. On a smooth solution, elements of
//! order p converge as hᵖ in the energy norm and as hᵖ⁺¹ in L².

#![allow(
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    dead_code,
    reason = "test fixtures: small structured meshes whose indices fit any integer type, a \
              fixture that fails to build should abort the test, and the shared box-mesh \
              fixture carries fields this test does not read"
)]

mod support;

use kofem_fem::convergence::fit_rate;
use kofem_fem::element::{tet10_gradients, tet4_gradients};
use kofem_fem::mesh::EDGES_OF_TET;
use kofem_fem::{
    assemble_stiffness, solve_static, CgSettings, ElementOrder, FemError, Isotropic,
    PreconditionerChoice, StoppingRule,
};
use support::box_mesh;

const POISSON: f64 = 0.3;
const ALPHA: f64 = 0.6;
const SIZE: [f64; 3] = [1.0, 1.0, 1.0];

fn material() -> Result<Isotropic, FemError> {
    Isotropic::new(0, 1.0, POISSON)
}

/// The exact displacement and its gradient: `gradient[i][j]` = ∂`u_i`/∂`x_j`.
fn exact(point: [f64; 3]) -> ([f64; 3], [[f64; 3]; 3]) {
    let [px, py, pz] = point;
    let (ca, sa) = (ALPHA.cos(), ALPHA.sin());
    let theta = py * ca + pz * sa;
    let (ex, sin, cos) = (px.exp(), theta.sin(), theta.cos());
    let kappa = 3.0 - 4.0 * POISSON;
    let displacement = [
        -pz * ex * sin,
        -pz * ex * cos * ca,
        kappa * ex * sin - pz * ex * cos * sa,
    ];
    let gradient = [
        [
            -pz * ex * sin,
            -pz * ex * cos * ca,
            -ex * sin - pz * ex * cos * sa,
        ],
        [
            -pz * ex * cos * ca,
            pz * ex * sin * ca * ca,
            -ex * cos * ca + pz * ex * sin * ca * sa,
        ],
        [
            kappa * ex * sin - pz * ex * cos * sa,
            kappa * ex * cos * ca + pz * ex * sin * sa * ca,
            (kappa - 1.0) * ex * cos * sa + pz * ex * sin * sa * sa,
        ],
    ];
    (displacement, gradient)
}

/// The test's own premise: the field solves Navier's equations with no body
/// force, μ·Δu + (λ+μ)·∇(div u) = 0, its gradient is the field's, and its
/// divergence does not vanish.
#[test]
fn the_manufactured_field_solves_navier_without_body_force() {
    let (lambda, mu) = material().expect("valid material").lame();
    let step = 1e-4;
    for point in [[0.2, 0.3, 0.4], [0.9, 0.1, 0.7], [0.5, 0.5, 0.5]] {
        let shifted = |axis: usize, by: f64| {
            let mut moved = point;
            moved[axis] += by;
            exact(moved)
        };
        let (_, gradient) = exact(point);
        for j in 0..3 {
            let (plus, minus) = (shifted(j, step).0, shifted(j, -step).0);
            for (i, row) in gradient.iter().enumerate() {
                let difference = (plus[i] - minus[i]) / (2.0 * step);
                assert!(
                    (difference - row[j]).abs() < 1e-7,
                    "∂u{i}/∂x{j}: {difference} vs {}",
                    row[j]
                );
            }
        }
        for i in 0..3 {
            let mut residual = 0.0;
            for j in 0..3 {
                let (plus, minus) = (shifted(j, step).1, shifted(j, -step).1);
                residual += mu * (plus[i][j] - minus[i][j]) / (2.0 * step);
                if j == i {
                    let divergence_change: f64 =
                        (0..3).map(|k| plus[k][k] - minus[k][k]).sum::<f64>() / (2.0 * step);
                    residual += (lambda + mu) * divergence_change;
                }
            }
            assert!(
                residual.abs() < 1e-6,
                "Navier residual {i} at {point:?}: {residual}"
            );
        }
        let divergence = gradient[0][0] + gradient[1][1] + gradient[2][2];
        assert!(divergence.abs() > 0.1, "div u must not vanish");
    }
}

#[allow(
    clippy::cast_precision_loss,
    reason = "quadrature orders and polynomial degrees are tiny"
)]
fn as_float(value: usize) -> f64 {
    value as f64
}

/// Gauss–Legendre points and weights on [0, 1].
fn gauss_legendre(n: usize) -> Vec<(f64, f64)> {
    (0..n)
        .map(|i| {
            // Newton on P_n from the Chebyshev guess.
            let mut root =
                (std::f64::consts::PI * (as_float(i) + 0.75) / (as_float(n) + 0.5)).cos();
            let mut derivative = 0.0;
            for _ in 0..100 {
                let (mut previous, mut current) = (1.0, root);
                for k in 2..=n {
                    let next = (as_float(2 * k - 1) * root * current - as_float(k - 1) * previous)
                        / as_float(k);
                    previous = current;
                    current = next;
                }
                derivative = as_float(n) * (root * current - previous) / (root * root - 1.0);
                let correction = current / derivative;
                root -= correction;
                if correction.abs() < 1e-15 {
                    break;
                }
            }
            let weight = 2.0 / ((1.0 - root * root) * derivative * derivative);
            ((1.0 - root) / 2.0, weight / 2.0)
        })
        .collect()
}

/// A conical-product (collapsed Gauss) rule on the unit tetrahedron: points
/// as barycentric coordinates, weights summing to 1 (fractions of volume).
fn tet_rule(n: usize) -> Vec<([f64; 4], f64)> {
    let points = gauss_legendre(n);
    let mut rule = Vec::new();
    for &(first, w_first) in &points {
        for &(second, w_second) in &points {
            for &(third, w_third) in &points {
                let along_x = first;
                let along_y = second * (1.0 - first);
                let along_z = third * (1.0 - first) * (1.0 - second);
                let jacobian = (1.0 - first).powi(2) * (1.0 - second);
                rule.push((
                    [1.0 - along_x - along_y - along_z, along_x, along_y, along_z],
                    6.0 * w_first * w_second * w_third * jacobian,
                ));
            }
        }
    }
    rule
}

struct Errors {
    l2: f64,
    energy: f64,
}

fn boundary_values(nodes: &[[f64; 3]]) -> (Vec<u32>, Vec<f64>) {
    let on_boundary = |point: [f64; 3]| {
        (0..3).any(|axis| point[axis].abs() < 1e-12 || (point[axis] - SIZE[axis]).abs() < 1e-12)
    };
    let mut dofs = Vec::new();
    let mut values = Vec::new();
    for (node, point) in nodes.iter().enumerate() {
        if on_boundary(*point) {
            for (component, value) in exact(*point).0.into_iter().enumerate() {
                #[allow(
                    clippy::cast_possible_truncation,
                    reason = "the test meshes have a few thousand nodes"
                )]
                dofs.push((3 * node + component) as u32);
                values.push(value);
            }
        }
    }
    (dofs, values)
}

fn solve_and_measure(cells: usize, order: ElementOrder) -> Result<Errors, FemError> {
    let mesh = box_mesh([cells; 3], SIZE, material()?)
        .mesh
        .with_order(order)?;
    let (dofs, values) = boundary_values(mesh.node_coordinates());
    let stiffness = assemble_stiffness(&mesh);
    let forces = vec![0.0; mesh.dof_count()];
    let settings = CgSettings {
        relative_tolerance: 1e-13,
        max_iterations: 50_000,
        stopping: StoppingRule::ResidualNorm,
    };
    let solution = solve_static(
        &mesh,
        &stiffness,
        &dofs,
        &values,
        &forces,
        settings,
        PreconditionerChoice::SymmetricGaussSeidel,
    )?;
    let solved = &solution.displacements;

    let (lambda, mu) = material()?.lame();
    let rule = tet_rule(4);
    let (mut l2, mut energy) = (0.0, 0.0);
    let vertices = mesh.vertices();
    for (element, tet) in mesh.tets().iter().enumerate() {
        let corners = tet.map(|vertex| vertices[vertex as usize]);
        let (corner_gradients, volume) = tet4_gradients(&corners);
        let nodes = mesh.element_nodes(element);
        for &(bary, weight) in &rule {
            let point: [f64; 3] = std::array::from_fn(|axis| {
                (0..4)
                    .map(|corner| bary[corner] * corners[corner][axis])
                    .sum()
            });
            let (shape, gradients): (Vec<f64>, Vec<[f64; 3]>) = match order {
                ElementOrder::Linear => (bary.to_vec(), corner_gradients.to_vec()),
                ElementOrder::Quadratic => {
                    let mut functions = Vec::with_capacity(10);
                    for corner in bary {
                        functions.push(corner * (2.0 * corner - 1.0));
                    }
                    for [first, second] in EDGES_OF_TET {
                        functions.push(4.0 * bary[first] * bary[second]);
                    }
                    (functions, tet10_gradients(&corner_gradients, bary).to_vec())
                }
            };
            let mut approximate = [0.0; 3];
            let mut approximate_gradient = [[0.0; 3]; 3];
            for ((&node, function), node_gradient) in nodes.iter().zip(&shape).zip(&gradients) {
                for (i, (value_sum, gradient_row)) in approximate
                    .iter_mut()
                    .zip(approximate_gradient.iter_mut())
                    .enumerate()
                {
                    let value = solved[3 * node as usize + i];
                    *value_sum += function * value;
                    for (entry, slope) in gradient_row.iter_mut().zip(node_gradient) {
                        *entry += slope * value;
                    }
                }
            }
            let (displacement, gradient) = exact(point);
            let scaled = weight * volume;
            l2 += scaled
                * displacement
                    .iter()
                    .zip(&approximate)
                    .map(|(exact_value, value)| (exact_value - value).powi(2))
                    .sum::<f64>();
            let strain_error: [[f64; 3]; 3] = std::array::from_fn(|i| {
                std::array::from_fn(|j| {
                    f64::midpoint(
                        gradient[i][j] - approximate_gradient[i][j],
                        gradient[j][i] - approximate_gradient[j][i],
                    )
                })
            });
            let trace = strain_error[0][0] + strain_error[1][1] + strain_error[2][2];
            let contraction: f64 = strain_error
                .iter()
                .flatten()
                .map(|entry| entry * entry)
                .sum();
            energy += scaled * (lambda * trace * trace + 2.0 * mu * contraction);
        }
    }
    Ok(Errors {
        l2: l2.sqrt(),
        energy: energy.sqrt(),
    })
}

fn observed_rates(order: ElementOrder, cells: &[usize]) -> Result<(f64, f64), FemError> {
    let sizes: Vec<f64> = cells.iter().map(|n| 1.0 / as_float(*n)).collect();
    let errors = cells
        .iter()
        .map(|&n| solve_and_measure(n, order))
        .collect::<Result<Vec<_>, _>>()?;
    let l2: Vec<f64> = errors.iter().map(|error| error.l2).collect();
    let energy: Vec<f64> = errors.iter().map(|error| error.energy).collect();
    let (l2_rate, energy_rate) = (fit_rate(&sizes, &l2)?.rate, fit_rate(&sizes, &energy)?.rate);
    let show = |list: &[f64]| {
        list.iter()
            .map(|value| format!("{value:.3e}"))
            .collect::<Vec<_>>()
            .join(", ")
    };
    eprintln!(
        "{order:?} cells {cells:?}: L² errors [{}] rate {l2_rate:.3}, energy errors [{}] rate \
         {energy_rate:.3}",
        show(&l2),
        show(&energy),
    );
    Ok((l2_rate, energy_rate))
}

/// Allowed distance of an observed rate from theory on these meshes.
const MARGIN: f64 = 0.1;

#[test]
fn linear_tetrahedra_converge_at_order_2_in_l2_and_order_1_in_energy() {
    let (l2, energy) = observed_rates(ElementOrder::Linear, &[4, 8, 16]).expect("solves");
    assert!((l2 - 2.0).abs() < MARGIN, "L² rate {l2}");
    assert!((energy - 1.0).abs() < MARGIN, "energy rate {energy}");
}

#[test]
fn quadratic_tetrahedra_converge_at_order_3_in_l2_and_order_2_in_energy() {
    let (l2, energy) = observed_rates(ElementOrder::Quadratic, &[2, 4, 8]).expect("solves");
    assert!((l2 - 3.0).abs() < MARGIN, "L² rate {l2}");
    assert!((energy - 2.0).abs() < MARGIN, "energy rate {energy}");
}
