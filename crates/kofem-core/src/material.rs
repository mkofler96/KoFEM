// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

use serde::{Deserialize, Serialize};

/// Isotropic linear-elastic material.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinearElasticMaterial {
    /// Young's modulus (Pa).
    pub young_modulus: f64,
    /// Poisson's ratio (dimensionless, must be in (-1, 0.5)).
    pub poisson_ratio: f64,
    /// Mass density (kg/m³) — not yet used by the static solver.
    pub density: f64,
}

impl LinearElasticMaterial {
    pub fn steel() -> Self {
        Self {
            young_modulus: 210e9,
            poisson_ratio: 0.3,
            density: 7850.0,
        }
    }

    pub fn aluminium() -> Self {
        Self {
            young_modulus: 70e9,
            poisson_ratio: 0.33,
            density: 2700.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_physical(material: &LinearElasticMaterial) {
        assert!(material.young_modulus > 0.0);
        assert!(material.poisson_ratio > -1.0 && material.poisson_ratio < 0.5);
        assert!(material.density > 0.0);
    }

    #[test]
    fn steel_preset_is_physical() {
        let steel = LinearElasticMaterial::steel();
        assert_physical(&steel);
        assert_eq!(steel.young_modulus, 210e9);
        assert_eq!(steel.poisson_ratio, 0.3);
    }

    #[test]
    fn aluminium_preset_is_physical() {
        let aluminium = LinearElasticMaterial::aluminium();
        assert_physical(&aluminium);
        assert_eq!(aluminium.young_modulus, 70e9);
        assert_eq!(aluminium.poisson_ratio, 0.33);
    }
}
