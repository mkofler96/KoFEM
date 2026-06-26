// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

use serde::{Deserialize, Serialize};

/// All boundary conditions for a single FEM solve.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BoundaryConditions {
    /// Vertex indices (0-based) whose displacement is fully fixed (Dirichlet u = 0).
    pub fixed_vertices: Vec<usize>,
    /// Concentrated point loads applied at specific vertices.
    pub point_loads: Vec<PointLoad>,
}

/// A concentrated force applied at a mesh vertex.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PointLoad {
    /// 0-based vertex index.
    pub vertex: usize,
    /// Force vector components (N).
    pub force: [f64; 3],
}

impl BoundaryConditions {
    /// Fix all translational DOFs at the given vertex.
    pub fn fix_vertex(&mut self, vertex: usize) {
        self.fixed_vertices.push(vertex);
    }

    /// Apply a concentrated force at a vertex.
    pub fn apply_force(&mut self, vertex: usize, force: [f64; 3]) {
        self.point_loads.push(PointLoad { vertex, force });
    }
}
