pub mod beam;
pub mod shell;

use nalgebra::DMatrix;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ElementType {
    /// Euler-Bernoulli / Timoshenko beam (2 nodes)
    Beam2,
    /// MITC4 shell (4 nodes, 6 DOF/node)
    Shell4,
    /// MITC8 shell (8 nodes)
    Shell8,
    /// Solid tet (4 nodes)
    Tet4,
    /// Solid hex (8 nodes)
    Hex8,
}

impl ElementType {
    pub fn n_nodes(&self) -> usize {
        match self {
            Self::Beam2 => 2,
            Self::Shell4 => 4,
            Self::Shell8 => 8,
            Self::Tet4 => 4,
            Self::Hex8 => 8,
        }
    }

    pub fn dof_per_node(&self) -> usize {
        match self {
            Self::Beam2 | Self::Shell4 | Self::Shell8 => 6,
            Self::Tet4 | Self::Hex8 => 3,
        }
    }

    pub fn n_dof(&self) -> usize {
        self.n_nodes() * self.dof_per_node()
    }
}

pub trait Element {
    fn stiffness_matrix(&self, nodes: &[[f64; 3]]) -> DMatrix<f64>;
    fn consistent_mass_matrix(&self, nodes: &[[f64; 3]], density: f64) -> DMatrix<f64>;
    fn dof_per_node(&self) -> usize;
}
