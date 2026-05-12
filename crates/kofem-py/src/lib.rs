use kofem_core::boundary::{BoundaryConditions, DofIndex};
use kofem_core::{LinearStaticSolver, Mesh};
use pyo3::prelude::*;

#[pyclass]
struct PyMesh {
    inner: Mesh,
}

#[pymethods]
impl PyMesh {
    #[new]
    fn new() -> Self {
        Self { inner: Mesh::new() }
    }

    fn add_node(&mut self, id: usize, x: f64, y: f64, z: f64) -> usize {
        self.inner.add_node(id, x, y, z)
    }

    fn n_nodes(&self) -> usize {
        self.inner.nodes.len()
    }
}

#[pyclass]
struct PyBoundaryConditions {
    inner: BoundaryConditions,
}

#[pymethods]
impl PyBoundaryConditions {
    #[new]
    fn new() -> Self {
        Self {
            inner: BoundaryConditions::default(),
        }
    }

    fn fix_node(&mut self, node_id: usize) {
        self.inner.fix_node(node_id);
    }

    fn apply_force(&mut self, node_id: usize, dof: usize, value: f64) {
        let dof_idx = match dof {
            0 => DofIndex::Ux,
            1 => DofIndex::Uy,
            2 => DofIndex::Uz,
            3 => DofIndex::Rx,
            4 => DofIndex::Ry,
            5 => DofIndex::Rz,
            _ => return,
        };
        self.inner.apply_force(node_id, dof_idx, value);
    }
}

#[pyfunction]
fn solve(mesh: &PyMesh, bcs: &PyBoundaryConditions) -> PyResult<Vec<f64>> {
    LinearStaticSolver::solve(&mesh.inner, &bcs.inner)
        .map(|r| r.displacements)
        .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))
}

#[pymodule]
fn kofem(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<PyMesh>()?;
    m.add_class::<PyBoundaryConditions>()?;
    m.add_function(wrap_pyfunction!(solve, m)?)?;
    Ok(())
}
