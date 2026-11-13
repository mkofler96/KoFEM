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

mod mixed;
mod shell;
mod shellize;
mod tie;

pub use mixed::MixedModel;
pub use shell::ShellModel;
pub use shellize::{
    CoupledResult, CouplingInput, ExplicitCoupledResult, ShellSet, ShellTransitionResult,
    ShellizeInput,
};
pub use tie::{tie_mortar_weights, MortarSurface, MortarTies, Ties};

use kofem_fem::{
    assemble_stiffness, prepare_coupled_static, prepare_static, prepare_tied_static, solve_static,
    von_mises, AmgSettings, BoundaryFaces, CgSettings, CoupledReduction, Coupling, CouplingKind,
    CsrMatrix, ElementOrder, FemError, Isotropic, PcgRun, PcgStatus, PreconditionerChoice,
    PreparedCoupled, PreparedStatic, PreparedTied, StoppingRule, SurfaceLoadKind, TetMesh,
    TieReport, VertexTies, DOFS_PER_NODE,
};
use wasm_bindgen::prelude::*;

fn to_js(error: &FemError) -> JsError {
    JsError::new(&error.to_string())
}

/// A solid solve's preconditioner, in words for the solve log.
fn preconditioner_name(choice: PreconditionerChoice) -> &'static str {
    match choice {
        PreconditionerChoice::SymmetricGaussSeidel => "symmetric Gauss–Seidel",
        PreconditionerChoice::SmoothedAggregation(_) => "smoothed-aggregation AMG",
    }
}

/// Materials from flat (E, ν) pairs.
fn parse_materials(materials: &[f64]) -> Result<Vec<Isotropic>, JsError> {
    if !materials.len().is_multiple_of(2) {
        return Err(JsError::new(&format!(
            "materials has {} values; expected (E, ν) pairs",
            materials.len()
        )));
    }
    materials
        .as_chunks::<2>()
        .0
        .iter()
        .enumerate()
        .map(|(index, pair)| Isotropic::new(index, pair[0], pair[1]))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| to_js(&error))
}

/// A validated linear-elastic model of tetrahedra and hexahedra, of linear or
/// quadratic elements. DOFs are numbered 3·node + component, with the
/// vertices as the first `vertexCount` nodes; a quadratic model appends one
/// node per edge, then one per hex face and one per hex centre. Elements are
/// numbered tets first, then hexes, as in the MFEM engine.
#[wasm_bindgen]
pub struct ElasticModel {
    mesh: TetMesh,
    stiffness: Option<CsrMatrix>,
    /// Built on the first surface load and kept for the next ones.
    boundary: Option<BoundaryFaces>,
}

#[wasm_bindgen]
impl ElasticModel {
    /// `vertices`: x,y,z per vertex. `tets`: four vertex indices per
    /// tetrahedron, `hexes`: eight per hexahedron in MFEM / CHEXA order (the
    /// bottom face, then the top face above it) — corners only, for either
    /// order; either may be empty. `material_of_element`: one index into
    /// `materials` per element, tets first; `materials` holds (E, ν) pairs.
    /// `order`: 1 (linear) or 2 (quadratic, with the extra nodes generated
    /// here as in MFEM's order-2 space).
    ///
    /// # Errors
    /// The first malformed array, index, element or material, or an order
    /// other than 1 or 2.
    #[wasm_bindgen(constructor)]
    pub fn new(
        vertices: &[f64],
        tets: &[u32],
        hexes: &[u32],
        material_of_element: &[u32],
        materials: &[f64],
        order: u32,
    ) -> Result<ElasticModel, JsError> {
        let order = match order {
            1 => ElementOrder::Linear,
            2 => ElementOrder::Quadratic,
            other => {
                return Err(JsError::new(&format!(
                    "element order {other} is not supported; expected 1 (linear) or 2 (quadratic)"
                )))
            }
        };
        let parsed = parse_materials(materials)?;
        let mesh = TetMesh::with_hexahedra(vertices, tets, hexes, material_of_element, parsed)
            .and_then(|mesh| mesh.with_order(order))
            .map_err(|error| to_js(&error))?;
        Ok(ElasticModel {
            mesh,
            stiffness: None,
            boundary: None,
        })
    }

