// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Observed convergence rates and extrapolation to zero element size: the
//! arithmetic behind the mesh-convergence studies on the example pages.

use kofem_fem::convergence::{clamped_free_wedge_exponent, extrapolate, fit_rate, relative_sizes};
use kofem_fem::FemError;

fn close(value: f64, expected: f64, tolerance: f64) -> bool {
    (value - expected).abs() <= tolerance * expected.abs().max(1.0)
}

#[test]
fn fit_rate_recovers_a_power_law() {
    let sizes = [1.0, 0.5, 0.31, 0.2];
    let errors: Vec<f64> = sizes
        .iter()
        .map(|size: &f64| 3.0 * size.powf(2.0))
        .collect();
    let fit = fit_rate(&sizes, &errors).unwrap();
    assert!(close(fit.rate, 2.0, 1e-12), "rate {}", fit.rate);
    assert!(close(fit.log_coefficient, 3f64.ln(), 1e-12));
    assert!(fit.max_log_residual < 1e-12);
}

#[test]
fn fit_rate_uses_the_magnitude_of_signed_errors() {
    // Errors below the reference are negative; the rate is about their size.
    let fit = fit_rate(&[1.0, 0.5], &[-0.4, -0.1]).unwrap();
    assert!(close(fit.rate, 2.0, 1e-12));
}

#[test]
fn fit_rate_reports_scatter_about_the_line() {
    let fit = fit_rate(&[1.0, 0.5, 0.25], &[1.0, 0.5, 0.0625]).unwrap();
    assert!(fit.max_log_residual > 0.1);
}

#[test]
fn fit_rate_refuses_bad_input() {
    let refuses = |sizes: &[f64], errors: &[f64]| {
        matches!(fit_rate(sizes, errors), Err(FemError::Convergence { .. }))
    };
    assert!(refuses(&[1.0], &[0.1]), "one level");
    assert!(refuses(&[1.0, 0.5], &[0.1]), "length mismatch");
    assert!(refuses(&[1.0, 0.0], &[0.1, 0.05]), "zero size");
    assert!(
        refuses(&[1.0, 0.5], &[0.1, 0.0]),
        "exact result has no logarithm"
    );
    assert!(
        refuses(&[1.0, 1.0], &[0.1, 0.05]),
        "equal sizes give no slope"
    );
    assert!(refuses(&[1.0, f64::NAN], &[0.1, 0.05]), "not finite");
}

#[test]
fn extrapolate_recovers_limit_order_and_coefficient_with_uneven_refinement() {
    // Netgen levels do not refine by a constant ratio.
    let sizes = [1.0, 0.7, 0.45, 0.3];
    let phi: Vec<f64> = sizes
        .iter()
        .map(|size: &f64| 5.0 + 2.0 * size.powf(1.5))
        .collect();
    let ex = extrapolate(&sizes, &phi).unwrap();
    assert!(close(ex.limit, 5.0, 1e-8), "limit {}", ex.limit);
    assert!(close(ex.order, 1.5, 1e-6), "order {}", ex.order);
    assert!(
        close(ex.coefficient, 2.0, 1e-6),
        "coefficient {}",
        ex.coefficient
    );
    assert!(ex.rms_residual < 1e-10);
}

#[test]
fn extrapolate_from_three_levels_matches_richardson_for_a_constant_ratio() {
    // Values approaching from below: φ = 10 − 4 h².
    let sizes = [0.4, 0.2, 0.1];
    let phi: [f64; 3] = [10.0 - 4.0 * 0.16, 10.0 - 4.0 * 0.04, 10.0 - 4.0 * 0.01];
    let ex = extrapolate(&sizes, &phi).unwrap();
    // Richardson: p = ln((φ3−φ2)/(φ2−φ1)) / ln 2, φ∞ = φ1 + (φ1−φ2)/(2^p − 1).
    let order = ((phi[1] - phi[0]) / (phi[2] - phi[1])).ln() / 2f64.ln();
    let limit = phi[2] + (phi[2] - phi[1]) / (2f64.powf(order) - 1.0);
    assert!(close(ex.order, order, 1e-6));
    assert!(close(ex.limit, limit, 1e-9));
}

#[test]
fn extrapolate_accepts_levels_in_any_order() {
    let sizes = [0.3, 1.0, 0.45, 0.7];
    let phi: Vec<f64> = sizes
        .iter()
        .map(|size: &f64| 1.0 - 0.5 * size.powf(2.0))
        .collect();
    let ex = extrapolate(&sizes, &phi).unwrap();
    assert!(close(ex.limit, 1.0, 1e-8));
    assert!(close(ex.order, 2.0, 1e-6));
}

