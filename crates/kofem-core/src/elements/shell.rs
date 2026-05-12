//! Shell elements (PSHELL property): CTRIA3 and CQUAD4.
//!
//! DOF order per node: [ux, uy, uz, rx, ry, rz] — 6 DOF/node.
//!
//! CQUAD4: MITC4 formulation (Bathe & Dvorkin 1985) — avoids shear locking.
//! CTRIA3: DKT stub — Discrete Kirchhoff Triangle, to be implemented.

use super::Element;
use crate::material::IsotropicElastic;
use nalgebra::DMatrix;

/// CQUAD4 with PSHELL — MITC4 shell element, 4 nodes, 24 DOF.
pub struct Cquad4ShellElement {
    pub material: IsotropicElastic,
    pub thickness: f64,
}

impl Element for Cquad4ShellElement {
    fn dof_per_node(&self) -> usize {
        6
    }

    fn stiffness_matrix(&self, _nodes: &[[f64; 3]]) -> DMatrix<f64> {
        // TODO: implement MITC4 stiffness
        // Membrane: 2×2 Gauss on plane-stress constitutive
        // Bending:  2×2 Gauss on Mindlin plate curvature terms
        // Shear:    mixed interpolation at MITC4 tying points (Bathe & Dvorkin 1985)
        // Reference: Bathe & Dvorkin, IJNME 21 (1985), pp. 367-383
        DMatrix::<f64>::zeros(24, 24)
    }

    fn consistent_mass_matrix(&self, _nodes: &[[f64; 3]], _density: f64) -> DMatrix<f64> {
        DMatrix::<f64>::zeros(24, 24)
    }
}

/// CTRIA3 with PSHELL — DKT (Discrete Kirchhoff Triangle) shell element, 3 nodes, 18 DOF.
pub struct Ctria3ShellElement {
    pub material: IsotropicElastic,
    pub thickness: f64,
}

impl Element for Ctria3ShellElement {
    fn dof_per_node(&self) -> usize {
        6
    }

    fn stiffness_matrix(&self, _nodes: &[[f64; 3]]) -> DMatrix<f64> {
        // TODO: implement DKT bending + CST membrane
        DMatrix::<f64>::zeros(18, 18)
    }

    fn consistent_mass_matrix(&self, _nodes: &[[f64; 3]], _density: f64) -> DMatrix<f64> {
        DMatrix::<f64>::zeros(18, 18)
    }
}

/// CQUAD8 with PSHELL — 8-node serendipity shell element, stub.
pub struct Cquad8ShellElement {
    pub material: IsotropicElastic,
    pub thickness: f64,
}

impl Element for Cquad8ShellElement {
    fn dof_per_node(&self) -> usize {
        6
    }

    fn stiffness_matrix(&self, _nodes: &[[f64; 3]]) -> DMatrix<f64> {
        DMatrix::<f64>::zeros(48, 48)
    }

    fn consistent_mass_matrix(&self, _nodes: &[[f64; 3]], _density: f64) -> DMatrix<f64> {
        DMatrix::<f64>::zeros(48, 48)
    }
}
