// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! SIMP on the shell and coupled shell/solid design domains: Kirchhoff shell
//! facets and, for a coupled model, linear tets over the same node pool,
//! joined by couplings. Port of the C++ engine's `topology_shell.cpp`.
//!
//! One density field spans the whole design domain, tets first, then facets.
//! The couplings are not design variables: they are eliminated by the
//! master–slave reduction of the coupled solve
//! ([`prepare_mixed_static`]), so they stay intact through every iteration.
//! Each element's stiffness is linear in its modulus, so
//! `k_e(ρ_e) = s(ρ_e)·k0_e`, and the compliance is self-adjoint:
//! `dc/dρ_e = −s'(ρ_e)·uₑᵀk0ₑuₑ`, with `uₑ` all six DOFs of a facet's
//! nodes or the translations of a tet's.

use crate::assembly::node_neighbours;
use crate::cg::{solve_pcg_with, CgSettings, StoppingRule};
use crate::coupled_static::{prepare_mixed_static, MixedPreconditioner, ShellPart};
use crate::coupling::{Coupling, DOFS_PER_NODE};
use crate::element::tet4_stiffness;
use crate::error::FemError;
use crate::mesh::{signed_volume, ElementOrder, TetMesh};
use crate::shell::assembly::{shell_node_neighbours, SHELL_NODE_DOFS};
use crate::shell::{facet_stiffness, prepare_shell_static, ShellMesh};
use crate::sparse::CsrMatrix;

use super::optimize::DesignModel;
use super::simp::{
    mean_point, push_positions, simp_scale, simp_scale_deriv, ComplianceEvaluation, SimpModel,
};
use super::topology_error;

/// How the solves of a [`MixedSimpModel`] iterate.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MixedSolver {
    /// The coupled solve's preconditioner. A pure-shell model (no tets, no
    /// couplings) always takes IC(0), with symmetric Gauss–Seidel when it
    /// cannot factor — the shell solve's choice.
    pub preconditioner: MixedPreconditioner,
    /// CG stops at ‖f − K·u‖ ≤ this × ‖f‖.
    pub relative_tolerance: f64,
}

impl Default for MixedSolver {
    /// IC(0) at 1e-5, the engine's shell SIMP solve
    /// (`ShellTopOptConfig::cg_rtol`): as void regions form, the conditioning
    /// of a thin-wall system worsens until a tighter target runs the CG budget
    /// out mid-run (KOF-245), while the sensitivities, quadratic in u, stay
    /// accurate to about the tolerance.
    fn default() -> Self {
        Self {
            preconditioner: MixedPreconditioner::IncompleteCholesky,
            relative_tolerance: 1e-5,
        }
    }
}

/// The CG budget of one solve: as the static shell solve sizes it.
fn cg_budget(dofs: usize) -> usize {
    #[allow(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a positive iteration count far below 2^52"
    )]
    let scaled = (400.0 * (dofs as f64).cbrt()) as usize;
    scaled.max(20_000)
}

/// One domain's assembled pattern and, for each entry of its elements'
/// stiffnesses, the position in that pattern.
struct Domain {
    pattern: CsrMatrix,
    positions: Vec<u32>,
}

/// A shell or coupled shell/solid model prepared for SIMP: the
/// full-material element stiffnesses, volumes and centroids, the supports
/// and the load, built once and reused by every iteration.
pub struct MixedSimpModel {
    solid: Option<(TetMesh, Domain)>,
    shell: Option<(ShellMesh, Domain)>,
    couplings: Vec<Coupling>,
    fixed_dofs: Vec<u32>,
    forces: Vec<f64>,
    node_count: usize,
    tet_count: usize,
    /// k0 of every element over its DOFs (row-major), concatenated.
    stiffness: Vec<f64>,
    /// The global DOFs (6·node + component) of every element, concatenated.
    dofs: Vec<usize>,
    /// Where each element's DOFs start in `dofs`; one more entry at the end.
    dof_offsets: Vec<usize>,
    volumes: Vec<f64>,
    centroids: Vec<[f64; 3]>,
    solver: MixedSolver,
}

