use serde::{Deserialize, Serialize};

/// Closed, watertight triangle surface mesh — input to the volume mesher.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SurfaceMesh {
    /// 3D vertex positions.
    pub vertices: Vec<[f64; 3]>,
    /// Triangle faces as 0-based vertex indices (CCW winding when viewed from outside).
    pub triangles: Vec<[usize; 3]>,
}

/// Tetrahedral volume mesh produced by Netgen — input to the FEM solver.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VolumeMesh {
    /// 3D vertex positions (includes both surface and interior nodes).
    pub vertices: Vec<[f64; 3]>,
    /// Tetrahedra as 0-based vertex indices.
    pub tetrahedra: Vec<[usize; 4]>,
}

/// Parameters controlling Netgen quality meshing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshOptions {
    /// Maximum tet edge length (mm).  Drives overall mesh density.
    pub max_element_size: f64,
    /// Minimum tet edge length (0.0 = let Netgen decide).
    pub min_element_size: f64,
    /// Grading factor 0.1 (very fine) … 1.0 (coarse).  Controls size transitions.
    pub grading: f64,
    /// Generate quadratic (10-node) tetrahedra instead of linear (4-node).
    pub second_order: bool,
}

impl Default for MeshOptions {
    fn default() -> Self {
        Self {
            max_element_size: 5.0,
            min_element_size: 0.0,
            grading: 0.3,
            second_order: false,
        }
    }
}
