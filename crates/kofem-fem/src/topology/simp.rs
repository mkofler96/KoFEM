// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The per-iteration SIMP math: the penalized stiffness, its solve, and the
//! compliance with its self-adjoint sensitivity. Port of the C++ engine's
//! `topology_simp_core.cpp` (ADR-0002).
//!
//! Modified SIMP with a stiffness floor:
//!
//! ```text
//! E(ρ)/E₀ = s(ρ) = E_min/E₀ + ρ^p·(1 − E_min/E₀)
//! ```
//!
//! keeps the operator positive definite as ρ → 0. The element stiffness is
//! linear in E, so `k_e(ρ_e) = s(ρ_e)·k0_e` with `k0_e` the full-material
//! stiffness: built once, then scaled every iteration, never re-integrated.

use crate::amg::{AmgSettings, Preconditioner, SmoothedAggregation, SymmetricGaussSeidel};
use crate::assembly::node_neighbours;
use crate::cg::{solve_pcg_with, CgSettings, StoppingRule};
use crate::constraints::{apply_dirichlet, Dirichlet};
use crate::element::{
    cube_rule, hex8_reference_gradients, hex8_stiffness, hex_gradients, tet4_stiffness,
};
use crate::error::FemError;
use crate::mesh::{signed_volume, ElementOrder, ElementShape, TetMesh};
use crate::sparse::CsrMatrix;

use super::stress::StressOperators;
use super::topology_error;

/// SIMP stiffness interpolation s(ρ) = E(ρ)/E₀, with `emin_rel` = `E_min/E₀`.
#[must_use]
pub fn simp_scale(rho: f64, penalty: f64, emin_rel: f64) -> f64 {
    emin_rel + rho.powf(penalty) * (1.0 - emin_rel)
}

/// ds/dρ of [`simp_scale`].
#[must_use]
pub fn simp_scale_deriv(rho: f64, penalty: f64, emin_rel: f64) -> f64 {
    penalty * rho.powf(penalty - 1.0) * (1.0 - emin_rel)
}

/// Preconditioner of the SIMP solves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SimpPreconditioner {
    /// One symmetric Gauss–Seidel sweep, the C++ engine's choice.
    GaussSeidel,
    /// Smoothed-aggregation multigrid with
    /// [`AmgSettings::topology_optimization`], its hierarchy reused across
    /// designs and rebuilt every [`AMG_REBUILD_EVERY`] designs (KOF-341).
    Amg,
}

/// How the SIMP solves iterate.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SimpSolver {
    pub preconditioner: SimpPreconditioner,
    /// CG stops at ‖f − K·u‖ ≤ this × ‖f‖. Tight by default: the compliance
    /// sensitivities are quadratic in u, so a loose solve biases them.
    pub relative_tolerance: f64,
}

impl Default for SimpSolver {
    fn default() -> Self {
        Self {
            preconditioner: SimpPreconditioner::Amg,
            relative_tolerance: 1e-8,
        }
    }
}

/// A multigrid hierarchy serves this many designs: the first builds it, the
/// next ones only swap in their fine matrix. KOF-341 measured a rebuild every
/// 2–3 iterations as the fastest on a 56k-DOF cantilever.
pub const AMG_REBUILD_EVERY: usize = 3;

/// CG iteration budget of one SIMP solve.
const CG_BUDGET: usize = 20_000;

/// One SIMP evaluation at a density field.
#[derive(Debug, Clone)]
pub struct ComplianceEvaluation {
    /// `c = Σ_e s(ρ_e)·q_e = fᵀu`.
    pub compliance: f64,
    /// `dc/dρ_e` = −s'(`ρ_e`)·qₑ (≤ 0).
    pub dcompliance: Vec<f64>,
    /// qₑ = uₑᵀ·k0ₑ·uₑ (≥ 0).
    pub strain_energy: Vec<f64>,
    /// The solution, x,y,z per node.
    pub displacements: Vec<f64>,
    pub cg_iterations: usize,
}

