// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Browser bindings for `kofem-fem`. Arrays cross as typed arrays (copied into
//! WASM memory once); every failure reaches JS as an `Error` carrying the
//! `FemError` message. Assembly and solve are separate calls so the caller can
//! time them and keep the assembled matrix for several load cases.
//!
//! Numerical implementation based on KoFEM's MFEM solver approach; upstream
//! credit and BSD-3-Clause terms are retained in `../kofem-fem/NOTICE.md` and
//! `../kofem-fem/LICENSE-MFEM`, also shipped beside the generated WASM module.

use kofem_fem::{
    assemble_stiffness, prepare_static, solve_static, von_mises, AmgSettings, BoundaryFaces,
    CgSettings, CsrMatrix, FemError, Isotropic, PcgRun, PcgStatus, PreconditionerChoice,
    PreparedStatic, StoppingRule, SurfaceLoadKind, TetMesh,
};
use wasm_bindgen::prelude::*;

fn to_js(error: &FemError) -> JsError {
    JsError::new(&error.to_string())
}

/// A validated linear-elastic tetrahedral model.
#[wasm_bindgen]
pub struct ElasticModel {
    mesh: TetMesh,
    stiffness: Option<CsrMatrix>,
    /// Built on the first surface load and kept for the next ones.
    boundary: Option<BoundaryFaces>,
}