#[test]
fn extrapolate_refuses_oscillating_values() {
    // Up, down, up: no single power law of h fits, so there is no limit.
    let result = extrapolate(&[1.0, 0.5, 0.25, 0.125], &[1.0, 1.3, 1.1, 1.25]);
    assert!(
        matches!(result, Err(FemError::Convergence { .. })),
        "{result:?}"
    );
}

#[test]
fn extrapolate_refuses_values_that_reverse_even_when_an_interior_order_fits_best() {
    // Up, down, up again: no φ∞ + C·hᵖ with p > 0 does that, although the
    // least-squares residual has its minimum inside the order range here.
    let result = extrapolate(&[1.0, 0.5, 0.25, 0.125], &[1.0, 1.6, 1.55, 1.7]);
    assert!(
        matches!(&result, Err(FemError::Convergence { reason }) if reason.contains("monoton")),
        "{result:?}"
    );
    // The same reversal with the levels listed out of order.
    let result = extrapolate(&[0.25, 1.0, 0.125, 0.5], &[1.55, 1.0, 1.7, 1.6]);
    assert!(result.is_err(), "{result:?}");
}

#[test]
fn extrapolate_refuses_values_that_do_not_change() {
    let result = extrapolate(&[1.0, 0.5, 0.25], &[2.0, 2.0, 2.0]);
    assert!(
        matches!(result, Err(FemError::Convergence { .. })),
        "{result:?}"
    );
}

#[test]
fn extrapolate_needs_three_levels() {
    let result = extrapolate(&[1.0, 0.5], &[2.0, 2.1]);
    assert!(
        matches!(result, Err(FemError::Convergence { .. })),
        "{result:?}"
    );
}

#[test]
fn relative_sizes_follow_the_element_count_in_the_refined_dimensions() {
    // 8× the elements of a 3D mesh halves the size; 4× does for a slab one
    // element thick, which refines in its plane only.
    let s3 = relative_sizes(&[1000, 8000], 3).unwrap();
    assert!(close(s3[0] / s3[1], 2.0, 1e-12));
    let s2 = relative_sizes(&[1000, 4000], 2).unwrap();
    assert!(close(s2[0] / s2[1], 2.0, 1e-12));
    assert!(close(s3[0], 1.0, 1e-12), "the first level is the unit size");
}

#[test]
fn relative_sizes_refuses_bad_input() {
    assert!(relative_sizes(&[], 3).is_err());
    assert!(relative_sizes(&[100, 0], 3).is_err());
    assert!(relative_sizes(&[100, 800], 4).is_err());
}

// ── Corner singularities ─────────────────────────────────────────────────────

#[test]
fn clamped_free_right_angle_has_the_known_exponent() {
    // Williams (1952): a clamped face meeting a free one at 90°, plane strain,
    // ν = 0.3: u ~ r^0.7112.
    let lambda = clamped_free_wedge_exponent(std::f64::consts::FRAC_PI_2, 0.3).unwrap();
    assert!((lambda - 0.7112).abs() < 5e-4, "λ = {lambda}");
}

#[test]
fn clamped_free_half_plane_gives_the_oscillating_square_root() {
    // α = π (a crack face clamped, the other free): λ = 1/2 ± i·ln(κ)/(2π);
    // the exponent is its real part.
    let lambda = clamped_free_wedge_exponent(std::f64::consts::PI, 0.3).unwrap();
    assert!((lambda - 0.5).abs() < 1e-9, "λ = {lambda}");
}

#[test]
fn a_wider_clamped_free_corner_is_more_singular() {
    let right = clamped_free_wedge_exponent(std::f64::consts::FRAC_PI_2, 1.0 / 3.0).unwrap();
    let obtuse = clamped_free_wedge_exponent(108.4_f64.to_radians(), 1.0 / 3.0).unwrap();
    assert!(obtuse < right, "{obtuse} vs {right}");
    // Each exponent is a root of κ·sin²(λα) = ((1+κ)/2)² − λ²·sin²α.
    let kappa: f64 = 3.0 - 4.0 / 3.0;
    let alpha = 108.4_f64.to_radians();
    let residual = kappa * (obtuse * alpha).sin().powi(2) - f64::midpoint(1.0, kappa).powi(2)
        + obtuse.powi(2) * alpha.sin().powi(2);
    assert!(residual.abs() < 1e-9, "residual {residual}");
}

#[test]
fn clamped_free_exponent_refuses_bad_input() {
    assert!(clamped_free_wedge_exponent(0.0, 0.3).is_err());
    assert!(clamped_free_wedge_exponent(7.0, 0.3).is_err());
    assert!(clamped_free_wedge_exponent(1.0, 0.5).is_err());
}