impl MixedSimpModel {
    /// Prepare the design domain: the linear tets of `solid` and the facets
    /// of `shell` over one node pool, joined by `couplings`, with the DOFs
    /// `fixed_dofs` (6·node + component) held at zero and the nodal forces
    /// and moments `forces` (6 per node). A model with couplings needs a
    /// solid domain: the coupled solve assembles one.
    ///
    /// The compliance objective and its self-adjoint sensitivity hold only for
    /// homogeneous supports and a design-independent load, so a prescribed
    /// displacement cannot be expressed here.
    ///
    /// # Errors
    /// No elements, couplings without tets, a quadratic or hexahedral solid
    /// domain, no support, no load, malformed forces, or meshes over
    /// different node pools.
    pub fn new(
        solid: Option<TetMesh>,
        shell: Option<ShellMesh>,
        couplings: Vec<Coupling>,
        fixed_dofs: &[u32],
        forces: Vec<f64>,
        solver: MixedSolver,
    ) -> Result<Self, FemError> {
        if !(solver.relative_tolerance.is_finite() && solver.relative_tolerance > 0.0) {
            return Err(topology_error(
                "the CG tolerance must be finite and positive",
            ));
        }
        let node_count = check_domain(solid.as_ref(), shell.as_ref(), &couplings)?;
        check_load_case(node_count, fixed_dofs, &forces)?;

        let mut model = Self {
            solid: None,
            shell: None,
            couplings,
            fixed_dofs: fixed_dofs.to_vec(),
            forces,
            node_count,
            tet_count: 0,
            stiffness: Vec::new(),
            dofs: Vec::new(),
            dof_offsets: vec![0],
            volumes: Vec::new(),
            centroids: Vec::new(),
            solver,
        };
        if let Some(mesh) = solid {
            let domain = model.add_tets(&mesh);
            model.solid = Some((mesh, domain));
        }
        if let Some(mesh) = shell {
            let domain = model.add_facets(&mesh);
            model.shell = Some((mesh, domain));
        }
        Ok(model)
    }

    /// Cache k0, DOFs, volume and centroid of every tet of `mesh`.
    fn add_tets(&mut self, mesh: &TetMesh) -> Domain {
        let neighbours = node_neighbours(mesh);
        let pattern = CsrMatrix::from_node_pattern(&neighbours);
        let mut positions = Vec::new();
        for (tet, nodes) in mesh.tets().iter().enumerate() {
            let corners = mesh.corners(tet);
            self.stiffness
                .extend_from_slice(tet4_stiffness(&corners, mesh.material(tet)).as_flattened());
            self.dofs.extend(nodes.iter().flat_map(|&node| {
                (0..3).map(move |component| DOFS_PER_NODE * node as usize + component)
            }));
            self.dof_offsets.push(self.dofs.len());
            self.volumes.push(signed_volume(&corners).abs());
            self.centroids.push(mean_point(&corners));
            push_positions(&pattern, &neighbours, nodes, &mut positions);
        }
        self.tet_count = mesh.tets().len();
        Domain { pattern, positions }
    }