#[wasm_bindgen]
impl ElasticModel {
    /// `vertices`: x,y,z per vertex. `tets`: four vertex indices per element.
    /// `material_of_tet`: index into `materials`, which holds (E, ν) pairs.
    ///
    /// # Errors
    /// The first malformed array, index, element or material.
    #[wasm_bindgen(constructor)]
    pub fn new(
        vertices: &[f64],
        tets: &[u32],
        material_of_tet: &[u32],
        materials: &[f64],
    ) -> Result<ElasticModel, JsError> {
        if !materials.len().is_multiple_of(2) {
            return Err(JsError::new(&format!(
                "materials has {} values; expected (E, ν) pairs",
                materials.len()
            )));
        }
        let parsed = materials
            .as_chunks::<2>()
            .0
            .iter()
            .enumerate()
            .map(|(index, pair)| Isotropic::new(index, pair[0], pair[1]))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| to_js(&error))?;
        let mesh =
            TetMesh::new(vertices, tets, material_of_tet, parsed).map_err(|error| to_js(&error))?;
        Ok(ElasticModel {
            mesh,
            stiffness: None,
            boundary: None,
        })
    }

    #[wasm_bindgen(getter, js_name = dofCount)]
    #[must_use]
    pub fn dof_count(&self) -> usize {
        3 * self.mesh.vertex_count()
    }

    /// Add the work-equivalent nodal forces of one surface load to `forces`
    /// (3 per vertex), with the MFEM engine's semantics. `faces` holds the
    /// selected triangles as vertex-index triples; `kind` is `"pressure"`
    /// (`values` = [p], positive pushing in), `"traction"` (force per area)
    /// or `"force"` (total force, spread over the faces' area). `load` names
    /// the load in errors. Returns how many selected faces are not on the
    /// boundary (stale or interior selections), for the caller to report.
    ///
    /// # Errors
    /// A malformed face list or value array, an unknown kind, or a load that
    /// matches no boundary face or spreads a force over zero area.
    #[wasm_bindgen(js_name = addSurfaceLoad)]
    pub fn add_surface_load(
        &mut self,
        forces: &mut [f64],
        load: usize,
        faces: &[u32],
        kind: &str,
        values: &[f64],
    ) -> Result<usize, JsError> {
        if !faces.len().is_multiple_of(3) {
            return Err(JsError::new(&format!(
                "surface load {load}: {} face indices are not vertex triples",
                faces.len()
            )));
        }
        let vector = |values: &[f64]| -> Result<[f64; 3], JsError> {
            <[f64; 3]>::try_from(values).map_err(|_| {
                JsError::new(&format!(
                    "surface load {load} ({kind}): expected 3 components, got {}",
                    values.len()
                ))
            })
        };
        let parsed = match kind {
            "pressure" => match values {
                [pressure] => SurfaceLoadKind::Pressure(*pressure),
                _ => {
                    return Err(JsError::new(&format!(
                        "surface load {load} (pressure): expected 1 value, got {}",
                        values.len()
                    )))
                }
            },
            "traction" => SurfaceLoadKind::Traction(vector(values)?),
            "force" => SurfaceLoadKind::Force(vector(values)?),
            other => {
                return Err(JsError::new(&format!(
                    "surface load {load}: unknown kind \"{other}\"; expected \"pressure\", \
                     \"traction\" or \"force\""
                )))
            }
        };
        let vertex_count = self.mesh.vertex_count();
        if let Some(&vertex) = faces
            .iter()
            .find(|&&vertex| vertex as usize >= vertex_count)
        {
            return Err(JsError::new(&format!(
                "surface load {load}: face vertex {vertex} is out of range (the mesh has \
                 {vertex_count} vertices)"
            )));
        }
        let boundary = self
            .boundary
            .get_or_insert_with(|| BoundaryFaces::new(&self.mesh));
        let report = boundary
            .apply(&self.mesh, load, faces.as_chunks::<3>().0, parsed, forces)
            .map_err(|error| to_js(&error))?;
        Ok(report.unmatched)
    }

    /// Von Mises stress of every tet for the given displacements (3 per vertex).
    ///
    /// # Errors
    /// A displacement array that does not fit the mesh.
    #[wasm_bindgen(js_name = vonMises)]
    pub fn von_mises(&self, displacements: &[f64]) -> Result<Vec<f64>, JsError> {
        von_mises(&self.mesh, displacements).map_err(|error| to_js(&error))
    }

    /// Assemble the global stiffness matrix; returns its non-zero count.
    pub fn assemble(&mut self) -> usize {
        let matrix = assemble_stiffness(&self.mesh);
        let nnz = matrix.nnz();
        self.stiffness = Some(matrix);
        nnz
    }

    /// Solve K·u = f with the given DOFs (3·vertex + component) prescribed.
    ///
    /// # Errors
    /// Missing assembly, malformed constraints or forces, or a solve that
    /// breaks down or does not converge.
    pub fn solve(
        &self,
        fixed_dofs: &[u32],
        fixed_values: &[f64],
        forces: &[f64],
        options: &SolveOptions,
    ) -> Result<ElasticSolution, JsError> {
        let assembled = self
            .stiffness
            .as_ref()
            .ok_or_else(|| JsError::new("assemble() must be called before solve()"))?;
        let solution = solve_static(
            &self.mesh,
            assembled,
            fixed_dofs,
            fixed_values,
            forces,
            options.settings,
            options.preconditioner,
        )
        .map_err(|error| to_js(&error))?;
        Ok(ElasticSolution {
            displacements: solution.displacements,
            iterations: solution.iterations,
            relative_residual: solution.relative_residual,
            unused_vertices: solution.unused_vertices,
            level_sizes: solution.levels.iter().map(|level| level.unknowns).collect(),
        })
    }

    /// Set up the same solve as `solve`, but return it as a run the caller
    /// advances in steps — to report progress between steps and to ask the
    /// user before going past an iteration budget. The options' tolerance,
    /// preconditioner and stopping rule apply; their iteration budget does
    /// not, since the caller decides how far to advance.
    ///
    /// # Errors
    /// Missing assembly, malformed constraints or forces, or a multigrid
    /// setup that finds the model under-constrained.
    #[wasm_bindgen(js_name = startSolve)]
    pub fn start_solve(
        &self,
        fixed_dofs: &[u32],
        fixed_values: &[f64],
        forces: &[f64],
        options: &SolveOptions,
    ) -> Result<SolveRun, JsError> {
        let assembled = self
            .stiffness
            .as_ref()
            .ok_or_else(|| JsError::new("assemble() must be called before startSolve()"))?;
        let mut prepared = prepare_static(
            &self.mesh,
            assembled,
            fixed_dofs,
            fixed_values,
            forces,
            options.preconditioner,
        )
        .map_err(|error| to_js(&error))?;
        let run = PcgRun::start(
            prepared.system.as_mut(),
            &prepared.rhs,
            options.settings.relative_tolerance,
            options.settings.stopping,
        )
        .map_err(|error| to_js(&error))?;
        Ok(SolveRun { prepared, run })
    }
}

/// A CG solve in progress (from `ElasticModel.startSolve`).
#[wasm_bindgen]
pub struct SolveRun {
    prepared: PreparedStatic,
    run: PcgRun,
}

#[wasm_bindgen]
impl SolveRun {
    /// Run up to `steps` more iterations; returns whether the tolerance is met.
    ///
    /// # Errors
    /// A CG breakdown (the model is not positive definite).
    pub fn advance(&mut self, steps: usize) -> Result<bool, JsError> {
        let until = self.run.iterations().saturating_add(steps);
        let status = self
            .run
            .advance(self.prepared.system.as_mut(), until)
            .map_err(|error| to_js(&error))?;
        Ok(status == PcgStatus::Converged)
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn iterations(&self) -> usize {
        self.run.iterations()
    }

    /// Current relative residual, in the options' stopping measure.
    #[wasm_bindgen(getter, js_name = relativeResidual)]
    #[must_use]
    pub fn relative_residual(&self) -> f64 {
        self.run.relative_residual()
    }

    /// The relative residual the run stops at.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn tolerance(&self) -> f64 {
        self.run.tolerance()
    }

