// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Mesh-convergence arithmetic: the observed rate of an error against element
//! size, and the extrapolation of a result to zero element size.
//!
//! A discretisation converging at order p behaves, on fine enough meshes, as
//! φ(h) = φ∞ + C·hᵖ. [`extrapolate`] fits all three of φ∞, C and p to a
//! sequence of meshes by least squares: the generalised Richardson
//! extrapolation that does not need a constant refinement ratio (unstructured
//! meshes never have one). With exactly three levels the fit is exact, and it
//! is the three-level procedure of Celik et al., "Procedure for Estimation and
//! Reporting of Uncertainty Due to Discretization in CFD Applications",
//! J. Fluids Eng. 130 (2008) 078001. [`fit_rate`] fits the order of an error
//! measured against a known reference: the slope of ln|e| against ln h.

use crate::count::count_as_f64;
use crate::FemError;

/// A power law |e| = C·hᵖ fitted to errors by least squares in log–log.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RateFit {
    /// The order p: the slope of ln|e| against ln h.
    pub rate: f64,
    /// ln C, the intercept at h = 1.
    pub log_coefficient: f64,
    /// The largest distance of a level from the fitted line, in ln|e|.
    pub max_log_residual: f64,
}

/// φ(h) ≈ φ∞ + C·hᵖ fitted to the results of a mesh sequence.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Extrapolation {
    /// φ∞, the result extrapolated to zero element size.
    pub limit: f64,
    /// p, the observed order of convergence.
    pub order: f64,
    /// C, in the units of φ per unit of hᵖ.
    pub coefficient: f64,
    /// Root mean square of the fit's residuals, in the units of φ.
    pub rms_residual: f64,
}

fn refuse(reason: impl Into<String>) -> FemError {
    FemError::Convergence {
        reason: reason.into(),
    }
}

fn check_levels(sizes: &[f64], values: &[f64], what: &str, min: usize) -> Result<(), FemError> {
    if sizes.len() != values.len() {
        return Err(refuse(format!(
            "{} element sizes for {} {what}",
            sizes.len(),
            values.len()
        )));
    }
    if sizes.len() < min {
        return Err(refuse(format!(
            "needs at least {min} mesh levels, got {}",
            sizes.len()
        )));
    }
    if let Some(i) = sizes
        .iter()
        .position(|size| !(size.is_finite() && *size > 0.0))
    {
        return Err(refuse(format!(
            "element size {i} must be positive and finite, got {}",
            sizes[i]
        )));
    }
    if let Some(i) = values.iter().position(|value| !value.is_finite()) {
        return Err(refuse(format!("{what} {i} is not finite: {}", values[i])));
    }
    Ok(())
}

/// Fits |e| = C·hᵖ to the errors `errors` on meshes of element size `sizes`
/// (any unit; only ratios matter for p). Signs are ignored: an error below
/// the reference converges as much as one above it.
///
/// # Errors
/// Fewer than two levels, mismatched lengths, a size that is not positive and
/// finite, an error that is not finite or exactly zero, or equal sizes.
pub fn fit_rate(sizes: &[f64], errors: &[f64]) -> Result<RateFit, FemError> {
    check_levels(sizes, errors, "errors", 2)?;
    if let Some(i) = errors.iter().position(|error| *error == 0.0) {
        return Err(refuse(format!(
            "error {i} is exactly zero, which has no place on a logarithmic scale"
        )));
    }
    let log_sizes: Vec<f64> = sizes.iter().map(|size| size.ln()).collect();
    let log_errors: Vec<f64> = errors.iter().map(|error| error.abs().ln()).collect();
    let mean_size = mean(&log_sizes);
    let mean_error = mean(&log_errors);
    let spread: f64 = log_sizes.iter().map(|ls| (ls - mean_size).powi(2)).sum();
    if spread <= 1e-24 {
        return Err(refuse(
            "the element sizes are all equal, so they give no slope",
        ));
    }
    let covariance: f64 = log_sizes
        .iter()
        .zip(&log_errors)
        .map(|(ls, le)| (ls - mean_size) * (le - mean_error))
        .sum();
    let rate = covariance / spread;
    let log_coefficient = mean_error - rate * mean_size;
    let max_log_residual = log_sizes
        .iter()
        .zip(&log_errors)
        .map(|(ls, le)| (le - log_coefficient - rate * ls).abs())
        .fold(0.0, f64::max);
    Ok(RateFit {
        rate,
        log_coefficient,
        max_log_residual,
    })
}

fn mean(values: &[f64]) -> f64 {
    let count = count_as_f64(values.len());
    values.iter().sum::<f64>() / count
}

/// The orders [`extrapolate`] searches. Below 0.05 the levels barely differ
/// from a constant; above 10 no finite element converges.
const ORDER_RANGE: (f64, f64) = (0.05, 10.0);
const SCAN_POINTS: u32 = 400;

