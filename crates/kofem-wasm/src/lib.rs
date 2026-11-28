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

mod contact;
mod convergence;
mod failure;
mod field;
mod large_deformation;
mod mixed;
mod outline;
mod quality;
mod report;
mod rigid_body;
mod section;
mod shell;
mod shellize;
mod statistics;
mod stiffness;
mod tie;
mod topology;

pub use contact::{ContactPairs, ContactRun, ContactSolution};
pub use convergence::{
    clamped_free_wedge_exponent, extrapolate_to_zero_size, fit_convergence_rate,
    relative_element_sizes, ConvergenceRate, ZeroSizeExtrapolation,
};
pub use failure::{record_panics, take_panic_message};
pub use field::{check_field_expression, evaluate_field_expression};
pub use large_deformation::{LargeDeformationRun, LargeDeformationSolution};
pub use mixed::MixedModel;
pub use outline::{outer_faces, unique_edges, MeshOuterFaces};
pub use quality::{tet_quality, TetMeshQuality};
pub use report::report_stats;
pub use rigid_body::{free_rigid_motions_js, FreeMotions};
pub use shell::ShellModel;
pub use shellize::{
    CoupledResult, CouplingInput, ExplicitCoupledResult, ShellSet, ShellTransitionResult,
    ShellizeInput,
};
pub use tie::{tie_mortar_weights, MortarSurface, MortarTies, Ties};
pub use topology::{TopologyRun, TopologySettings, TopologyStep};

use kofem_fem::contact::ContactCg;
use kofem_fem::nonlinear::{LinearElastic, NewtonRun, NewtonSettings, NewtonStatus};
use kofem_fem::{
    assemble_stiffness, corner_stress_tensors, fold_onto_vertices, fold_onto_vertices_at,
    load_on_held_nodes, nodal_residual, prepare_coupled_static, prepare_static,
    prepare_tied_static, solve_pcg_with, summarize_reactions, summarize_reactions_at, von_mises,
    widen_translations, AmgSettings, BoundaryFaces, CgSettings, CoupledReduction, Coupling,
    CouplingKind, ElementOrder, FemError, Isotropic, PcgRun, PcgStatus, PreconditionerChoice,
    PreparedCoupled, PreparedTied, ReactionSummary, ShellSurface, StoppingRule, SurfaceLoadKind,
    TetMesh, TieReport, VertexTies, DOFS_PER_NODE,
};
use kofem_fem::{
    corner_stress_tensors_thermal, count_as_f64, thermal_load, thermal_strains_at_centres,
};
use wasm_bindgen::prelude::*;

use stiffness::{Loan, Stiffness};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = Reflect, js_name = set)]
    fn reflect_set(target: &JsValue, key: &str, value: &str) -> bool;
}

fn to_js(error: &FemError) -> JsError {
    with_class(JsError::new(&error.to_string()), error)
}

/// `js_error` with `error`'s class set on it as `failureClass` and, for a
/// numerical failure, `numericalReason` (KOF-490): the app reads these, never
/// the message.
fn with_class(js_error: JsError, error: &FemError) -> JsError {
    let class = error.class();
    let target = JsValue::from(js_error.clone());
    reflect_set(&target, "failureClass", class.category());
    if let Some(reason) = class.reason() {
        reflect_set(&target, "numericalReason", reason);
    }
    js_error
}

/// Values per support in a `supportReactions` result: force, moment about the
/// centroid, centroid, held vertex count.
pub const REACTION_STRIDE: usize = 10;

/// Values per held vertex at the end of a `supportReactions` result.
pub const NODAL_STRIDE: usize = 7;

