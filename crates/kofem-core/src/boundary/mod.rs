use alloc::vec::Vec;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DofIndex {
    Ux = 0, Uy = 1, Uz = 2,
    Rx = 3, Ry = 4, Rz = 5,
}

#[derive(Debug, Clone)]
pub struct NodalConstraint {
    pub node_id: usize,
    pub dof: DofIndex,
    pub prescribed_value: f64,
}

#[derive(Debug, Clone)]
pub struct NodalLoad {
    pub node_id: usize,
    pub dof: DofIndex,
    pub value: f64,
}

#[derive(Debug, Default)]
pub struct BoundaryConditions {
    pub constraints: Vec<NodalConstraint>,
    pub nodal_loads: Vec<NodalLoad>,
}

impl BoundaryConditions {
    pub fn fix_node(&mut self, node_id: usize) {
        for dof in [DofIndex::Ux, DofIndex::Uy, DofIndex::Uz,
                    DofIndex::Rx, DofIndex::Ry, DofIndex::Rz] {
            self.constraints.push(NodalConstraint { node_id, dof, prescribed_value: 0.0 });
        }
    }

    pub fn pin_node(&mut self, node_id: usize) {
        for dof in [DofIndex::Ux, DofIndex::Uy, DofIndex::Uz] {
            self.constraints.push(NodalConstraint { node_id, dof, prescribed_value: 0.0 });
        }
    }

    pub fn apply_force(&mut self, node_id: usize, dof: DofIndex, value: f64) {
        self.nodal_loads.push(NodalLoad { node_id, dof, value });
    }
}