    /// Whether the residual still fell over the last `window` iterations
    /// (at most 100), i.e. whether more iterations are worth offering. The
    /// MFEM engine's rule for its "continue solving?" prompt.
    #[wasm_bindgen(js_name = stillDescending)]
    #[must_use]
    pub fn still_descending(&self, window: usize) -> bool {
        self.run.still_descending(window)
    }

    /// Unknowns per multigrid level, finest first; empty for Gauss–Seidel.
    #[wasm_bindgen(getter, js_name = levelSizes)]
    #[must_use]
    pub fn level_sizes(&self) -> Vec<usize> {
        self.prepared
            .levels
            .iter()
            .map(|level| level.unknowns)
            .collect()
    }

    /// The solution, once converged. Consumes the run.
    ///
    /// # Errors
    /// The run has not converged.
    pub fn finish(self) -> Result<ElasticSolution, JsError> {
        let level_sizes = self.level_sizes();
        let unused_vertices = self.prepared.unused_vertices;
        let (displacements, outcome) = self.run.into_solution().map_err(|error| to_js(&error))?;
        Ok(ElasticSolution {
            displacements,
            iterations: outcome.iterations,
            relative_residual: outcome.relative_residual,
            unused_vertices,
            level_sizes,
        })
    }
}

/// How `ElasticModel.solve` iterates. Checked on construction, so a typo in a
/// name fails before any work is done.
#[wasm_bindgen]
pub struct SolveOptions {
    settings: CgSettings,
    preconditioner: PreconditionerChoice,
}

#[wasm_bindgen]
impl SolveOptions {
    /// `preconditioner`: `"gauss-seidel"` (the MFEM engine's method) or
    /// `"amg"` (smoothed-aggregation multigrid). `stopping`:
    /// `"preconditioned"` (MFEM's rule, √((M⁻¹r, r)/(M⁻¹r₀, r₀)), whose
    /// meaning depends on the preconditioner) or `"residual"` (‖f − K·u‖ / ‖f‖).
    ///
    /// # Errors
    /// An unknown preconditioner or stopping rule.
    #[wasm_bindgen(constructor)]
    pub fn new(
        relative_tolerance: f64,
        max_iterations: usize,
        preconditioner: &str,
        stopping: &str,
    ) -> Result<SolveOptions, JsError> {
        let preconditioner = match preconditioner {
            "gauss-seidel" => PreconditionerChoice::SymmetricGaussSeidel,
            "amg" => PreconditionerChoice::SmoothedAggregation(AmgSettings::default()),
            other => {
                return Err(JsError::new(&format!(
                    "unknown preconditioner \"{other}\"; expected \"gauss-seidel\" or \"amg\""
                )))
            }
        };
        let stopping = match stopping {
            "preconditioned" => StoppingRule::PreconditionedNorm,
            "residual" => StoppingRule::ResidualNorm,
            other => {
                return Err(JsError::new(&format!(
                    "unknown stopping rule \"{other}\"; expected \"preconditioned\" or \"residual\""
                )))
            }
        };
        Ok(SolveOptions {
            settings: CgSettings {
                relative_tolerance,
                max_iterations,
                stopping,
            },
            preconditioner,
        })
    }
}

#[wasm_bindgen]
pub struct ElasticSolution {
    displacements: Vec<f64>,
    iterations: usize,
    relative_residual: f64,
    unused_vertices: usize,
    level_sizes: Vec<usize>,
}

#[wasm_bindgen]
impl ElasticSolution {
    /// Displacement per vertex, x,y,z interleaved (copied out as a `Float64Array`).
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn displacements(&self) -> Vec<f64> {
        self.displacements.clone()
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn iterations(&self) -> usize {
        self.iterations
    }

    /// Vertices no element uses: held at zero displacement, never loaded.
    #[wasm_bindgen(getter, js_name = unusedVertices)]
    #[must_use]
    pub fn unused_vertices(&self) -> usize {
        self.unused_vertices
    }

    /// Unknowns per multigrid level, finest first; empty for Gauss–Seidel.
    #[wasm_bindgen(getter, js_name = levelSizes)]
    #[must_use]
    pub fn level_sizes(&self) -> Vec<usize> {
        self.level_sizes.clone()
    }

    #[wasm_bindgen(getter, js_name = relativeResidual)]
    #[must_use]
    pub fn relative_residual(&self) -> f64 {
        self.relative_residual
    }
}