/// The system of the last design solved, kept so a second solve at the same
/// design (the stress adjoint) reuses it, and the multigrid hierarchy so the
/// next designs can reuse that.
enum System {
    GaussSeidel(SymmetricGaussSeidel),
    Amg {
        amg: SmoothedAggregation,
        /// Designs this hierarchy has served.
        served: usize,
    },
}

impl System {
    fn preconditioner(&mut self) -> &mut dyn Preconditioner {
        match self {
            Self::GaussSeidel(system) => system,
            Self::Amg { amg, .. } => amg,
        }
    }
}

/// A linear-elastic model prepared for SIMP: the full-material element
/// stiffnesses, volumes and centroids, the homogeneous supports and the load,
/// built once and reused by every iteration. Elements are numbered tets
/// first, then hexes, as in [`TetMesh`]; each has its own material, so a
/// model of several bodies keeps their stiffness ratios.
pub struct SimpModel {
    pub(super) mesh: TetMesh,
    /// k0 of every element, row-major (3·node + component), concatenated.
    stiffness: Vec<f64>,
    /// Where each element's k0 starts in `stiffness`; one more entry at the end.
    offsets: Vec<usize>,
    /// For every entry of `stiffness`, its index in the global matrix values.
    positions: Vec<u32>,
    volumes: Vec<f64>,
    centroids: Vec<[f64; 3]>,
    pattern: CsrMatrix,
    supports: Dirichlet,
    constrained: Vec<bool>,
    forces: Vec<f64>,
    solver: SimpSolver,
    /// Element scale factors of the system in `system`.
    scale: Vec<f64>,
    system: Option<System>,
    /// Built on the first stress evaluation.
    pub(super) stress_operators: Option<StressOperators>,
}