    /// Unknowns: 3 per node (vertices and, when quadratic, the added nodes).
    #[wasm_bindgen(getter, js_name = dofCount)]
    #[must_use]
    pub fn dof_count(&self) -> usize {
        self.mesh.dof_count()
    }

    /// Vertices: the first nodes, so the first 3·`vertexCount` entries of a
    /// displacement or force vector belong to them.
    #[wasm_bindgen(getter, js_name = vertexCount)]
    #[must_use]
    pub fn vertex_count(&self) -> usize {
        self.mesh.vertex_count()
    }

    /// Add the work-equivalent nodal forces of one surface load to `forces`
    /// (3 per node), with the MFEM engine's semantics. `triangles` holds the
    /// selected tet faces as vertex-index triples, `quadrilaterals` the
    /// selected hex faces as quadruples; `kind` is `"pressure"`
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
        triangles: &[u32],
        quadrilaterals: &[u32],
        kind: &str,
        values: &[f64],
    ) -> Result<usize, JsError> {
        if !triangles.len().is_multiple_of(3) {
            return Err(JsError::new(&format!(
                "surface load {load}: {} triangle indices are not vertex triples",
                triangles.len()
            )));
        }
        if !quadrilaterals.len().is_multiple_of(4) {
            return Err(JsError::new(&format!(
                "surface load {load}: {} quadrilateral indices are not vertex quadruples",
                quadrilaterals.len()
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
        if let Some(&vertex) = triangles
            .iter()
            .chain(quadrilaterals)
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
            .apply(
                &self.mesh,
                load,
                triangles.as_chunks::<3>().0,
                quadrilaterals.as_chunks::<4>().0,
                parsed,
                forces,
            )
            .map_err(|error| to_js(&error))?;
        Ok(report.unmatched)
    }

    /// Von Mises stress of every element (tets, then hexes), at its centre,
    /// for the given displacements (3 per node).
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

    /// Solve K·u = f with the given DOFs (3·node + component) prescribed. On
    /// a quadratic model, conditions on both ends of an edge extend to its
    /// edge node, as in the MFEM engine.
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
        Ok(SolveRun {
            prepared,
            run,
            preconditioner: preconditioner_name(options.preconditioner).to_owned(),
            reduction: None,
            output: RunOutput::Translations,
            tie_report: None,
        })
    }

    /// As `startSolve`, for a model with surface-to-point couplings (the
    /// engine's `solve_coupled` on an all-solid model). Constraints and
    /// forces use 6 DOFs per node (6·node + component, components 3..5 the
    /// rotations), over the vertices and then, on a quadratic model, the edge
    /// nodes: `forces` has one entry per such DOF, and a rotation is fixed,
    /// prescribed or loaded on a coupling reference point only. Couplings
    /// and supports name vertices; on a quadratic model they reach the edge
    /// nodes as `kofem_fem::coupled_static` describes. The run's solution has
    /// 3 translations per node, the reference points' rotations solved but
    /// not returned.
    ///
    /// # Errors
    /// Missing assembly, malformed couplings, constraints
    /// or forces, a condition the couplings make impossible, or a multigrid
    /// setup that finds the model under-constrained.
    #[wasm_bindgen(js_name = startCoupledSolve)]
    pub fn start_coupled_solve(
        &self,
        couplings: &Couplings,
        fixed_dofs: &[u32],
        fixed_values: &[f64],
        forces: &[f64],
        options: &SolveOptions,
    ) -> Result<SolveRun, JsError> {
        let assembled = self
            .stiffness
            .as_ref()
            .ok_or_else(|| JsError::new("assemble() must be called before startCoupledSolve()"))?;
        let PreparedCoupled {
            mut prepared,
            reduction,
        } = prepare_coupled_static(
            &self.mesh,
            assembled,
            &couplings.couplings,
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
        Ok(SolveRun {
            prepared,
            run,
            preconditioner: preconditioner_name(options.preconditioner).to_owned(),
            reduction: Some(reduction),
            output: RunOutput::Translations,
            tie_report: None,
        })
    }

    /// As `startSolve`, with the constraint ties `ties` eliminated
    /// (`kofem_fem::tie`): constraints and forces as for `startSolve`, 3 per
    /// node. A tied vertex DOF a support prescribes keeps its support. On a
    /// quadratic model the tied vertices follow the master faces' quadratic
    /// field, and the edge and face nodes of the tied surface are tied too.
    /// The run's solution has 3 translations per node; its `tiedNodes`,
    /// `tieEliminated` and `tiePrescribed` say what the elimination did.
    ///
    /// # Errors
    /// Missing assembly, a malformed tie table or ties that do not fit the
    /// mesh, ties in a cycle, malformed constraints or forces, or a
    /// multigrid setup that finds the model under-constrained.
    #[wasm_bindgen(js_name = startTiedSolve)]
    pub fn start_tied_solve(
        &self,
        ties: &Ties,
        fixed_dofs: &[u32],
        fixed_values: &[f64],
        forces: &[f64],
        options: &SolveOptions,
    ) -> Result<SolveRun, JsError> {
        let assembled = self
            .stiffness
            .as_ref()
            .ok_or_else(|| JsError::new("assemble() must be called before startTiedSolve()"))?;
        let vertex_ties = VertexTies::new(
            self.mesh.vertex_count(),
            &ties.slaves,
            &ties.offsets,
            &ties.masters,
            &ties.weights,
        )
        .map_err(|error| to_js(&error))?;
        let PreparedTied {
            mut prepared,
            reduction,
            report,
        } = prepare_tied_static(
            &self.mesh,
            assembled,
            &vertex_ties,
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
        Ok(SolveRun {
            prepared,
            run,
            preconditioner: preconditioner_name(options.preconditioner).to_owned(),
            reduction: Some(reduction),
            output: RunOutput::Translations,
            tie_report: Some(report),
        })
    }
}

/// Couplings for `ElasticModel.startCoupledSolve` and
/// `MixedModel.startSolve`, in the CSR layout of the engine's
/// `solve_coupled`: coupling k ties vertex `reference[k]` to vertices
/// `nodes[offsets[k]..offsets[k + 1]]`.
#[wasm_bindgen]
pub struct Couplings {
    couplings: Vec<Coupling>,
}

#[wasm_bindgen]
impl Couplings {
    /// `kinds[k]`: the engine's `mpc` codes — 0 distributing (RBE3), 1 relaxed
    /// shell-to-solid MPC with rotation transfer `relaxation`, 2 kinematic
    /// (RBE2), 3 shell footprint; 1 and 3 tie shells to solids and need shell
    /// elements. `dof_masks[k]`: the DOFs (bits 0..5) a kinematic coupling
    /// ties. `weights`: one per coupled node, or empty for equal weights.
    ///
    /// # Errors
    /// Arrays that disagree in length, offsets that do not partition
    /// `nodes`, an unknown kind, or a kinematic coupling that ties no DOF.
    #[wasm_bindgen(constructor)]
    pub fn new(
        reference: &[u32],
        offsets: &[u32],
        nodes: &[u32],
        kinds: &[i32],
        dof_masks: &[u32],
        weights: &[f64],
        relaxation: f64,
    ) -> Result<Couplings, JsError> {
        let count = reference.len();
        if offsets.len() != count + 1 || kinds.len() != count || dof_masks.len() != count {
            return Err(JsError::new(&format!(
                "couplings: {count} references need {} offsets and {count} kinds and DOF masks, \
                 got {}, {} and {}",
                count + 1,
                offsets.len(),
                kinds.len(),
                dof_masks.len()
            )));
        }
        if offsets.first() != Some(&0)
            || offsets.last().map(|&last| last as usize) != Some(nodes.len())
            || offsets.windows(2).any(|pair| pair[1] < pair[0])
        {
            return Err(JsError::new(
                "couplings: offsets must rise from 0 to the number of coupled nodes",
            ));
        }
        if !weights.is_empty() && weights.len() != nodes.len() {
            return Err(JsError::new(&format!(
                "couplings: {} weights for {} coupled nodes",
                weights.len(),
                nodes.len()
            )));
        }
        let mut couplings = Vec::with_capacity(count);
        for index in 0..count {
            let range = offsets[index] as usize..offsets[index + 1] as usize;
            let kind = match kinds[index] {
                0 => CouplingKind::Distributing,
                1 => CouplingKind::RelaxedMpc { relaxation },
                2 => CouplingKind::Kinematic {
                    dof_mask: u8::try_from(dof_masks[index] & 0x3f).unwrap_or(0),
                },
                3 => CouplingKind::ShellFootprint,
                code => {
                    return Err(JsError::new(&format!(
                        "coupling {index}: unknown kind {code} (0 distributing, 1 relaxed MPC, \
                         2 kinematic, 3 shell footprint)"
                    )))
                }
            };
            couplings.push(Coupling {
                reference: reference[index] as usize,
                nodes: nodes[range.clone()]
                    .iter()
                    .map(|&node| node as usize)
                    .collect(),
                weights: if weights.is_empty() {
                    Vec::new()
                } else {
                    weights[range].to_vec()
                },
                kind,
            });
        }
        Ok(Couplings { couplings })
    }

    /// DOFs per vertex in a coupled solve's constraints and forces.
    #[wasm_bindgen(getter, js_name = dofsPerVertex)]
    #[must_use]
    pub fn dofs_per_vertex(&self) -> usize {
        DOFS_PER_NODE
    }
}

/// What a run's solution holds once expanded through the coupling
/// reduction (a run without one returns its solution as it is).
#[derive(Clone, Copy)]
enum RunOutput {
    /// Three translations per vertex: a coupled solid solve.
    Translations,
    /// All six DOFs per vertex: a mixed solve, whose shell stress needs the
    /// rotations.
    AllDofs,
}

/// A CG solve in progress (from `ElasticModel.startSolve` or
/// `startCoupledSolve`, `ShellModel.startSolve` or `MixedModel.startSolve`).
#[wasm_bindgen]
pub struct SolveRun {
    prepared: PreparedStatic,
    run: PcgRun,
    /// The preconditioner, in words for the solve log.
    preconditioner: String,
    /// How a coupled solve's reduced unknowns expand to the vertices.
    reduction: Option<CoupledReduction>,
    output: RunOutput,
    /// What a tied solve's elimination did; `None` without ties.
    tie_report: Option<TieReport>,
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

    /// Nodes a tied solve ties (edge and face nodes included); 0 without
    /// ties.
    #[wasm_bindgen(getter, js_name = tiedNodes)]
    #[must_use]
    pub fn tied_nodes(&self) -> usize {
        self.tie_report.map_or(0, |report| report.tied_nodes)
    }

    /// Slave DOFs a tied solve eliminates; 0 without ties.
    #[wasm_bindgen(getter, js_name = tieEliminated)]
    #[must_use]
    pub fn tie_eliminated(&self) -> usize {
        self.tie_report.map_or(0, |report| report.eliminated)
    }

    /// Slave DOFs a tied solve leaves to the support that prescribes them;
    /// 0 without ties.
    #[wasm_bindgen(getter, js_name = tiePrescribed)]
    #[must_use]
    pub fn tie_prescribed(&self) -> usize {
        self.tie_report.map_or(0, |report| report.prescribed)
    }

    /// The preconditioner the run uses, in words for the solve log.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn preconditioner(&self) -> String {
        self.preconditioner.clone()
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
        let (solution, outcome) = self.run.into_solution().map_err(|error| to_js(&error))?;
        let displacements = match (&self.reduction, self.output) {
            (None, _) => solution,
            (Some(reduction), RunOutput::AllDofs) => reduction.expand(&solution),
            (Some(reduction), RunOutput::Translations) => reduction
                .expand(&solution)
                .as_chunks::<DOFS_PER_NODE>()
                .0
                .iter()
                .flat_map(|dofs| [dofs[0], dofs[1], dofs[2]])
                .collect(),
        };
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
    /// The solution vector, copied out as a `Float64Array`: x,y,z per node,
    /// vertices first, for `ElasticModel`; u,v,w,θx,θy,θz per vertex for
    /// `ShellModel` and `MixedModel`.
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
