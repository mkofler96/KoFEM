#[derive(Debug, Clone, Copy)]
pub struct IsotropicElastic {
    pub young: f64,
    pub poisson: f64,
    pub density: f64,
}

impl IsotropicElastic {
    pub fn new(young: f64, poisson: f64, density: f64) -> Self {
        Self {
            young,
            poisson,
            density,
        }
    }

    pub fn steel() -> Self {
        Self {
            young: 210e9,
            poisson: 0.3,
            density: 7850.0,
        }
    }

    pub fn aluminum() -> Self {
        Self {
            young: 70e9,
            poisson: 0.33,
            density: 2700.0,
        }
    }

    pub fn shear_modulus(&self) -> f64 {
        self.young / (2.0 * (1.0 + self.poisson))
    }

    pub fn bulk_modulus(&self) -> f64 {
        self.young / (3.0 * (1.0 - 2.0 * self.poisson))
    }

    /// 6x6 constitutive matrix for 3D solid: [σ] = [D][ε]
    pub fn constitutive_3d(&self) -> [[f64; 6]; 6] {
        let e = self.young;
        let nu = self.poisson;
        let c = e / ((1.0 + nu) * (1.0 - 2.0 * nu));
        let c11 = c * (1.0 - nu);
        let c12 = c * nu;
        let c44 = e / (2.0 * (1.0 + nu));
        [
            [c11, c12, c12, 0.0, 0.0, 0.0],
            [c12, c11, c12, 0.0, 0.0, 0.0],
            [c12, c12, c11, 0.0, 0.0, 0.0],
            [0.0, 0.0, 0.0, c44, 0.0, 0.0],
            [0.0, 0.0, 0.0, 0.0, c44, 0.0],
            [0.0, 0.0, 0.0, 0.0, 0.0, c44],
        ]
    }

    /// Plane stress constitutive matrix (3x3) for shells
    pub fn constitutive_plane_stress(&self) -> [[f64; 3]; 3] {
        let e = self.young;
        let nu = self.poisson;
        let c = e / (1.0 - nu * nu);
        [
            [c, c * nu, 0.0],
            [c * nu, c, 0.0],
            [0.0, 0.0, c * (1.0 - nu) / 2.0],
        ]
    }
}