/// The linear least-squares fit of φ = φ∞ + C·sᵖ for one order p, on sizes
/// scaled to at most 1 (s = h / `h_max`): (φ∞, C for the scaled sizes, the
/// residual sum of squares).
fn fit_at_order(scaled: &[f64], values: &[f64], order: f64) -> (f64, f64, f64) {
    let powers: Vec<f64> = scaled.iter().map(|size| size.powf(order)).collect();
    let mean_power = mean(&powers);
    let mean_value = mean(values);
    let spread: f64 = powers.iter().map(|pw| (pw - mean_power).powi(2)).sum();
    let covariance: f64 = powers
        .iter()
        .zip(values)
        .map(|(pw, value)| (pw - mean_power) * (value - mean_value))
        .sum();
    let coefficient = if spread > 0.0 {
        covariance / spread
    } else {
        0.0
    };
    let limit = mean_value - coefficient * mean_power;
    let residual = powers
        .iter()
        .zip(values)
        .map(|(pw, value)| (value - limit - coefficient * pw).powi(2))
        .sum();
    (limit, coefficient, residual)
}

/// Fits φ = φ∞ + C·hᵖ to the results `values` on meshes of element size
/// `sizes`, in any order and with any refinement ratios.
///
/// # Errors
/// Fewer than three levels, mismatched lengths, sizes or results that are not
/// finite, results that do not change with the mesh, and results that no
/// order between 0.05 and 10 fits (oscillating, or not yet converging): those
/// are not in the asymptotic range, and no extrapolation of them means
/// anything.
pub fn extrapolate(sizes: &[f64], values: &[f64]) -> Result<Extrapolation, FemError> {
    check_levels(sizes, values, "results", 3)?;
    let h_max = sizes.iter().copied().fold(0.0, f64::max);
    let scaled: Vec<f64> = sizes.iter().map(|size| size / h_max).collect();
    let spread = values.iter().copied().fold(f64::NEG_INFINITY, f64::max)
        - values.iter().copied().fold(f64::INFINITY, f64::min);
    let magnitude = values.iter().map(|value| value.abs()).fold(0.0, f64::max);
    if spread <= 1e-14 * magnitude.max(f64::MIN_POSITIVE) {
        return Err(refuse(
            "the results do not change with the mesh, so they give no order of convergence",
        ));
    }
    if scaled.iter().copied().fold(f64::INFINITY, f64::min) >= 1.0 - 1e-12 {
        return Err(refuse(
            "the element sizes are all equal, so they give no order",
        ));
    }
    // φ∞ + C·hᵖ with p > 0 is monotonic in h: results that change direction
    // between successive meshes are not in the asymptotic range, whatever
    // order fits them best.
    let mut by_size: Vec<(f64, f64)> = scaled.iter().copied().zip(values.iter().copied()).collect();
    by_size.sort_by(|first, second| second.0.total_cmp(&first.0));
    let steps: Vec<f64> = by_size
        .windows(2)
        .map(|pair| pair[1].1 - pair[0].1)
        .collect();
    if !(steps.iter().all(|step| *step > 0.0) || steps.iter().all(|step| *step < 0.0)) {
        return Err(refuse(
            "the results do not change monotonically as the mesh is refined, so they are not \
             in the asymptotic range and give no limit",
        ));
    }

    // Scan log-spaced orders for the smallest residual, then refine it by
    // golden-section search inside the bracketing scan cells.
    let (low, high) = (ORDER_RANGE.0.ln(), ORDER_RANGE.1.ln());
    let order_at = |k: u32| {
        let fraction = f64::from(k) / f64::from(SCAN_POINTS - 1);
        (low + (high - low) * fraction).exp()
    };
    let residual_at = |order: f64| fit_at_order(&scaled, values, order).2;
    let (best, _) = (0..SCAN_POINTS)
        .map(|k| (k, residual_at(order_at(k))))
        .fold((0, f64::INFINITY), |found, (k, residual)| {
            if residual < found.1 {
                (k, residual)
            } else {
                found
            }
        });
    if best == 0 || best == SCAN_POINTS - 1 {
        return Err(refuse(format!(
            "no order of convergence between {} and {} fits the results (the best fit is at the \
             bound): they oscillate or are not yet converging with the mesh",
            ORDER_RANGE.0, ORDER_RANGE.1
        )));
    }
    let (mut lower, mut upper) = (order_at(best - 1), order_at(best + 1));
    let golden = (5f64.sqrt() - 1.0) / 2.0;
    for _ in 0..200 {
        let left = upper - golden * (upper - lower);
        let right = lower + golden * (upper - lower);
        if residual_at(left) < residual_at(right) {
            upper = right;
        } else {
            lower = left;
        }
        if (upper - lower).abs() <= 1e-12 * upper.abs() {
            break;
        }
    }
    let order = f64::midpoint(lower, upper);
    let (limit, scaled_coefficient, residual) = fit_at_order(&scaled, values, order);
    let levels = count_as_f64(scaled.len());
    Ok(Extrapolation {
        limit,
        order,
        coefficient: scaled_coefficient / h_max.powf(order),
        rms_residual: (residual / levels).sqrt(),
    })
}

