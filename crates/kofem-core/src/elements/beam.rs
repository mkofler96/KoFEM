//! 3D Euler-Bernoulli/Timoshenko beam element (2 nodes, 12 DOF)
//! DOF order per node: [ux, uy, uz, rx, ry, rz]

use nalgebra::DMatrix;
use super::Element;
use crate::material::IsotropicElastic;

pub struct Beam2Element {
    pub material: IsotropicElastic,
    /// Cross-section area
    pub area: f64,
    /// Moments of inertia: [Iy, Iz]
    pub inertia: [f64; 2],
    /// Torsional constant J
    pub j_torsion: f64,
}

impl Element for Beam2Element {
    fn dof_per_node(&self) -> usize { 6 }

    fn stiffness_matrix(&self, nodes: &[[f64; 3]]) -> DMatrix<f64> {
        let p1 = nodes[0];
        let p2 = nodes[1];
        let dx = p2[0] - p1[0];
        let dy = p2[1] - p1[1];
        let dz = p2[2] - p1[2];
        let l = (dx*dx + dy*dy + dz*dz).sqrt();

        let e = self.material.young;
        let g = self.material.shear_modulus();
        let a = self.area;
        let iy = self.inertia[0];
        let iz = self.inertia[1];
        let j = self.j_torsion;

        // Local stiffness (12x12) in beam-local coordinates
        // axial, torsion, bending-y, bending-z assembled
        let mut k_local = DMatrix::<f64>::zeros(12, 12);

        let ea_l = e * a / l;
        let gj_l = g * j / l;
        let eiz_l3 = e * iz / (l * l * l);
        let eiy_l3 = e * iy / (l * l * l);

        // Axial: DOF 0,6
        k_local[(0,0)] = ea_l;  k_local[(0,6)] = -ea_l;
        k_local[(6,0)] = -ea_l; k_local[(6,6)] = ea_l;

        // Torsion: DOF 3,9
        k_local[(3,3)] = gj_l;  k_local[(3,9)] = -gj_l;
        k_local[(9,3)] = -gj_l; k_local[(9,9)] = gj_l;

        // Bending about z-axis (in x-y plane): DOF 1,5,7,11
        let c1 = 12.0 * eiz_l3;
        let c2 = 6.0 * eiz_l3 * l;
        let c3 = 4.0 * eiz_l3 * l * l;
        let c4 = 2.0 * eiz_l3 * l * l;
        let dof = [1,5,7,11];
        let vals = [[c1,c2,-c1,c2],[c2,c3,-c2,c4],[-c1,-c2,c1,-c2],[c2,c4,-c2,c3]];
        for (i, &di) in dof.iter().enumerate() {
            for (j, &dj) in dof.iter().enumerate() {
                k_local[(di, dj)] = vals[i][j];
            }
        }

        // Bending about y-axis (in x-z plane): DOF 2,4,8,10
        let d1 = 12.0 * eiy_l3;
        let d2 = 6.0 * eiy_l3 * l;
        let d3 = 4.0 * eiy_l3 * l * l;
        let d4 = 2.0 * eiy_l3 * l * l;
        let dof2 = [2,4,8,10];
        let vals2 = [[d1,-d2,-d1,-d2],[-d2,d3,d2,d4],[-d1,d2,d1,d2],[-d2,d4,d2,d3]];
        for (i, &di) in dof2.iter().enumerate() {
            for (j, &dj) in dof2.iter().enumerate() {
                k_local[(di, dj)] = vals2[i][j];
            }
        }

        // TODO: transform to global coordinates via rotation matrix
        // For now return local stiffness (caller must apply transformation)
        k_local
    }

    fn consistent_mass_matrix(&self, nodes: &[[f64; 3]], density: f64) -> DMatrix<f64> {
        let p1 = nodes[0];
        let p2 = nodes[1];
        let dx = p2[0] - p1[0];
        let dy = p2[1] - p1[1];
        let dz = p2[2] - p1[2];
        let l = (dx*dx + dy*dy + dz*dz).sqrt();
        let rho_a_l = density * self.area * l;
        // Lumped mass as placeholder — consistent mass for beams is complex
        let mut m = DMatrix::<f64>::zeros(12, 12);
        let half = rho_a_l / 2.0;
        for i in [0,1,2,6,7,8] {
            m[(i,i)] = half;
        }
        m
    }
}