impl SimpModel {
    /// Prepare `mesh` (linear tetrahedra and hexahedra) with the DOFs
    /// `fixed_dofs` (3·node + component) held at zero and the nodal `forces`.
    /// Vertices no element uses are held at zero too.
    ///
    /// The compliance objective and its self-adjoint sensitivity hold only for
    /// homogeneous supports and a design-independent load, so a prescribed
    /// displacement cannot be expressed here.
    ///
    /// # Errors
    /// A quadratic mesh, no support, no load, malformed forces or supports, or
    /// a load or support on a vertex no element uses.
    pub fn new(
        mesh: TetMesh,
        fixed_dofs: &[u32],
        mut forces: Vec<f64>,
        solver: SimpSolver,
    ) -> Result<Self, FemError> {
        if mesh.order() != ElementOrder::Linear {
            return Err(topology_error(
                "SIMP uses linear elements, one design density per element; the mesh is \
                 quadratic",
            ));
        }
        if !(solver.relative_tolerance.is_finite() && solver.relative_tolerance > 0.0) {
            return Err(topology_error(
                "the CG tolerance must be finite and positive",
            ));
        }
        let dof_count = mesh.dof_count();
        if forces.len() != dof_count {
            return Err(FemError::ForceLength {
                len: forces.len(),
                count: dof_count,
            });
        }
        if let Some(&value) = forces.iter().find(|value| !value.is_finite()) {
            return Err(FemError::NonFinite {
                what: "a force component",
                value,
            });
        }
        if fixed_dofs.is_empty() {
            return Err(topology_error(
                "topology optimization needs at least one fixed support — the model has no \
                 essential boundary conditions, so it is not fully constrained",
            ));
        }
        let mut dofs = fixed_dofs.to_vec();
        for &dof in fixed_dofs {
            let node = dof as usize / 3;
            if node < mesh.node_count() && !mesh.is_used(node) {
                return Err(FemError::ConstraintOnUnusedVertex { vertex: node });
            }
        }
        for vertex in (0..mesh.vertex_count()).filter(|&vertex| !mesh.is_used(vertex)) {
            if forces[3 * vertex..3 * vertex + 3]
                .iter()
                .any(|&force| force != 0.0)
            {
                return Err(FemError::LoadOnUnusedVertex { vertex });
            }
            #[allow(
                clippy::cast_possible_truncation,
                reason = "TetMesh caps the node count, so every DOF fits in u32"
            )]
            dofs.extend((0..3).map(|component| (3 * vertex + component) as u32));
        }
        let values = vec![0.0; dofs.len()];
        let supports = Dirichlet::new(dof_count, &dofs, &values)?;
        let constrained: Vec<bool> = (0..dof_count)
            .map(|dof| supports.value(dof).is_some())
            .collect();
        // A load on a held DOF goes to the support, not into the structure.
        for (force, &held) in forces.iter_mut().zip(&constrained) {
            if held {
                *force = 0.0;
            }
        }
        if forces.iter().all(|&force| force == 0.0) {
            return Err(topology_error(
                "topology optimization needs an applied load — the assembled load vector is \
                 zero, so the compliance objective is trivial",
            ));
        }

        let neighbours = node_neighbours(&mesh);
        let pattern = CsrMatrix::from_node_pattern(&neighbours);
        let ElementCache {
            stiffness,
            offsets,
            positions,
            volumes,
            centroids,
        } = ElementCache::build(&mesh, &pattern, &neighbours);

        Ok(Self {
            mesh,
            stiffness,
            offsets,
            positions,
            volumes,
            centroids,
            pattern,
            supports,
            constrained,
            forces,
            solver,
            scale: Vec::new(),
            system: None,
            stress_operators: None,
        })
    }

    #[must_use]
    pub fn element_count(&self) -> usize {
        self.volumes.len()
    }

    /// Element measures ∫_e dV.
    #[must_use]
    pub fn volumes(&self) -> &[f64] {
        &self.volumes
    }

    /// Element centres: the mean of the corners, which is where the
    /// (trilinear) map of a hex puts its reference centre.
    #[must_use]
    pub fn centroids(&self) -> &[[f64; 3]] {
        &self.centroids
    }

    #[must_use]
    pub fn mesh(&self) -> &TetMesh {
        &self.mesh
    }

    /// Global DOFs of `element`, in its stiffness order.
    pub(crate) fn element_dofs(&self, element: usize) -> impl Iterator<Item = usize> + '_ {
        self.mesh
            .element_nodes(element)
            .iter()
            .flat_map(|&node| (0..3).map(move |component| 3 * node as usize + component))
    }

    /// k0 of `element`, row-major over [`SimpModel::element_dofs`].
    pub(crate) fn element_stiffness(&self, element: usize) -> &[f64] {
        &self.stiffness[self.offsets[element]..self.offsets[element + 1]]
    }

    /// uₑᵀ·k0ₑ·vₑ of `element` for the global vectors `u` and `v`.
    pub(crate) fn element_product(&self, element: usize, lhs: &[f64], rhs: &[f64]) -> f64 {
        let stiffness = self.element_stiffness(element);
        let dofs: Vec<usize> = self.element_dofs(element).collect();
        let width = dofs.len();
        let mut total = 0.0;
        for (row, &row_dof) in dofs.iter().enumerate() {
            let entries = &stiffness[row * width..(row + 1) * width];
            let product: f64 = entries
                .iter()
                .zip(&dofs)
                .map(|(entry, &col_dof)| entry * rhs[col_dof])
                .sum();
            total += lhs[row_dof] * product;
        }
        total
    }

    fn check_density(&self, rho: &[f64]) -> Result<(), FemError> {
        if rho.len() != self.element_count() {
            return Err(topology_error(format!(
                "the density field has {} entries, but the mesh has {} elements",
                rho.len(),
                self.element_count()
            )));
        }
        if let Some(&value) = rho.iter().find(|value| !value.is_finite()) {
            return Err(FemError::NonFinite {
                what: "a design density",
                value,
            });
        }
        Ok(())
    }

    /// Solve `K(ρ)·x = rhs` with `K(ρ) = Σ_e s(ρ_e)·k0_e` and x = 0 on the
    /// supports; `rhs` on the supports is ignored. Returns x (3 per node) and
    /// the CG iterations. A second solve at the same design reuses its system.
    ///
    /// # Errors
    /// A density field that does not fit the mesh, a multigrid setup that finds
    /// the model under-constrained, or a CG breakdown or non-convergence.
    pub fn solve(
        &mut self,
        rhs: &[f64],
        rho: &[f64],
        penalty: f64,
        emin_rel: f64,
    ) -> Result<(Vec<f64>, usize), FemError> {
        self.check_density(rho)?;
        if rhs.len() != self.constrained.len() {
            return Err(FemError::ForceLength {
                len: rhs.len(),
                count: self.constrained.len(),
            });
        }
        let scale: Vec<f64> = rho
            .iter()
            .map(|&density| simp_scale(density, penalty, emin_rel))
            .collect();
        if self.system.is_none() || scale != self.scale {
            self.prepare(&scale)?;
        }
        let mut load = rhs.to_vec();
        for (value, &held) in load.iter_mut().zip(&self.constrained) {
            if held {
                *value = 0.0;
            }
        }
        let settings = CgSettings {
            relative_tolerance: self.solver.relative_tolerance,
            max_iterations: CG_BUDGET,
            stopping: StoppingRule::ResidualNorm,
        };
        let system = self
            .system
            .as_mut()
            .ok_or_else(|| topology_error("the SIMP system was not assembled"))?;
        let (solution, outcome) = solve_pcg_with(system.preconditioner(), &load, settings)?;
        Ok((solution, outcome.iterations))
    }

    /// Assemble K for the element scales `scale` and set up its preconditioner.
    fn prepare(&mut self, scale: &[f64]) -> Result<(), FemError> {
        let mut matrix = self.pattern.clone();
        {
            let values = matrix.values_mut();
            for (element, &factor) in scale.iter().enumerate() {
                let range = self.offsets[element]..self.offsets[element + 1];
                for (&entry, &position) in self.stiffness[range.clone()]
                    .iter()
                    .zip(&self.positions[range])
                {
                    values[position as usize] += factor * entry;
                }
            }
        }
        let mut scratch = vec![0.0; matrix.rows()];
        apply_dirichlet(&mut matrix, &mut scratch, &self.supports);
        let system = match (self.solver.preconditioner, self.system.take()) {
            (SimpPreconditioner::GaussSeidel, _) => {
                System::GaussSeidel(SymmetricGaussSeidel::new(matrix))
            }
            (SimpPreconditioner::Amg, Some(System::Amg { mut amg, served }))
                if served < AMG_REBUILD_EVERY =>
            {
                amg.replace_fine_matrix(matrix)?;
                System::Amg {
                    amg,
                    served: served + 1,
                }
            }
            (SimpPreconditioner::Amg, _) => System::Amg {
                amg: SmoothedAggregation::new(
                    matrix,
                    self.mesh.node_coordinates(),
                    &self.constrained,
                    AmgSettings::topology_optimization(),
                )?,
                served: 1,
            },
        };
        self.system = Some(system);
        self.scale = scale.to_vec();
        Ok(())
    }

    /// Solve K(ρ)·u = f and return the compliance and its element
    /// sensitivities (see [`ComplianceEvaluation`]).
    ///
    /// # Errors
    /// As [`SimpModel::solve`].
    pub fn evaluate_compliance(
        &mut self,
        rho: &[f64],
        penalty: f64,
        emin_rel: f64,
    ) -> Result<ComplianceEvaluation, FemError> {
        let forces = std::mem::take(&mut self.forces);
        let solved = self.solve(&forces, rho, penalty, emin_rel);
        self.forces = forces;
        let (displacements, cg_iterations) = solved?;
        let count = self.element_count();
        let mut compliance = 0.0;
        let mut dcompliance = Vec::with_capacity(count);
        let mut strain_energy = Vec::with_capacity(count);
        for (element, &density) in rho.iter().enumerate() {
            let energy = self.element_product(element, &displacements, &displacements);
            strain_energy.push(energy);
            compliance += simp_scale(density, penalty, emin_rel) * energy;
            dcompliance.push(-simp_scale_deriv(density, penalty, emin_rel) * energy);
        }
        Ok(ComplianceEvaluation {
            compliance,
            dcompliance,
            strain_energy,
            displacements,
            cg_iterations,
        })
    }
}

