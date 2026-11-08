// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::error::FemError;

/// Isotropic linear-elastic material, validated on construction.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Isotropic {
    young: f64,
    poisson: f64,
}

impl Isotropic {
    /// # Errors
    /// [`FemError::YoungsModulus`] or [`FemError::PoissonRatio`] when the value
    /// is outside its physical range. `index` names the material in the error.
    pub fn new(index: usize, young: f64, poisson: f64) -> Result<Self, FemError> {
        if !(young.is_finite() && young > 0.0) {
            return Err(FemError::YoungsModulus {
                index,
                value: young,
            });
        }
        if !(poisson.is_finite() && poisson > -1.0 && poisson < 0.5) {
            return Err(FemError::PoissonRatio {
                index,
                value: poisson,
            });
        }
        Ok(Self { young, poisson })
    }

    /// Lamé constants (λ, μ).
    #[must_use]
    pub fn lame(&self) -> (f64, f64) {
        let (young, poisson) = (self.young, self.poisson);
        let lambda = young * poisson / ((1.0 + poisson) * (1.0 - 2.0 * poisson));
        let mu = young / (2.0 * (1.0 + poisson));
        (lambda, mu)
    }
}