/// Element sizes of a mesh sequence from its element counts, for meshes that
/// refine in `dimension` directions: h ∝ N^(−1/d). A slab meshed one element
/// thick at every level refines in its plane only (d = 2). The first level
/// has size 1; only ratios carry meaning.
///
/// # Errors
/// A dimension other than 1, 2 or 3, no levels, or a level without elements.
pub fn relative_sizes(element_counts: &[u32], dimension: u32) -> Result<Vec<f64>, FemError> {
    if !(1..=3).contains(&dimension) {
        return Err(refuse(format!(
            "a mesh refines in 1, 2 or 3 dimensions, got {dimension}"
        )));
    }
    let Some(&first) = element_counts.first() else {
        return Err(refuse("no mesh levels"));
    };
    if let Some(i) = element_counts.iter().position(|count| *count == 0) {
        return Err(refuse(format!("mesh level {i} has no elements")));
    }
    Ok(element_counts
        .iter()
        .map(|count| (f64::from(first) / f64::from(*count)).powf(1.0 / f64::from(dimension)))
        .collect())
}

/// The strongest corner singularity where a clamped face meets a free face at
/// the interior angle `angle` (radians) in an elastic body of Poisson's ratio
/// `poisson`: displacements grow as r^λ from the edge, and the exponent
/// returned is the smallest positive real part of λ.
///
/// Near a straight edge the field is in plane strain, and λ solves Williams'
/// clamped–free characteristic equation (M. L. Williams, J. Appl. Mech. 19
/// (1952) 526), which the Kolosov–Muskhelishvili potentials give as
/// 1 + κ² + 2κ·cos(2λα) = 4λ²·sin²α with κ = 3 − 4ν. It holds for complex λ
/// too (the roots become a complex pair for wide angles), so the roots are
/// searched in the complex plane.
///
/// On a quasi-uniform mesh such a corner limits the energy error to h^λ and
/// the error of a result away from it to h^(2λ), whatever the element order.
///
/// # Errors
/// An angle outside (0, 2π], a Poisson's ratio outside (−1, 0.5), or no root
/// found.
pub fn clamped_free_wedge_exponent(angle: f64, poisson: f64) -> Result<f64, FemError> {
    if !(angle > 0.0 && angle <= 2.0 * std::f64::consts::PI) {
        return Err(refuse(format!(
            "a corner angle must lie in (0, 2π] radians, got {angle}"
        )));
    }
    if !(poisson > -1.0 && poisson < 0.5) {
        return Err(refuse(format!(
            "Poisson's ratio must lie in (-1, 0.5), got {poisson}"
        )));
    }
    let kappa = 3.0 - 4.0 * poisson;
    let sin_squared = angle.sin().powi(2);
    // F(λ) and F′(λ) for λ = re + i·im.
    let evaluate = |re: f64, im: f64| {
        let (arg_re, arg_im) = (2.0 * angle * re, 2.0 * angle * im);
        let cos = (arg_re.cos() * arg_im.cosh(), -arg_re.sin() * arg_im.sinh());
        let sin = (arg_re.sin() * arg_im.cosh(), arg_re.cos() * arg_im.sinh());
        let square = (re * re - im * im, 2.0 * re * im);
        let value = (
            1.0 + kappa * kappa + 2.0 * kappa * cos.0 - 4.0 * sin_squared * square.0,
            2.0 * kappa * cos.1 - 4.0 * sin_squared * square.1,
        );
        let slope = (
            -4.0 * kappa * angle * sin.0 - 8.0 * sin_squared * re,
            -4.0 * kappa * angle * sin.1 - 8.0 * sin_squared * im,
        );
        (value, slope)
    };
    let scale = 1.0 + kappa * kappa;
    let mut best: Option<f64> = None;
    for start_re in (1..40).map(|k| 0.05 * f64::from(k)) {
        for start_im in [0.0, 0.05, 0.2, 0.5, 1.0] {
            let (mut re, mut im) = (start_re, start_im);
            for _ in 0..100 {
                let ((f_re, f_im), (d_re, d_im)) = evaluate(re, im);
                let denominator = d_re * d_re + d_im * d_im;
                if denominator < 1e-300 {
                    break;
                }
                let step_re = (f_re * d_re + f_im * d_im) / denominator;
                let step_im = (f_im * d_re - f_re * d_im) / denominator;
                re -= step_re;
                im -= step_im;
                if step_re.hypot(step_im) < 1e-14 {
                    break;
                }
            }
            let ((f_re, f_im), _) = evaluate(re, im);
            if re > 1e-9 && f_re.hypot(f_im) < 1e-10 * scale {
                best = Some(best.map_or(re, |found| found.min(re)));
            }
        }
    }
    best.ok_or_else(|| {
        refuse(format!(
            "no singular exponent found for a clamped–free corner of {angle} rad"
        ))
    })
}
