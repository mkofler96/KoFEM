//! Bar and beam line elements (PBAR / PBEAM properties).
//!
//! DOF order per node: [ux, uy, uz, rx, ry, rz] — 6 DOF/node.
//!
//! CBAR: 2-node simple beam, Euler-Bernoulli formulation.
//!       Local stiffness is analytical (no integration needed).
//!       Global transform via 3D rotation matrix is TODO.
//! CBEAM: general beam — uses same formulation as CBAR here;
//!        warping and non-uniform section extend this.

use super::Element;
use crate::material::IsotropicElastic;
use nalgebra::DMatrix;

/// CBAR / CBEAM with PBAR property — 2 nodes, 12 DOF.
pub struct CbarElement {
    pub material: IsotropicElastic,
    /// Cross-section area A
    pub area: f64,
    /// Moment of inertia about local z-axis (I1 in Nastran)
    pub i1: f64,
    /// Moment of inertia about local y-axis (I2 in Nastran)
    pub i2: f64,
    /// Torsional constant J
    pub j_torsion: f64,
}

impl Element for CbarElement {
    fn dof_per_node(&self) -> usize {
        6
    }

    fn stiffness_matrix(&self, nodes: &[[f64; 3]]) -> DMatrix<f64> {
        let dx = nodes[1][0] - nodes[0][0];
        let dy = nodes[1][1] - nodes[0][1];
        let dz = nodes[1][2] - nodes[0][2];
        let l = (dx * dx + dy * dy + dz * dz).sqrt();

        let e = self.material.young;
        let g = self.material.shear_modulus();
        let ea = e * self.area / l;
        let gj = g * self.j_torsion / l;
        // EI_z / L^3 and EI_y / L^3 for bending stiffness coefficients
        let ei1_l3 = e * self.i1 / (l * l * l);
        let ei2_l3 = e * self.i2 / (l * l * l);

        let mut k = DMatrix::<f64>::zeros(12, 12);

        // Axial: DOF 0 ↔ 6
        k[(0, 0)] = ea;
        k[(0, 6)] = -ea;
        k[(6, 0)] = -ea;
        k[(6, 6)] = ea;

        // Torsion: DOF 3 ↔ 9
        k[(3, 3)] = gj;
        k[(3, 9)] = -gj;
        k[(9, 3)] = -gj;
        k[(9, 9)] = gj;

        // Bending about local z-axis (in local x-y plane): DOF 1, 5, 7, 11
        let [a, b, c, d] = bending_coefficients(ei1_l3, l);
        for (&di, row) in [1usize, 5, 7, 11].iter().zip([
            [a, b, -a, b],
            [b, c, -b, d],
            [-a, -b, a, -b],
            [b, d, -b, c],
        ]) {
            for (&dj, val) in [1usize, 5, 7, 11].iter().zip(row) {
                k[(di, dj)] = val;
            }
        }

        // Bending about local y-axis (in local x-z plane): DOF 2, 4, 8, 10
        // Sign convention flips for the cross-terms
        let [a, b, c, d] = bending_coefficients(ei2_l3, l);
        for (&di, row) in [2usize, 4, 8, 10].iter().zip([
            [a, -b, -a, -b],
            [-b, c, b, d],
            [-a, b, a, b],
            [-b, d, b, c],
        ]) {
            for (&dj, val) in [2usize, 4, 8, 10].iter().zip(row) {
                k[(di, dj)] = val;
            }
        }

        // TODO: transform to global frame via 3D rotation matrix R:
        // K_global = Tᵀ K_local T  where T is the 12×12 block-diagonal rotation.
        k
    }

    fn consistent_mass_matrix(&self, nodes: &[[f64; 3]], density: f64) -> DMatrix<f64> {
        let dx = nodes[1][0] - nodes[0][0];
        let dy = nodes[1][1] - nodes[0][1];
        let dz = nodes[1][2] - nodes[0][2];
        let l = (dx * dx + dy * dy + dz * dz).sqrt();
        // Lumped mass — consistent beam mass matrix is lengthy; add when needed
        let half = density * self.area * l / 2.0;
        let mut m = DMatrix::<f64>::zeros(12, 12);
        for i in [0usize, 1, 2, 6, 7, 8] {
            m[(i, i)] = half;
        }
        m
    }
}

/// CBEAM is identical to CBAR at this level; warping / nonuniform section extend later.
pub type CbeamElement = CbarElement;

fn bending_coefficients(ei_l3: f64, l: f64) -> [f64; 4] {
    let a = 12.0 * ei_l3;
    let b = 6.0 * ei_l3 * l;
    let c = 4.0 * ei_l3 * l * l;
    let d = 2.0 * ei_l3 * l * l;
    [a, b, c, d]
}
