use kofem_core::{
    solver::mfem::{MfemParams, MfemSolver},
    solver::FemSolver,
    BoundaryConditions, LinearElasticMaterial,
};
use kofem_mesh::VolumeMesh;
use pyo3::prelude::*;

/// Python wrapper around a tetrahedral volume mesh.
#[pyclass]
struct PyVolumeMesh {
    inner: VolumeMesh,
}

#[pymethods]
impl PyVolumeMesh {
    #[new]
    fn new() -> Self {
        Self {
            inner: VolumeMesh {
                vertices: vec![],
                tetrahedra: vec![],
            },
        }
    }

    fn add_vertex(&mut self, x: f64, y: f64, z: f64) -> usize {
        let idx = self.inner.vertices.len();
        self.inner.vertices.push([x, y, z]);
        idx
    }

    fn add_tet(&mut self, a: usize, b: usize, c: usize, d: usize) {
        self.inner.tetrahedra.push([a, b, c, d]);
    }

    fn n_vertices(&self) -> usize {
        self.inner.vertices.len()
    }

    fn n_tets(&self) -> usize {
        self.inner.tetrahedra.len()
    }
}

/// Python wrapper around boundary conditions.
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

    fn fix_vertex(&mut self, vertex: usize) {
        self.inner.fix_vertex(vertex);
    }

    fn apply_force(&mut self, vertex: usize, fx: f64, fy: f64, fz: f64) {
        self.inner.apply_force(vertex, [fx, fy, fz]);
    }
}

/// Solve linear elasticity via MFEM.
///
/// Returns a flat list of displacements (3 values per vertex) followed by
/// von-Mises stresses (1 value per element), packed into one list.
#[pyfunction]
#[pyo3(signature = (mesh, bcs, young, poisson, density, order=None))]
fn solve(
    mesh: &PyVolumeMesh,
    bcs: &PyBoundaryConditions,
    young: f64,
    poisson: f64,
    density: f64,
    order: Option<i32>,
) -> PyResult<(Vec<f64>, Vec<f64>)> {
    let material = LinearElasticMaterial {
        young_modulus: young,
        poisson_ratio: poisson,
        density,
    };
    let solver = MfemSolver::new(MfemParams {
        order: order.unwrap_or(1),
    });
    solver
        .solve_linear_elastic(&mesh.inner, &material, &bcs.inner)
        .map(|r| (r.displacements, r.von_mises))
        .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))
}

#[pymodule]
fn kofem(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<PyVolumeMesh>()?;
    m.add_class::<PyBoundaryConditions>()?;
    m.add_function(wrap_pyfunction!(solve, m)?)?;
    Ok(())
}
