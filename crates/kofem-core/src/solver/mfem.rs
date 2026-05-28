use super::{FemResult, FemSolver, SolverError};
use crate::{BoundaryConditions, LinearElasticMaterial};
use kofem_mesh::VolumeMesh;

/// Parameters for the MFEM solver backend.
#[derive(Debug, Clone)]
pub struct MfemParams {
    /// Finite element polynomial order (1 = linear H1 tets, 2 = quadratic).
    pub order: i32,
}

impl Default for MfemParams {
    fn default() -> Self {
        Self { order: 1 }
    }
}

/// MFEM-backed linear-elastic FEM solver.
///
/// This is the default [`FemSolver`] implementation.  Create one with
/// [`MfemSolver::new`] and pass it wherever a `&dyn FemSolver` is expected.
pub struct MfemSolver {
    params: MfemParams,
}

impl MfemSolver {
    pub fn new(params: MfemParams) -> Self {
        Self { params }
    }
}

impl Default for MfemSolver {
    fn default() -> Self {
        Self::new(MfemParams::default())
    }
}

impl FemSolver for MfemSolver {
    fn solve_linear_elastic(
        &self,
        mesh: &VolumeMesh,
        material: &LinearElasticMaterial,
        bcs: &BoundaryConditions,
    ) -> Result<FemResult, SolverError> {
        if mesh.vertices.is_empty() || mesh.tetrahedra.is_empty() {
            return Err(SolverError::InvalidMesh("empty mesh".into()));
        }
        if bcs.fixed_vertices.is_empty() {
            return Err(SolverError::BadBoundaryConditions(
                "no fixed vertices — system is unconstrained (rigid body motion possible)".into(),
            ));
        }

        // Flatten mesh data to C-compatible buffers
        let vertices: Vec<f64> = mesh
            .vertices
            .iter()
            .flat_map(|v| v.iter().copied())
            .collect();
        let tets: Vec<i32> = mesh
            .tetrahedra
            .iter()
            .flat_map(|t| t.iter().map(|&i| i as i32))
            .collect();

        let fixed: Vec<ffi::MfemFixedVertex> = bcs
            .fixed_vertices
            .iter()
            .map(|&v| ffi::MfemFixedVertex {
                vertex_index: v as i32,
            })
            .collect();

        let loads: Vec<ffi::MfemPointLoad> = bcs
            .point_loads
            .iter()
            .map(|l| ffi::MfemPointLoad {
                vertex_index: l.vertex as i32,
                fx: l.force[0],
                fy: l.force[1],
                fz: l.force[2],
            })
            .collect();

        let params = ffi::MfemElasticParams {
            young_modulus: material.young_modulus,
            poisson_ratio: material.poisson_ratio,
            order: self.params.order,
        };

        unsafe {
            let mut err: *const std::ffi::c_char = std::ptr::null();

            let mesh_handle = ffi::mfem_create_mesh(
                vertices.as_ptr(),
                mesh.vertices.len(),
                tets.as_ptr(),
                mesh.tetrahedra.len(),
                &mut err,
            );
            check_err(mesh_handle.is_null(), err, "mfem_create_mesh")?;

            let sol_handle = ffi::mfem_solve_linear_elastic(
                mesh_handle,
                &params,
                fixed.as_ptr(),
                fixed.len(),
                loads.as_ptr(),
                loads.len(),
                &mut err,
            );
            if sol_handle.is_null() {
                ffi::mfem_free_mesh(mesh_handle);
                let msg = err_str(err, "mfem_solve_linear_elastic");
                return Err(SolverError::MfemError(msg));
            }

            let n_verts = ffi::mfem_solution_n_vertices(sol_handle);
            let n_elems = ffi::mfem_solution_n_elements(sol_handle);

            let mut displacements = vec![0.0f64; 3 * n_verts];
            let mut von_mises = vec![0.0f64; n_elems];

            ffi::mfem_solution_get_displacements(sol_handle, displacements.as_mut_ptr());
            ffi::mfem_solution_get_von_mises(sol_handle, von_mises.as_mut_ptr());

            ffi::mfem_free_solution(sol_handle);
            ffi::mfem_free_mesh(mesh_handle);

            Ok(FemResult {
                displacements,
                von_mises,
            })
        }
    }
}

fn err_str(ptr: *const std::ffi::c_char, context: &str) -> String {
    if ptr.is_null() {
        format!("{context}: unknown error")
    } else {
        unsafe { std::ffi::CStr::from_ptr(ptr) }
            .to_string_lossy()
            .into_owned()
    }
}

fn check_err(
    is_null: bool,
    err: *const std::ffi::c_char,
    context: &str,
) -> Result<(), SolverError> {
    if is_null {
        Err(SolverError::MfemError(err_str(err, context)))
    } else {
        Ok(())
    }
}

mod ffi {
    #[repr(C)]
    pub struct MfemFixedVertex {
        pub vertex_index: i32,
    }

    #[repr(C)]
    pub struct MfemPointLoad {
        pub vertex_index: i32,
        pub fx: f64,
        pub fy: f64,
        pub fz: f64,
    }

    #[repr(C)]
    pub struct MfemElasticParams {
        pub young_modulus: f64,
        pub poisson_ratio: f64,
        pub order: i32,
    }

    pub type MfemMeshHandle = *mut std::ffi::c_void;
    pub type MfemSolutionHandle = *mut std::ffi::c_void;

    unsafe extern "C" {
        pub fn mfem_create_mesh(
            vertices: *const f64,
            n_vertices: usize,
            tets: *const i32,
            n_tets: usize,
            err: *mut *const std::ffi::c_char,
        ) -> MfemMeshHandle;

        pub fn mfem_solve_linear_elastic(
            mesh: MfemMeshHandle,
            params: *const MfemElasticParams,
            fixed: *const MfemFixedVertex,
            n_fixed: usize,
            loads: *const MfemPointLoad,
            n_loads: usize,
            err: *mut *const std::ffi::c_char,
        ) -> MfemSolutionHandle;

        pub fn mfem_solution_n_vertices(sol: MfemSolutionHandle) -> usize;
        pub fn mfem_solution_n_elements(sol: MfemSolutionHandle) -> usize;
        pub fn mfem_solution_get_displacements(sol: MfemSolutionHandle, out: *mut f64);
        pub fn mfem_solution_get_von_mises(sol: MfemSolutionHandle, out: *mut f64);

        pub fn mfem_free_mesh(mesh: MfemMeshHandle);
        pub fn mfem_free_solution(sol: MfemSolutionHandle);
    }
}