/// The per-element quantities a [`SimpModel`] builds once.
struct ElementCache {
    stiffness: Vec<f64>,
    offsets: Vec<usize>,
    positions: Vec<u32>,
    volumes: Vec<f64>,
    centroids: Vec<[f64; 3]>,
}

impl ElementCache {
    /// Full-material k0, its positions in `pattern`, the volume and the
    /// centroid of every element of `mesh`.
    fn build(mesh: &TetMesh, pattern: &CsrMatrix, neighbours: &[Vec<u32>]) -> Self {
        let element_count = mesh.element_count();
        let mut cache = Self {
            stiffness: Vec::new(),
            offsets: Vec::with_capacity(element_count + 1),
            positions: Vec::new(),
            volumes: Vec::with_capacity(element_count),
            centroids: Vec::with_capacity(element_count),
        };
        let tet_count = mesh.tets().len();
        for element in 0..element_count {
            cache.offsets.push(cache.stiffness.len());
            let material = mesh.material(element);
            match mesh.shape(element) {
                ElementShape::Tetrahedron => {
                    let corners = mesh.corners(element);
                    cache
                        .stiffness
                        .extend_from_slice(tet4_stiffness(&corners, material).as_flattened());
                    cache.volumes.push(signed_volume(&corners).abs());
                    cache.centroids.push(mean_point(&corners));
                }
                ElementShape::Hexahedron => {
                    let corners = mesh.hex_corners(element - tet_count);
                    cache
                        .stiffness
                        .extend_from_slice(hex8_stiffness(&corners, material).as_flattened());
                    cache.volumes.push(hex_volume(&corners));
                    cache.centroids.push(mean_point(&corners));
                }
            }
            push_positions(
                pattern,
                neighbours,
                mesh.element_nodes(element),
                &mut cache.positions,
            );
        }
        cache.offsets.push(cache.stiffness.len());
        cache
    }
}