    /// Cache k0, DOFs, volume and centroid of every facet of `mesh`.
    fn add_facets(&mut self, mesh: &ShellMesh) -> Domain {
        let neighbours = shell_node_neighbours(mesh);
        let pattern = CsrMatrix::from_node_blocks(&neighbours, SHELL_NODE_DOFS);
        let mut positions = Vec::new();
        for (facet, nodes) in mesh.triangles().iter().enumerate() {
            let corners = mesh.corners(facet);
            let thickness = mesh.thickness(facet);
            self.stiffness.extend_from_slice(
                facet_stiffness(&corners, thickness, mesh.material(facet)).as_flattened(),
            );
            self.dofs.extend(nodes.iter().flat_map(|&node| {
                (0..SHELL_NODE_DOFS)
                    .map(move |component| SHELL_NODE_DOFS * node as usize + component)
            }));
            self.dof_offsets.push(self.dofs.len());
            self.volumes.push(triangle_area(&corners) * thickness);
            self.centroids.push(mean_point(&corners));
            for &node_a in nodes {
                let list = &neighbours[node_a as usize];
                for component_a in 0..SHELL_NODE_DOFS {
                    let row_first = pattern
                        .row_range(SHELL_NODE_DOFS * node_a as usize + component_a)
                        .start;
                    for &node_b in nodes {
                        let block = list
                            .binary_search(&node_b)
                            .unwrap_or_else(|_| unreachable!("nodes of one facet are neighbours"));
                        for component_b in 0..SHELL_NODE_DOFS {
                            #[allow(
                                clippy::cast_possible_truncation,
                                reason = "the non-zero count of a shell stiffness fits in u32"
                            )]
                            positions
                                .push((row_first + SHELL_NODE_DOFS * block + component_b) as u32);
                        }
                    }
                }
            }
        }
        Domain { pattern, positions }
    }

    #[must_use]
    pub fn element_count(&self) -> usize {
        self.volumes.len()
    }

    /// Design elements `0..tet_count` are tets.
    #[must_use]
    pub fn tet_count(&self) -> usize {
        self.tet_count
    }

    /// Design elements `tet_count..` are shell facets.
    #[must_use]
    pub fn facet_count(&self) -> usize {
        self.element_count() - self.tet_count
    }

    /// Element measures: tet volume, or facet area × thickness.
    #[must_use]
    pub fn volumes(&self) -> &[f64] {
        &self.volumes
    }

    /// Element centres: the mean of the corners.
    #[must_use]
    pub fn centroids(&self) -> &[[f64; 3]] {
        &self.centroids
    }

    /// Six DOFs per node.
    #[must_use]
    pub fn dof_count(&self) -> usize {
        DOFS_PER_NODE * self.node_count
    }

    fn element_dofs(&self, element: usize) -> &[usize] {
        &self.dofs[self.dof_offsets[element]..self.dof_offsets[element + 1]]
    }

    /// Start of `element`'s k0 in `stiffness`: tets are 12×12, facets 18×18.
    fn stiffness_start(&self, element: usize) -> usize {
        const TET: usize = 12 * 12;
        const FACET: usize = 18 * 18;
        if element < self.tet_count {
            TET * element
        } else {
            TET * self.tet_count + FACET * (element - self.tet_count)
        }
    }

    /// The domain matrix for the element scales `scale` of `range`.
    fn scaled(&self, domain: &Domain, range: std::ops::Range<usize>, scale: &[f64]) -> CsrMatrix {
        let mut matrix = domain.pattern.clone();
        let values = matrix.values_mut();
        let mut position = domain.positions.iter();
        for element in range {
            let width = self.element_dofs(element).len();
            let start = self.stiffness_start(element);
            for &entry in &self.stiffness[start..start + width * width] {
                let at = *position
                    .next()
                    .unwrap_or_else(|| unreachable!("one position per stiffness entry"));
                values[at as usize] += scale[element] * entry;
            }
        }
        matrix
    }

    /// Solve K(ρ)·u = f with u = 0 on the supports; returns all six DOFs per
    /// node and the CG iterations.
    fn solve(&self, scale: &[f64]) -> Result<(Vec<f64>, usize), FemError> {
        let settings = CgSettings {
            relative_tolerance: self.solver.relative_tolerance,
            max_iterations: cg_budget(self.dof_count()),
            stopping: StoppingRule::ResidualNorm,
        };
        let zeros = vec![0.0; self.fixed_dofs.len()];
        let count = self.element_count();
        let shell = self
            .shell
            .as_ref()
            .map(|(mesh, domain)| (mesh, self.scaled(domain, self.tet_count..count, scale)));
        if let Some((mesh, domain)) = &self.solid {
            let solid = self.scaled(domain, 0..self.tet_count, scale);
            let mut prepared = prepare_mixed_static(
                mesh,
                &solid,
                shell
                    .as_ref()
                    .map(|(mesh, stiffness)| ShellPart { mesh, stiffness }),
                &self.couplings,
                &self.fixed_dofs,
                &zeros,
                &self.forces,
                self.solver.preconditioner,
            )?;
            let (reduced, outcome) = solve_pcg_with(
                prepared.prepared.system.as_mut(),
                &prepared.prepared.rhs,
                settings,
            )?;
            Ok((prepared.reduction.expand(&reduced), outcome.iterations))
        } else {
            let (mesh, stiffness) =
                shell.ok_or_else(|| topology_error("the design domain has no elements"))?;
            let mut prepared =
                prepare_shell_static(mesh, &stiffness, &self.fixed_dofs, &zeros, &self.forces)?;
            let (dofs, outcome) = solve_pcg_with(
                prepared.prepared.system.as_mut(),
                &prepared.prepared.rhs,
                settings,
            )?;
            Ok((dofs, outcome.iterations))
        }
    }

    /// Solve K(ρ)·u = f and return the compliance and its element
    /// sensitivities (see [`ComplianceEvaluation`]); the displacements are
    /// the three translations per node.
    ///
    /// # Errors
    /// A density field that does not fit the model, or a failed solve.
    pub fn evaluate_compliance(
        &mut self,
        rho: &[f64],
        penalty: f64,
        emin_rel: f64,
    ) -> Result<ComplianceEvaluation, FemError> {
        let count = self.element_count();
        if rho.len() != count {
            return Err(topology_error(format!(
                "the density field has {} entries, but the design domain has {count} elements",
                rho.len()
            )));
        }
        if let Some(&value) = rho.iter().find(|value| !value.is_finite()) {
            return Err(FemError::NonFinite {
                what: "a design density",
                value,
            });
        }
        let scale: Vec<f64> = rho
            .iter()
            .map(|&density| simp_scale(density, penalty, emin_rel))
            .collect();
        let (dofs, cg_iterations) = self.solve(&scale)?;
        let mut compliance = 0.0;
        let mut dcompliance = Vec::with_capacity(count);
        let mut strain_energy = Vec::with_capacity(count);
        for (element, &density) in rho.iter().enumerate() {
            let element_dofs = self.element_dofs(element);
            let width = element_dofs.len();
            let start = self.stiffness_start(element);
            let stiffness = &self.stiffness[start..start + width * width];
            let energy: f64 = element_dofs
                .iter()
                .enumerate()
                .map(|(row, &row_dof)| {
                    let product: f64 = stiffness[row * width..(row + 1) * width]
                        .iter()
                        .zip(element_dofs)
                        .map(|(entry, &column_dof)| entry * dofs[column_dof])
                        .sum();
                    dofs[row_dof] * product
                })
                .sum();
            strain_energy.push(energy);
            compliance += scale[element] * energy;
            dcompliance.push(-simp_scale_deriv(density, penalty, emin_rel) * energy);
        }
        let displacements = dofs
            .as_chunks::<DOFS_PER_NODE>()
            .0
            .iter()
            .flat_map(|node| [node[0], node[1], node[2]])
            .collect();
        Ok(ComplianceEvaluation {
            compliance,
            dcompliance,
            strain_energy,
            displacements,
            cg_iterations,
        })
    }
}

