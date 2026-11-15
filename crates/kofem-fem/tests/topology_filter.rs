// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The radius-r_min cone filter (Andreassen et al. 2011, their H and Hs):
//! the neighbour weights against a brute-force reference, the sensitivity
//! filter, the density filter and its chain rule — ported from the C++
//! engine's `engine/tests/topology_filter_validation.cpp`.

#![allow(
    clippy::cast_precision_loss,
    clippy::expect_used,
    reason = "test fixtures: small grids whose indices fit any float, and a fixture that \
              fails to build should abort the test"
)]

use kofem_fem::topology::{default_filter_radius, mean_element_size, DensityFilter};
use kofem_fem::FemError;

/// Element e = ix·ny + iy at (ix + ½, iy + ½, ½) on a unit grid.
fn grid_2d(nx: usize, ny: usize) -> Vec<[f64; 3]> {
    let mut points = Vec::new();
    for ix in 0..nx {
        for iy in 0..ny {
            points.push([ix as f64 + 0.5, iy as f64 + 0.5, 0.5]);
        }
    }
    points
}

fn grid_3d(nx: usize, ny: usize, nz: usize) -> Vec<[f64; 3]> {
    let mut points = Vec::new();
    for ix in 0..nx {
        for iy in 0..ny {
            for iz in 0..nz {
                points.push([ix as f64 + 0.5, iy as f64 + 0.5, iz as f64 + 0.5]);
            }
        }
    }
    points
}

/// Dense `H_ei = max(0, r − ‖x_e − x_i‖)`.
fn brute_force(points: &[[f64; 3]], radius: f64) -> Vec<Vec<f64>> {
    points
        .iter()
        .map(|lhs| {
            points
                .iter()
                .map(|rhs| {
                    let distance = (0..3)
                        .map(|axis| (lhs[axis] - rhs[axis]).powi(2))
                        .sum::<f64>()
                        .sqrt();
                    (radius - distance).max(0.0)
                })
                .collect()
        })
        .collect()
}

fn assert_matches_reference(filter: &DensityFilter, reference: &[Vec<f64>]) {
    assert_eq!(filter.element_count(), reference.len());
    for (element, row) in reference.iter().enumerate() {
        let neighbours = filter.neighbours(element);
        let expected: Vec<(usize, f64)> = row
            .iter()
            .enumerate()
            .filter(|(_, &weight)| weight > 0.0)
            .map(|(index, &weight)| (index, weight))
            .collect();
        assert_eq!(neighbours.len(), expected.len(), "element {element}");
        for neighbour in neighbours {
            let want = row[neighbour.index];
            assert!(
                (neighbour.weight - want).abs() < 1e-12,
                "H[{element}][{}] = {} vs {want}",
                neighbour.index,
                neighbour.weight
            );
        }
        let row_sum: f64 = row.iter().sum();
        assert!((filter.row_sum(element) - row_sum).abs() < 1e-12);
        // H is symmetric.
        for neighbour in neighbours {
            assert!((reference[neighbour.index][element] - neighbour.weight).abs() < 1e-15);
        }
    }
}

#[test]
fn weights_match_the_brute_force_cone_in_2d_and_3d() {
    let points = grid_2d(8, 5);
    let filter = DensityFilter::new(&points, 2.4).expect("filter");
    assert_matches_reference(&filter, &brute_force(&points, 2.4));

    let points = grid_3d(5, 4, 3);
    let filter = DensityFilter::new(&points, 1.8).expect("filter");
    assert_matches_reference(&filter, &brute_force(&points, 1.8));
}

#[test]
fn interior_row_sum_is_the_analytic_cone_stencil() {
    let (nx, ny, radius) = (8, 5, 2.4);
    let filter = DensityFilter::new(&grid_2d(nx, ny), radius).expect("filter");
    let interior = 3 * ny + 2;
    let mut expected = 0.0;
    for dx in -2_i32..=2 {
        for dy in -2_i32..=2 {
            let weight = radius - f64::from(dx * dx + dy * dy).sqrt();
            if weight > 0.0 {
                expected += weight;
            }
        }
    }
    assert!((filter.row_sum(interior) - expected).abs() < 1e-12);
}

