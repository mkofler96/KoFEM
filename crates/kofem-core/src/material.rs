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
