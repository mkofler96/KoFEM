// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Browser binding for the mesh-convergence arithmetic
//! (`kofem_fem::convergence`): observed rates and extrapolation to zero
//! element size, for the convergence studies on the example pages.

use wasm_bindgen::prelude::*;

use crate::to_js;

/// |e| = C·hᵖ fitted to errors by least squares in log–log.
#[wasm_bindgen]
pub struct ConvergenceRate {
    fit: kofem_fem::convergence::RateFit,
}

#[wasm_bindgen]
impl ConvergenceRate {
    /// The order p, the slope of ln|e| against ln h.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn rate(&self) -> f64 {
        self.fit.rate
    }

    /// ln C, the intercept at h = 1.
    #[wasm_bindgen(getter, js_name = logCoefficient)]
    #[must_use]
    pub fn log_coefficient(&self) -> f64 {
        self.fit.log_coefficient
    }

    /// The largest distance of a level from the fitted line, in ln|e|.
    #[wasm_bindgen(getter, js_name = maxLogResidual)]
    #[must_use]
    pub fn max_log_residual(&self) -> f64 {
        self.fit.max_log_residual
    }
}

/// φ(h) ≈ φ∞ + C·hᵖ fitted to the results of a mesh sequence.
#[wasm_bindgen]
pub struct ZeroSizeExtrapolation {
    fit: kofem_fem::convergence::Extrapolation,
}

#[wasm_bindgen]
impl ZeroSizeExtrapolation {
    /// φ∞, the result at zero element size.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn limit(&self) -> f64 {
        self.fit.limit
    }

    /// p, the observed order of convergence.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn order(&self) -> f64 {
        self.fit.order
    }

    /// C, in the units of φ per unit of hᵖ.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn coefficient(&self) -> f64 {
        self.fit.coefficient
    }

    /// Root mean square of the fit's residuals, in the units of φ.
    #[wasm_bindgen(getter, js_name = rmsResidual)]
    #[must_use]
    pub fn rms_residual(&self) -> f64 {
        self.fit.rms_residual
    }
}

/// The observed order of the errors `errors` on meshes of element size
/// `sizes`.
///
/// # Errors
/// Fewer than two levels, mismatched lengths, a size that is not positive, an
/// error of exactly zero or equal sizes.
#[wasm_bindgen(js_name = fitConvergenceRate)]
pub fn fit_convergence_rate(sizes: &[f64], errors: &[f64]) -> Result<ConvergenceRate, JsError> {
    kofem_fem::convergence::fit_rate(sizes, errors)
        .map(|fit| ConvergenceRate { fit })
        .map_err(|error| to_js(&error))
}

/// The results `values` on meshes of element size `sizes`, extrapolated to
/// zero element size.
///
/// # Errors
/// Fewer than three levels, results that do not change with the mesh, or
/// results no order of convergence fits (not in the asymptotic range).
#[wasm_bindgen(js_name = extrapolateToZeroSize)]
pub fn extrapolate_to_zero_size(
    sizes: &[f64],
    values: &[f64],
) -> Result<ZeroSizeExtrapolation, JsError> {
    kofem_fem::convergence::extrapolate(sizes, values)
        .map(|fit| ZeroSizeExtrapolation { fit })
        .map_err(|error| to_js(&error))
}

/// Element sizes from element counts, for meshes that refine in `dimension`
/// directions (h ∝ N^(−1/d)); the first level has size 1.
///
/// # Errors
/// No levels, a level without elements, or a dimension other than 1, 2 or 3.
#[wasm_bindgen(js_name = relativeElementSizes)]
pub fn relative_element_sizes(element_counts: &[u32], dimension: u32) -> Result<Vec<f64>, JsError> {
    kofem_fem::convergence::relative_sizes(element_counts, dimension).map_err(|error| to_js(&error))
}

/// The singular exponent λ of a clamped face meeting a free face at the
/// interior angle `angle` (radians), Poisson's ratio `poisson`: displacements
/// grow as r^λ from the edge.
///
/// # Errors
/// An angle outside (0, 2π], a Poisson's ratio outside (−1, 0.5), or no root
/// found.
#[wasm_bindgen(js_name = clampedFreeWedgeExponent)]
pub fn clamped_free_wedge_exponent(angle: f64, poisson: f64) -> Result<f64, JsError> {
    kofem_fem::convergence::clamped_free_wedge_exponent(angle, poisson)
        .map_err(|error| to_js(&error))
}