#[test]
fn a_sensitivity_spike_smears_over_the_radius_ball() {
    let (nx, ny, radius) = (8, 5, 2.4);
    let points = grid_2d(nx, ny);
    let filter = DensityFilter::new(&points, radius).expect("filter");
    let reference = brute_force(&points, radius);
    let spike = 3 * ny + 2;
    let rho = vec![0.5; points.len()];
    let mut sensitivity = vec![0.0; points.len()];
    sensitivity[spike] = 1.0;
    filter
        .filter_sensitivity(&rho, &mut sensitivity)
        .expect("filter");
    for (element, &value) in sensitivity.iter().enumerate() {
        // ρ ≡ 0.5 cancels: d̃c_e = H_ek / Hs_e, and 0 off the ball.
        let expected = reference[element][spike] / filter.row_sum(element);
        assert!((value - expected).abs() <= 1e-12 * (1.0 + expected.abs()));
    }
}

#[test]
fn the_density_filter_keeps_a_uniform_field() {
    let points = grid_2d(8, 5);
    let filter = DensityFilter::new(&points, 2.4).expect("filter");
    let physical = filter
        .filter_density(&vec![0.37; points.len()])
        .expect("filter");
    assert!(physical.iter().all(|&value| (value - 0.37).abs() < 1e-12));
}

#[test]
fn the_density_filter_chain_rule_matches_finite_differences() {
    let points = grid_3d(5, 4, 3);
    let filter = DensityFilter::new(&points, 1.8).expect("filter");
    let rho: Vec<f64> = (0..points.len())
        .map(|index| 0.3 + 0.4 * (0.7 * index as f64).sin())
        .collect();
    // f(ρ) = Σ ½·ρ̃², so ∂f/∂ρ̃ = ρ̃.
    let objective = |design: &[f64]| -> f64 {
        filter
            .filter_density(design)
            .expect("filter")
            .iter()
            .map(|value| 0.5 * value * value)
            .sum()
    };
    let mut gradient = filter.filter_density(&rho).expect("filter");
    filter
        .chain_density_sensitivity(&mut gradient)
        .expect("chain");
    let count = points.len();
    let step = 1e-6;
    for element in [0, count / 3, count / 2, 2 * count / 3, count - 1] {
        let mut plus = rho.clone();
        let mut minus = rho.clone();
        plus[element] += step;
        minus[element] -= step;
        let difference = (objective(&plus) - objective(&minus)) / (2.0 * step);
        let relative = (difference - gradient[element]).abs() / gradient[element].abs();
        assert!(relative < 1e-6, "element {element}: rel {relative:e}");
    }
}

#[test]
fn the_default_radius_is_one_and_a_half_mean_element_sizes() {
    let volumes = vec![1.0; 20];
    assert!((mean_element_size(&volumes).expect("size") - 1.0).abs() < 1e-12);
    assert!((default_filter_radius(&volumes).expect("radius") - 1.5).abs() < 1e-12);
    assert!(matches!(
        default_filter_radius(&[]),
        Err(FemError::TopologyInput { .. })
    ));
    assert!(matches!(
        default_filter_radius(&[1.0, 0.0]),
        Err(FemError::TopologyInput { .. })
    ));
}

#[test]
fn bad_radii_points_and_lengths_are_refused() {
    let points = grid_2d(3, 3);
    assert!(matches!(
        DensityFilter::new(&points, 0.0),
        Err(FemError::TopologyInput { .. })
    ));
    assert!(matches!(
        DensityFilter::new(&[], 1.0),
        Err(FemError::TopologyInput { .. })
    ));
    // A radius tiny against the extent would need billions of grid cells.
    let far = [[0.0, 0.0, 0.0], [1e9, 1e9, 1e9]];
    assert!(matches!(
        DensityFilter::new(&far, 1e-3),
        Err(FemError::TopologyInput { .. })
    ));
    let filter = DensityFilter::new(&points, 1.5).expect("filter");
    assert!(filter.filter_density(&[0.5; 2]).is_err());
    let mut short = vec![0.0; 2];
    assert!(filter.chain_density_sensitivity(&mut short).is_err());
    assert!(filter.filter_sensitivity(&[0.5; 9], &mut short).is_err());
}

#[test]
fn a_large_coordinate_cloud_finds_only_its_near_pairs() {
    let points = [
        [1e6, 1e6, 1e6],
        [1e6 + 0.5, 1e6, 1e6],
        [1e6 + 50.0, 1e6, 1e6],
    ];
    let filter = DensityFilter::new(&points, 1.0).expect("filter");
    assert_eq!(filter.neighbours(0).len(), 2);
    assert_eq!(filter.neighbours(2).len(), 1);
}