/// A reaction summary as `supportReactions` returns it: `REACTION_STRIDE`
/// values per support (Fx, Fy, Fz, Mx, My, Mz, the centroid x, y, z, the
/// vertices it holds), then the applied force (3), the applied force on
/// supported DOFs (3), the number of held vertices and `NODAL_STRIDE` values
/// for each (support, x, y, z, Fx, Fy, Fz).
fn flatten_reactions(summary: &ReactionSummary) -> Vec<f64> {
    let mut out = Vec::with_capacity(REACTION_STRIDE * summary.supports.len() + 7);
    for support in &summary.supports {
        out.extend_from_slice(&support.force);
        out.extend_from_slice(&support.moment);
        out.extend_from_slice(&support.centroid);
        out.push(count_as_f64(support.vertices));
    }
    out.extend_from_slice(&summary.applied);
    out.extend_from_slice(&summary.applied_on_supports);
    out.push(count_as_f64(summary.nodal.len()));
    out.reserve(NODAL_STRIDE * summary.nodal.len());
    for node in &summary.nodal {
        out.push(count_as_f64(node.support));
        out.extend_from_slice(&node.position);
        out.extend_from_slice(&node.force);
    }
    out
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
    stiffness: Stiffness,
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
            stiffness: Stiffness::new(),
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

    /// Node coordinates, x,y,z per node: the vertices, then (quadratic) the
    /// edge midpoints, hex face centres and hex centres — the points to
    /// evaluate a nodal field such as a temperature change at.
    #[wasm_bindgen(getter, js_name = nodeCoordinates)]
    #[must_use]
    pub fn node_coordinates(&self) -> Vec<f64> {
        self.mesh.node_coordinates().as_flattened().to_vec()
    }

    /// Equivalent nodal forces of a thermal strain, 3 per node like a force
    /// vector, to add to the mechanical forces before the solve.
    /// `alpha_per_element`: expansion coefficient (1/°C) of every element,
    /// tets first, then hexes. `delta_t_per_node`: temperature change from
    /// the stress-free state at every node (see `nodeCoordinates`).
    ///
    /// # Errors
    /// An array of the wrong length or a value that is not finite.
    #[wasm_bindgen(js_name = thermalLoad)]
    pub fn thermal_load(
        &self,
        alpha_per_element: &[f64],
        delta_t_per_node: &[f64],
    ) -> Result<Vec<f64>, JsError> {
        thermal_load(&self.mesh, alpha_per_element, delta_t_per_node).map_err(|error| to_js(&error))
    }

    /// The corner stress tensors as `stressTensors` gives them, with the
    /// thermal strain of `alphaPerElement` (1/°C) and `deltaTPerNode` (°C)
    /// removed: σ = D·(ε − α·ΔT·I).
    ///
    /// # Errors
    /// A displacement, expansion or temperature array that does not fit the
    /// mesh, or a value that is not finite.
    #[wasm_bindgen(js_name = stressTensorsThermal)]
    pub fn stress_tensors_thermal(
        &self,
        displacements: &[f64],
        alpha_per_element: &[f64],
        delta_t_per_node: &[f64],
    ) -> Result<Vec<f64>, JsError> {
        corner_stress_tensors_thermal(
            &self.mesh,
            displacements,
            alpha_per_element,
            delta_t_per_node,
        )
        .map(|tensors| tensors.into_iter().flatten().collect())
        .map_err(|error| to_js(&error))
    }

    /// The free thermal strain α·ΔT of every element (tets, then hexes) at its
    /// centre, where stresses are recovered: each normal strain component, to
    /// subtract before applying the elasticity matrix (`σ = D·(ε − ε_th)`).
    /// Inputs as for `thermalLoad`.
    ///
    /// # Errors
    /// An array of the wrong length or a value that is not finite.
    #[wasm_bindgen(js_name = thermalStrains)]
    pub fn thermal_strains(
        &self,
        alpha_per_element: &[f64],
        delta_t_per_node: &[f64],
    ) -> Result<Vec<f64>, JsError> {
        thermal_strains_at_centres(&self.mesh, alpha_per_element, delta_t_per_node)
            .map_err(|error| to_js(&error))
    }

    /// Add the work-equivalent nodal forces of one surface load to `forces`
    /// (3 per node), with the MFEM engine's semantics. `triangles` holds the
    /// selected tet faces as vertex-index triples, `quadrilaterals` the
    /// selected hex faces as quadruples; `kind` is `"pressure"`
    /// (`values` = [p], positive pushing in), `"traction"` (force per area)
    /// or `"force"` (total force, spread over the faces' area). `load` names
    /// the load in errors.
    ///
    /// # Errors
    /// A malformed face list or value array, an unknown kind, or a load with
    /// a face off the boundary or a force spread over zero area.
    #[wasm_bindgen(js_name = addSurfaceLoad)]
    pub fn add_surface_load(
        &mut self,
        forces: &mut [f64],
        load: usize,
        triangles: &[u32],
        quadrilaterals: &[u32],
        kind: &str,
        values: &[f64],
    ) -> Result<(), JsError> {
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
        boundary
            .apply(
                &self.mesh,
                load,
                triangles.as_chunks::<3>().0,
                quadrilaterals.as_chunks::<4>().0,
                parsed,
                forces,
            )
            .map_err(|error| to_js(&error))?;
        Ok(())
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

    /// The stress tensor of every element (tets, then hexes) at each of its
    /// corner vertices in its node order (four per tet, eight per hex), six
    /// values each: σxx, σyy, σzz, τxy, τyz, τzx in global axes.
    ///
    /// # Errors
    /// A displacement array that does not fit the mesh.
    #[wasm_bindgen(js_name = stressTensors)]
    pub fn stress_tensors(&self, displacements: &[f64]) -> Result<Vec<f64>, JsError> {
        corner_stress_tensors(&self.mesh, displacements)
            .map(|tensors| tensors.into_iter().flatten().collect())
            .map_err(|error| to_js(&error))
    }

    /// The reaction of each support for a solution of this model and the
    /// `forces` its solve took (3 per node, or 6 per node for a coupled
    /// solve), with the applied loads to check them against. `owners` holds
    /// 6 values per vertex, the support (0..`supports`) that holds each DOF
    /// or −1. The layout of the result is `REACTION_STRIDE` values per
    /// support, then the applied force and the applied force on supported
    /// DOFs (`kofem_fem::reactions`). A coupled or tied solve's reactions go
    /// through its reduction, a large-deformation solve's from its internal
    /// force, with its moments taken where the forces act, in the deformed
    /// configuration (the centroids and nodal positions stay undeformed, for
    /// drawing); a quadratic model's edge, face and centre nodes
    /// fold onto the vertices.
    ///
    /// # Errors
    /// Missing assembly, or a solution, forces or owners that do not fit.
    #[wasm_bindgen(js_name = supportReactions)]
    pub fn support_reactions(
        &self,
        solution: &ElasticSolution,
        forces: &[f64],
        owners: &[i32],
        supports: usize,
    ) -> Result<Vec<f64>, JsError> {
        let wide_forces = if forces.len() == self.mesh.dof_count() {
            widen_translations(forces)
        } else {
            forces.to_vec()
        };
        let residual = match &solution.internal_force {
            Some(internal_force) => {
                if internal_force.len() != forces.len() {
                    return Err(JsError::new(&format!(
                        "support reactions: {} forces for a large-deformation solve of {} DOFs",
                        forces.len(),
                        internal_force.len()
                    )));
                }
                widen_translations(
                    &internal_force
                        .iter()
                        .zip(forces)
                        .map(|(internal, force)| internal - force)
                        .collect::<Vec<_>>(),
                )
            }
            None => {
                self.stiffness
                    .with("supportReactions", |stiffness| match &solution.reduction {
                        Some(reduction) => reduction
                            .reactions(stiffness, &solution.full_dofs, &wide_forces)
                            .map_err(|error| to_js(&error)),
                        None => Ok(widen_translations(
                            &nodal_residual(stiffness, &solution.full_dofs, forces)
                                .map_err(|error| to_js(&error))?,
                        )),
                    })?
            }
        };
        let loads = fold_onto_vertices(&self.mesh, &wide_forces).map_err(|error| to_js(&error))?;
        let mut summary = if solution.internal_force.is_some() {
            // A large deformation balances its forces where they act.
            let deformed = self.deformed_nodes(&solution.full_dofs)?;
            let reactions = fold_onto_vertices_at(&self.mesh, &residual, &deformed)
                .map_err(|error| to_js(&error))?;
            summarize_reactions_at(
                self.mesh.vertices(),
                &deformed[..self.mesh.vertex_count()],
                &reactions,
                &loads,
                owners,
                supports,
            )
        } else {
            let reactions =
                fold_onto_vertices(&self.mesh, &residual).map_err(|error| to_js(&error))?;
            summarize_reactions(self.mesh.vertices(), &reactions, &loads, owners, supports)
        }
        .map_err(|error| to_js(&error))?;
        // Counted before folding: a free edge node's load is not on a support
        // because one of its ends is.
        summary.applied_on_supports =
            load_on_held_nodes(&self.mesh, &wide_forces, owners).map_err(|error| to_js(&error))?;
        Ok(flatten_reactions(&summary))
    }

    /// Where every node is once moved by `displacements` (3 per node).
    fn deformed_nodes(&self, displacements: &[f64]) -> Result<Vec<[f64; 3]>, JsError> {
        if displacements.len() != self.mesh.dof_count() {
            return Err(JsError::new(&format!(
                "support reactions: {} displacements for {} DOFs",
                displacements.len(),
                self.mesh.dof_count()
            )));
        }
        Ok(self
            .mesh
            .node_coordinates()
            .iter()
            .zip(displacements.as_chunks::<3>().0)
            .map(|(point, motion)| std::array::from_fn(|axis| point[axis] + motion[axis]))
            .collect())
    }

    /// Assemble the global stiffness matrix; returns its non-zero count.
    pub fn assemble(&mut self) -> usize {
        let matrix = assemble_stiffness(&self.mesh);
        let nnz = matrix.nnz();
        self.stiffness.set(matrix);
        nnz
    }

    /// Solve K·u = f with the given DOFs (3·node + component) prescribed. On
    /// a quadratic model, conditions on every corner of a boundary face extend
    /// to the face's edge and face nodes (`kofem_fem::prepare_static`).
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
        let mut loan = self.lend_prepared("solve", fixed_dofs, fixed_values, forces, options)?;
        let prepared = loan.get_mut()?;
        let (displacements, outcome) =
            solve_pcg_with(prepared.system.as_mut(), &prepared.rhs, options.settings)
                .map_err(|error| to_js(&error))?;
        Ok(ElasticSolution {
            full_dofs: displacements.clone(),
            displacements,
            iterations: outcome.iterations,
            relative_residual: outcome.relative_residual,
            unused_vertices: prepared.unused_vertices,
            level_sizes: prepared.levels.iter().map(|level| level.unknowns).collect(),
            reduction: None,
            internal_force: None,
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
        let mut prepared =
            self.lend_prepared("startSolve", fixed_dofs, fixed_values, forces, options)?;
        let system = prepared.get_mut()?;
        let run = PcgRun::start(
            system.system.as_mut(),
            &system.rhs,
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
        let PreparedCoupled {
            mut prepared,
            reduction,
        } = self.stiffness.with("startCoupledSolve", |assembled| {
            prepare_coupled_static(
                &self.mesh,
                assembled,
                &couplings.couplings,
                fixed_dofs,
                fixed_values,
                forces,
                options.preconditioner,
            )
            .map_err(|error| to_js(&error))
        })?;
        let run = PcgRun::start(
            prepared.system.as_mut(),
            &prepared.rhs,
            options.settings.relative_tolerance,
            options.settings.stopping,
        )
        .map_err(|error| to_js(&error))?;
        Ok(SolveRun {
            prepared: Loan::owned(prepared),
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
        self.stiffness.with("startTiedSolve", |_| Ok(()))?;
        let vertex_ties = VertexTies::new(
            self.mesh.vertex_count(),
            &ties.slaves,
            &ties.offsets,
            &ties.masters,
            &ties.weights,
        )
        .and_then(|vertex_ties| vertex_ties.with_interfaces(&ties.interfaces))
        .map_err(|error| to_js(&error))?;
        let PreparedTied {
            mut prepared,
            reduction,
            report,
        } = self.stiffness.with("startTiedSolve", |assembled| {
            prepare_tied_static(
                &self.mesh,
                assembled,
                &vertex_ties,
                fixed_dofs,
                fixed_values,
                forces,
                options.preconditioner,
            )
            .map_err(|error| to_js(&error))
        })?;
        let run = PcgRun::start(
            prepared.system.as_mut(),
            &prepared.rhs,
            options.settings.relative_tolerance,
            options.settings.stopping,
        )
        .map_err(|error| to_js(&error))?;
        Ok(SolveRun {
            prepared: Loan::owned(prepared),
            run,
            preconditioner: preconditioner_name(options.preconditioner).to_owned(),
            reduction: Some(reduction),
            output: RunOutput::Translations,
            tie_report: Some(report),
        })
    }

    /// Hexes solved as transition elements (`kofem_fem::transition`): each
    /// has a face that meets two tet triangles.
    #[wasm_bindgen(getter, js_name = transitionElements)]
    #[must_use]
    pub fn transition_elements(&self) -> usize {
        let mut hexes: Vec<usize> = self
            .mesh
            .interface_faces()
            .iter()
            .map(|face| face.hex)
            .collect();
        hexes.dedup();
        hexes.len()
    }
}

#[wasm_bindgen]
impl ElasticModel {
    /// Solve with frictionless contact between the surface pairs `contacts`
    /// (`kofem_fem::contact`), on linear elements, with the constraint ties
    /// `ties` (an empty table for none) and constraints and forces as for
    /// `startSolve`, 3 per node. Returns a run the caller advances in
    /// steps; each correction solve stops at the options' tolerance and fails
    /// after their iteration budget, and the active set must settle within
    /// `max_iterations` iterations. The out-of-balance force is held to the
    /// same tolerance as each correction.
    ///
    /// # Errors
    /// Missing assembly, a contact pair whose sides name no boundary face or
    /// do not face each other, a quadratic model, malformed ties,
    /// constraints or forces, or a zero iteration limit.
    #[allow(
        clippy::too_many_arguments,
        reason = "the tied solve's inputs plus the contact pairs and their iteration limit"
    )]
    #[wasm_bindgen(js_name = startContactSolve)]
    pub fn start_contact_solve(
        &mut self,
        contacts: &ContactPairs,
        ties: &Ties,
        fixed_dofs: &[u32],
        fixed_values: &[f64],
        forces: &[f64],
        options: &SolveOptions,
        max_iterations: usize,
    ) -> Result<ContactRun, JsError> {
        let stiffness = self
            .stiffness
            .with("startContactSolve", |assembled| Ok(assembled.clone()))?;
        let vertex_ties = if ties.slaves.is_empty() {
            None
        } else {
            Some(
                VertexTies::new(
                    self.mesh.vertex_count(),
                    &ties.slaves,
                    &ties.offsets,
                    &ties.masters,
                    &ties.weights,
                )
                .and_then(|vertex_ties| vertex_ties.with_interfaces(&ties.interfaces))
                .map_err(|error| to_js(&error))?,
            )
        };
        let solver = ContactCg::from_picked_surfaces(
            &self.mesh,
            &contacts.sides,
            vertex_ties,
            options.settings,
            options.preconditioner,
        )
        .map_err(|error| to_js(&error))?;
        let run = NewtonRun::start(
            LinearElastic::new(stiffness),
            solver,
            &self.mesh,
            fixed_dofs,
            fixed_values,
            forces,
            NewtonSettings {
                increments: 1,
                max_iterations,
                tolerance: options.settings.relative_tolerance,
            },
        )
        .map_err(|error| to_js(&error))?;
        Ok(ContactRun {
            run,
            unheld: None,
            status: NewtonStatus::Solving {
                increment: 1,
                iteration: 1,
                cg_iterations: 0,
            },
            preconditioner: preconditioner_name(options.preconditioner).to_owned(),
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
    /// (RBE2), 3 shell footprint, 4 distributing over a surface (RBE3 whose
    /// nodes the solve weights by their share of the picked faces' area);
    /// 1 and 3 tie shells to solids and need shell elements. `dof_masks[k]`: the DOFs (bits 0..5) a kinematic coupling
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
                4 => CouplingKind::DistributingSurface,
                code => {
                    return Err(JsError::new(&format!(
                        "coupling {index}: unknown kind {code} (0 distributing, 1 relaxed MPC, \
                         2 kinematic, 3 shell footprint, 4 distributing over a surface)"
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

impl ElasticModel {
    /// The model's matrix, lent to an uncoupled load case set up for CG.
    fn lend_prepared(
        &self,
        caller: &str,
        fixed_dofs: &[u32],
        fixed_values: &[f64],
        forces: &[f64],
        options: &SolveOptions,
    ) -> Result<Loan, JsError> {
        let matrix = self.stiffness.lend(caller)?;
        match prepare_static(
            &self.mesh,
            matrix,
            fixed_dofs,
            fixed_values,
            forces,
            options.preconditioner,
        ) {
            Ok(prepared) => Ok(self.stiffness.loan(prepared)),
            Err(error) => {
                // The set-up consumed the matrix before it failed (a
                // multigrid that finds the model under-constrained); assemble
                // it again so the model stays as it was, then report.
                self.stiffness.set(assemble_stiffness(&self.mesh));
                Err(to_js(&error))
            }
        }
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
    /// The system; on an uncoupled solve, the model's matrix on loan, given
    /// back when the run is finished or freed.
    prepared: Loan,
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
            .advance(self.prepared.get_mut()?.system.as_mut(), until)
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
    ///
    /// # Errors
    /// None while the run exists: only a finished run has no system.
    pub fn level_sizes(&self) -> Result<Vec<usize>, JsError> {
        Ok(self
            .prepared
            .get()?
            .levels
            .iter()
            .map(|level| level.unknowns)
            .collect())
    }

    /// The solution, once converged. Consumes the run.
    ///
    /// # Errors
    /// The run has not converged.
    pub fn finish(self) -> Result<ElasticSolution, JsError> {
        let level_sizes = self.level_sizes()?;
        let unused_vertices = self.prepared.get()?.unused_vertices;
        let (solution, outcome) = self.run.into_solution().map_err(|error| to_js(&error))?;
        let full_dofs = match &self.reduction {
            None => solution,
            Some(reduction) => reduction.expand(&solution),
        };
        let displacements = match (&self.reduction, self.output) {
            (None, _) | (Some(_), RunOutput::AllDofs) => full_dofs.clone(),
            (Some(_), RunOutput::Translations) => full_dofs
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
            full_dofs,
            reduction: self.reduction,
            internal_force: None,
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
#[derive(Clone)]
pub struct ElasticSolution {
    displacements: Vec<f64>,
    iterations: usize,
    relative_residual: f64,
    unused_vertices: usize,
    level_sizes: Vec<usize>,
    /// Every DOF of the solve's own numbering: the solution as it is, or, for
    /// a coupled, tied or mixed solve, expanded to 6 per node.
    pub(crate) full_dofs: Vec<f64>,
    /// A coupled, tied or mixed solve's reduction, for its reactions.
    pub(crate) reduction: Option<CoupledReduction>,
    /// A large-deformation solve's internal force at the solution, for its
    /// reactions: the stiffness times the displacements is not that force.
    pub(crate) internal_force: Option<Vec<f64>>,
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

/// The shell surface a stress is read on: "top" (z = +t/2 along the facet
/// normal), "middle" or "bottom".
///
/// # Errors
/// Any other name.
pub(crate) fn shell_surface(name: &str) -> Result<ShellSurface, JsError> {
    match name {
        "top" => Ok(ShellSurface::Top),
        "middle" => Ok(ShellSurface::Middle),
        "bottom" => Ok(ShellSurface::Bottom),
        other => Err(JsError::new(&format!(
            "shell surface must be \"top\", \"middle\" or \"bottom\", got {other:?}"
        ))),
    }
}