pub(super) fn mean_point<const N: usize>(corners: &[[f64; 3]; N]) -> [f64; 3] {
    #[allow(
        clippy::cast_precision_loss,
        reason = "N is 3, 4 or 8, exactly representable"
    )]
    let count = N as f64;
    std::array::from_fn(|axis| corners.iter().map(|corner| corner[axis]).sum::<f64>() / count)
}

/// Volume of a trilinear hex: ∫|det J| over the unit cube. det J is of degree
/// two in each reference coordinate, so the 2³-point Gauss rule is exact.
fn hex_volume(corners: &[[f64; 3]; 8]) -> f64 {
    cube_rule(2)
        .into_iter()
        .map(|(point, weight)| {
            weight * hex_gradients(corners, &hex8_reference_gradients(point), point).1
        })
        .sum()
}

/// Append, for every entry of an element stiffness over `nodes` (row-major,
/// 3·node + component), its index in the values of `pattern`.
pub(super) fn push_positions(
    pattern: &CsrMatrix,
    neighbours: &[Vec<u32>],
    nodes: &[u32],
    positions: &mut Vec<u32>,
) {
    for &node_a in nodes {
        let list = &neighbours[node_a as usize];
        for component_a in 0..3 {
            let row_first = pattern.row_range(3 * node_a as usize + component_a).start;
            for &node_b in nodes {
                let block = list
                    .binary_search(&node_b)
                    .unwrap_or_else(|_| unreachable!("nodes of one element are neighbours"));
                for component_b in 0..3 {
                    #[allow(
                        clippy::cast_possible_truncation,
                        reason = "the non-zero count of a TetMesh stiffness fits in u32"
                    )]
                    positions.push((row_first + 3 * block + component_b) as u32);
                }
            }
        }
    }
}