impl DesignModel for MixedSimpModel {
    fn element_count(&self) -> usize {
        Self::element_count(self)
    }

    fn volumes(&self) -> &[f64] {
        Self::volumes(self)
    }

    fn centroids(&self) -> &[[f64; 3]] {
        Self::centroids(self)
    }

    fn dof_count(&self) -> usize {
        Self::dof_count(self)
    }

    fn evaluate_compliance(
        &mut self,
        rho: &[f64],
        penalty: f64,
        emin_rel: f64,
    ) -> Result<ComplianceEvaluation, FemError> {
        Self::evaluate_compliance(self, rho, penalty, emin_rel)
    }

    fn stress_model(&mut self) -> Option<&mut SimpModel> {
        None
    }
}

/// The node count of a design domain, after checking its meshes and
/// couplings fit together.
fn check_domain(
    solid: Option<&TetMesh>,
    shell: Option<&ShellMesh>,
    couplings: &[Coupling],
) -> Result<usize, FemError> {
    let node_count = match (solid, shell) {
        (None, None) => {
            return Err(topology_error(
                "the design domain has no elements — give shell facets, tets or both",
            ))
        }
        (Some(mesh), _) => mesh.node_count(),
        (None, Some(mesh)) => mesh.vertex_count(),
    };
    if let (Some(mesh), Some(facets)) = (solid, shell) {
        if facets.vertex_count() != mesh.vertex_count() {
            return Err(topology_error(format!(
                "the shell mesh has {} vertices, but the solid mesh {} — both must share \
                 one node pool",
                facets.vertex_count(),
                mesh.vertex_count()
            )));
        }
    }
    if let Some(mesh) = solid {
        if mesh.order() != ElementOrder::Linear {
            return Err(topology_error(
                "SIMP uses linear elements, one design density per element; the solid \
                 mesh is quadratic",
            ));
        }
        if !mesh.hexes().is_empty() {
            return Err(topology_error(
                "the coupled design domain takes tetrahedra only, but the solid mesh has \
                 hexahedra",
            ));
        }
    } else if !couplings.is_empty() {
        return Err(topology_error(format!(
            "this model is all shell elements and declares {} coupling(s), which need the \
             coupled solid-shell assembler, and that needs at least one solid body",
            couplings.len()
        )));
    }
    Ok(node_count)
}

