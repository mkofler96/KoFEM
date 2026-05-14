//! Bar and beam line elements (PBAR / PBEAM properties).
//!
//! DOF order per node: [ux, uy, uz, rx, ry, rz] — 6 DOF/node.
//!
//! CBAR: 2-node simple beam, Euler-Bernoulli formulation.
//!       Local stiffness is analytical (no integration needed).
//!       Global transform via 3D rotation matrix R:
//!         K_global = Tᵀ K_local T
//!       where T is the 12×12 block-diagonal [R, R, R, R].
//! CBEAM: general beam — uses same formulation as CBAR here;
//!        warping and non-uniform section extend this.

use super::Element;
use crate::material::IsotropicElastic;
use nalgebra::{DMatrix, Matrix3};

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
    /// Orientation vector defining the local x-z plane (Nastran V-vector).
    /// If None, defaults to global Z (or Y if beam is vertical).
    pub orientation: Option<[f64; 3]>,
}

impl CbarElement {
    /// Compute the 3×3 rotation matrix from local to global coordinates.
    ///
    /// Local axes:
    ///   x: along beam axis (node 0 → node 1)
    ///   z: in plane defined by beam axis and orientation vector, perpendicular to x
    ///   y: completes right-handed system (z × x)
    fn rotation_matrix(&self, nodes: &[[f64; 3]]) -> Matrix3<f64> {
        let dx = nodes[1][0] - nodes[0][0];
        let dy = nodes[1][1] - nodes[0][1];
        let dz = nodes[1][2] - nodes[0][2];
        let l = (dx * dx + dy * dy + dz * dz).sqrt();

        // Local x-axis (beam axis direction)
        let lx = [dx / l, dy / l, dz / l];

        // Orientation vector for defining the local x-z plane
        let v = match self.orientation {
            Some(v) => v,
            None => {
                // Default: use global Z unless beam is nearly vertical
                if lx[0].abs() < 0.99 && lx[1].abs() < 0.99 {
                    [0.0, 0.0, 1.0]
                } else {
                    [0.0, 1.0, 0.0]
                }
            }
        };

        // Local y-axis: perpendicular to both beam axis and orientation vector
        // ly = v × lx (normalized)
        let ly_raw = [
            v[1] * lx[2] - v[2] * lx[1],
            v[2] * lx[0] - v[0] * lx[2],
            v[0] * lx[1] - v[1] * lx[0],
        ];
        let ly_mag = (ly_raw[0] * ly_raw[0] + ly_raw[1] * ly_raw[1] + ly_raw[2] * ly_raw[2]).sqrt();
        let ly = [ly_raw[0] / ly_mag, ly_raw[1] / ly_mag, ly_raw[2] / ly_mag];

        // Local z-axis: lz = lx × ly
        let lz = [
            lx[1] * ly[2] - lx[2] * ly[1],
            lx[2] * ly[0] - lx[0] * ly[2],
            lx[0] * ly[1] - lx[1] * ly[0],
        ];

        // R transforms local to global: columns are local axes in global coords
        Matrix3::new(
            lx[0], ly[0], lz[0], lx[1], ly[1], lz[1], lx[2], ly[2], lz[2],
        )
    }
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

        // Transform to global frame: K_global = Tᵀ K_local T
        let r = self.rotation_matrix(nodes);
        transform_12x12(&mut k, &r);
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

/// Transform 12×12 element matrix from local to global: K = Tᵀ K T
/// T is block-diagonal with four 3×3 rotation matrices R.
fn transform_12x12(k: &mut DMatrix<f64>, r: &Matrix3<f64>) {
    let mut t = DMatrix::<f64>::zeros(12, 12);
    for block in 0..4 {
        let offset = block * 3;
        for i in 0..3 {
            for j in 0..3 {
                t[(offset + i, offset + j)] = r[(i, j)];
            }
        }
    }
    let k_global = t.transpose() * &*k * &t;
    k.copy_from(&k_global);
}