/// Check the supports and the load: at least one support, and a load off
/// the supports.
fn check_load_case(node_count: usize, fixed_dofs: &[u32], forces: &[f64]) -> Result<(), FemError> {
    let dof_count = DOFS_PER_NODE * node_count;
    if forces.len() != dof_count {
        return Err(FemError::ForceLength {
            len: forces.len(),
            count: dof_count,
        });
    }
    if let Some(&value) = forces.iter().find(|value| !value.is_finite()) {
        return Err(FemError::NonFinite {
            what: "a force or moment component",
            value,
        });
    }
    if fixed_dofs.is_empty() {
        return Err(topology_error(
            "topology optimization needs at least one fixed support — the model has no \
             essential boundary conditions, so it is not fully constrained",
        ));
    }
    let mut held = vec![false; dof_count];
    for &dof in fixed_dofs {
        let slot = held.get_mut(dof as usize).ok_or_else(|| {
            topology_error(format!("fixed DOF {dof} is out of range [0, {dof_count})"))
        })?;
        *slot = true;
    }
    if forces
        .iter()
        .zip(&held)
        .all(|(&force, &held)| held || force == 0.0)
    {
        return Err(topology_error(
            "topology optimization needs an applied load — the assembled load vector is \
             zero, so the compliance objective is trivial",
        ));
    }

    Ok(())
}

fn triangle_area(corners: &[[f64; 3]; 3]) -> f64 {
    let first: [f64; 3] = std::array::from_fn(|axis| corners[1][axis] - corners[0][axis]);
    let second: [f64; 3] = std::array::from_fn(|axis| corners[2][axis] - corners[0][axis]);
    let cross = [
        first[1] * second[2] - first[2] * second[1],
        first[2] * second[0] - first[0] * second[2],
        first[0] * second[1] - first[1] * second[0],
    ];
    0.5 * cross.iter().map(|value| value * value).sum::<f64>().sqrt()
}
