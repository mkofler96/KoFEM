// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Level-set topology optimization (minimum compliance, solid design domain).
//! Port of the C++ engine's `topology_levelset.cpp`, step for step.
//!
//! The design is a nodal level-set function φ ∈ [−1, 1] (φ > 0 material,
//! φ < 0 void, φ = 0 the boundary), updated with the reaction–diffusion
//! equation of Yamada, Izui, Nishiwaki and Takezawa (2010), "A topology
//! optimization method based on the level set method incorporating a
//! fictitious interface energy", CMAME 199:2876–2891, eq. (19)–(24):
//!
//! ```text
//! ∂φ/∂t = d − λ + τ·∇²φ        (d: normalized sensitivity, λ: volume multiplier)
//! ```
//!
//! discretized semi-implicitly on the linear H1 space of the elastic solve:
//!
//! ```text
//! (M + Δt·τ·L) φⁿ⁺¹ = M φⁿ + Δt·(F − λ·M·1),   then φ ← clamp(φ, −1, 1)
//! ```
//!
//! with M the scalar mass matrix and L the Laplacian. Because L·1 = 0, the λ
//! term shifts φⁿ⁺¹ uniformly, so one linear solve per iteration suffices and
//! λ is found afterwards by bisection on the volume constraint. τ = ℓ² sets
//! the smallest feature scale ℓ, the level-set analogue of SIMP's filter
//! radius.
//!
//! Each element's density is the exact volume fraction of {φ > 0} inside it
//! (hexes are split into six Kuhn tets), and its stiffness is
//! `E_min + ρ_e·(E₀ − E_min)`. The sensitivity is the strain-energy density
//! of that material. The density goes out with φ, so the threshold slider,
//! the convergence plot and live streaming work as for SIMP.

use crate::amg::SymmetricGaussSeidel;
use crate::assembly::node_neighbours;
use crate::cg::{solve_pcg_with, CgSettings, StoppingRule};
use crate::element::{
    cube_rule, hex8_reference_gradients, hex_gradients, tet4_gradients, HEX_CORNERS,
};
use crate::error::FemError;
use crate::mesh::{ElementShape, TetMesh};
use crate::sparse::CsrMatrix;

use super::filter::mean_element_size;
use super::optimize::{HistoryEntry, StepReport};
use super::simp::{simp_scale, SimpModel};
use super::topology_error;

/// The settings of one run; [`LevelSetSettings::default`] holds the engine's
/// defaults.
#[derive(Debug, Clone, PartialEq)]
pub struct LevelSetSettings {
    /// The target `Σρ_e·V_e` / `ΣV_e`, in (0, 1].
    pub volume_fraction: f64,
    /// Regularization length ℓ in model length units, τ = ℓ²: members and
    /// boundary curvature finer than about ℓ diffuse away. ≤ 0 takes the mean
    /// element size. Keep it near the element size: at SIMP's 1.5–3× filter
    /// radii the diffusion erases the thin diagonals of an MBB truss.
    pub regularization_length: f64,
    /// Pseudo-time step of the update. The converged design does not depend
    /// on it; it sets how far φ moves per iteration.
    pub time_step: f64,
    /// Largest reduction of the volume fraction per iteration. The run starts
    /// from full material and walks the target down at this rate.
    pub volume_step: f64,
    pub max_iterations: usize,
    /// Convergence on `max|Δρ_e|` once the volume is met.
    pub tolerance: f64,
    /// Ersatz-material stiffness ratio `E_min/E₀`.
    pub emin_rel: f64,
    /// Elements kept solid and void: their vertices are pinned to φ = +1 / −1.
    pub passive_solid: Vec<usize>,
    pub passive_void: Vec<usize>,
    /// Report the design every this many iterations, and always the last.
    pub stream_every: usize,
}

impl Default for LevelSetSettings {
    fn default() -> Self {
        Self {
            volume_fraction: 0.5,
            regularization_length: 0.0,
            time_step: 0.5,
            volume_step: 0.03,
            max_iterations: 100,
            tolerance: 0.01,
            emin_rel: 1e-3,
            passive_solid: Vec::new(),
            passive_void: Vec::new(),
            stream_every: 1,
        }
    }
}

/// The result of a finished run.
#[derive(Debug, Clone, PartialEq)]
pub struct LevelSetResult {
    /// `ρ_e` = vol{φ > 0 in e}/`V_e`, the design of the last history entry.
    pub density: Vec<f64>,
    /// φ per mesh vertex.
    pub level_set: Vec<f64>,
    /// The solution of the returned design, 3 per node.
    pub displacements: Vec<f64>,
    pub history: Vec<HistoryEntry>,
    pub iterations: usize,
    pub converged: bool,
}

/// Volume fraction of {φ > 0} inside a linear tetrahedron with nodal values
/// `phi`. Exact for linear φ and invariant under the affine map, so it depends
/// on the four nodal values alone.
#[must_use]
pub fn tet_positive_fraction(phi: [f64; 4]) -> f64 {
    let positive: Vec<usize> = (0..4).filter(|&i| phi[i] > 0.0).collect();
    let negative: Vec<usize> = (0..4).filter(|&i| phi[i] <= 0.0).collect();
    match positive.len() {
        0 => 0.0,
        4 => 1.0,
        1 => corner_fraction(positive[0], phi),
        3 => 1.0 - corner_fraction(negative[0], phi),
        _ => {
            // Two vertices on each side: {φ > 0} is a triangular prism with end
            // caps (a, P_ac, P_ad) and (b, P_bc, P_bd), split into three tets.
            let [first, second] = [positive[0], positive[1]];
            let [third, fourth] = [negative[0], negative[1]];
            let a1 = reference_vertex(first);
            let a2 = zero_crossing(first, third, phi);
            let a3 = zero_crossing(first, fourth, phi);
            let b1 = reference_vertex(second);
            let b2 = zero_crossing(second, third, phi);
            let b3 = zero_crossing(second, fourth, phi);
            let fraction =
                abs_det(a1, a2, a3, b3) + abs_det(a1, a2, b2, b3) + abs_det(a1, b1, b2, b3);
            fraction.clamp(0.0, 1.0)
        }
    }
}

/// Vertex i of the reference tetrahedron: the origin, then the unit axes.
fn reference_vertex(index: usize) -> [f64; 3] {
    let mut point = [0.0; 3];
    if index > 0 {
        point[index - 1] = 1.0;
    }
    point
}

/// The point on the edge from vertex `inside` (φ > 0) to vertex `outside`
/// (φ ≤ 0) where the linear interpolant of φ vanishes.
fn zero_crossing(inside: usize, outside: usize, phi: [f64; 4]) -> [f64; 3] {
    let along = phi[inside] / (phi[inside] - phi[outside]);
    let (from, to) = (reference_vertex(inside), reference_vertex(outside));
    std::array::from_fn(|axis| from[axis] + along * (to[axis] - from[axis]))
}

/// |det(p1 − p0, p2 − p0, p3 − p0)|: six times the volume of the tet, so in
/// reference coordinates the fraction of the reference volume.
fn abs_det(p0: [f64; 3], p1: [f64; 3], p2: [f64; 3], p3: [f64; 3]) -> f64 {
    let e1: [f64; 3] = std::array::from_fn(|axis| p1[axis] - p0[axis]);
    let e2: [f64; 3] = std::array::from_fn(|axis| p2[axis] - p0[axis]);
    let e3: [f64; 3] = std::array::from_fn(|axis| p3[axis] - p0[axis]);
    (e1[0] * (e2[1] * e3[2] - e2[2] * e3[1]) - e1[1] * (e2[0] * e3[2] - e2[2] * e3[0])
        + e1[2] * (e2[0] * e3[1] - e2[1] * e3[0]))
        .abs()
}

/// Fraction of a tet cut off at a single vertex `v` whose sign differs from
/// the other three: `Π_j φ_v / (φ_v − φ_j)`.
fn corner_fraction(vertex: usize, phi: [f64; 4]) -> f64 {
    (0..4)
        .filter(|&other| other != vertex)
        .map(|other| phi[vertex] / (phi[vertex] - phi[other]))
        .product()
}

/// Kuhn split of a hexahedron into six tets around its 0–6 diagonal, in
/// CHEXA / MFEM vertex order. Every tet has a sixth of the reference volume.
const KUHN_TETS: [[usize; 4]; 6] = [
    [0, 1, 2, 6],
    [0, 1, 5, 6],
    [0, 4, 5, 6],
    [0, 4, 7, 6],
    [0, 3, 7, 6],
    [0, 3, 2, 6],
];

/// `ρ_e` for every element of `mesh` given nodal φ, one value per vertex. Tets
/// are exact; hexes are split into the six Kuhn tets around the 0–6 diagonal.
///
/// # Errors
/// A level set whose length is not the vertex count.
pub fn level_set_density(mesh: &TetMesh, phi: &[f64]) -> Result<Vec<f64>, FemError> {
    if phi.len() != mesh.vertex_count() {
        return Err(topology_error(format!(
            "the level set has {} values but the mesh has {} vertices",
            phi.len(),
            mesh.vertex_count()
        )));
    }
    Ok(density_of(mesh, phi))
}

fn density_of(mesh: &TetMesh, phi: &[f64]) -> Vec<f64> {
    (0..mesh.element_count())
        .map(|element| {
            let nodes = mesh.element_nodes(element);
            let at = |local: usize| phi[nodes[local] as usize];
            match mesh.shape(element) {
                ElementShape::Tetrahedron => tet_positive_fraction([at(0), at(1), at(2), at(3)]),
                ElementShape::Hexahedron => {
                    KUHN_TETS
                        .iter()
                        .map(|tet| tet_positive_fraction(tet.map(at)))
                        .sum::<f64>()
                        / 6.0
                }
            }
        })
        .collect()
}

/// Vertex state of the design domain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pin {
    Free,
    Solid,
    Void,
}

/// CG budget and tolerance of the reaction–diffusion solve. Its operator is a
/// mass matrix plus a small Laplacian, far better conditioned than elasticity.
const UPDATE_CG_BUDGET: usize = 5000;
const UPDATE_CG_TOLERANCE: f64 = 1e-10;

/// A level-set run in progress.
pub struct LevelSetOptimizer {
    model: SimpModel,
    settings: LevelSetSettings,
    pins: Vec<Pin>,
    volumes: Vec<f64>,
    total_volume: f64,
    regularization_length: f64,
    /// The scalar mass matrix M.
    mass: CsrMatrix,
    /// The update operator M + Δt·τ·L.
    operator: CsrMatrix,
    /// The level set and the design the last step analysed (before the first:
    /// the start; after a finished run: the returned ones).
    phi: Vec<f64>,
    rho: Vec<f64>,
    /// The update the last step computed, applied when the next one starts,
    /// so `density()` between steps is the design the report describes.
    next: Option<(Vec<f64>, Vec<f64>)>,
    displacements: Vec<f64>,
    history: Vec<HistoryEntry>,
    finished: bool,
    converged: bool,
}

impl LevelSetOptimizer {
    /// Check the settings against `model` and set up the run, starting from
    /// full material.
    ///
    /// # Errors
    /// Settings out of range, a vertex pinned both solid and void, or a volume
    /// fraction the pinned regions put out of reach.
    pub fn new(model: SimpModel, settings: &LevelSetSettings) -> Result<Self, FemError> {
        let settings = settings.clone();
        check_settings(&settings)?;
        let mesh = model.mesh();
        let count = mesh.element_count();
        let mut pins = vec![Pin::Free; mesh.vertex_count()];
        for (list, pin, which) in [
            (&settings.passive_solid, Pin::Solid, "solid"),
            (&settings.passive_void, Pin::Void, "void"),
        ] {
            for &element in list {
                if element >= count {
                    return Err(topology_error(format!(
                        "passive {which} element index {element} is out of range [0, {count})"
                    )));
                }
                for &vertex in mesh.element_nodes(element) {
                    let slot = &mut pins[vertex as usize];
                    if *slot != Pin::Free && *slot != pin {
                        return Err(topology_error(format!(
                            "vertex {vertex} belongs to both a passive-solid and a passive-void \
                             element — the level set cannot be +1 and −1 there"
                        )));
                    }
                    *slot = pin;
                }
            }
        }
        // A vertex no element uses carries no material.
        for (vertex, pin) in pins.iter_mut().enumerate() {
            if !mesh.is_used(vertex) {
                *pin = Pin::Void;
            }
        }

        let volumes = model.volumes().to_vec();
        let total_volume: f64 = volumes.iter().sum();
        if total_volume.is_nan() || total_volume <= 0.0 {
            return Err(topology_error("the mesh has no volume"));
        }
        let mut optimizer = Self {
            pins,
            total_volume,
            regularization_length: 0.0,
            mass: CsrMatrix::from_node_blocks(&[], 1),
            operator: CsrMatrix::from_node_blocks(&[], 1),
            phi: Vec::new(),
            rho: Vec::new(),
            next: None,
            displacements: Vec::new(),
            history: Vec::new(),
            finished: false,
            converged: false,
            volumes,
            settings,
            model,
        };

        // The reachable range with the pins applied: every free vertex at −1
        // (the emptiest design) to every free vertex at +1 (the fullest).
        let least = optimizer.extreme_fraction(-1.0);
        let most = optimizer.extreme_fraction(1.0);
        let target = optimizer.settings.volume_fraction;
        if target < least - 1e-9 || target > most + 1e-9 {
            return Err(topology_error(format!(
                "volume fraction {target} is infeasible — with the passive solid/void regions \
                 the design can only reach volume fractions in [{least}, {most}]"
            )));
        }

        optimizer.regularization_length = if optimizer.settings.regularization_length > 0.0 {
            optimizer.settings.regularization_length
        } else {
            mean_element_size(&optimizer.volumes)?
        };
        let tau = optimizer.regularization_length.powi(2);
        let (mass, operator) =
            scalar_operators(optimizer.model.mesh(), optimizer.settings.time_step * tau);
        optimizer.mass = mass;
        optimizer.operator = operator;

        let mut phi = vec![1.0; optimizer.pins.len()];
        optimizer.apply_pins(&mut phi);
        optimizer.rho = density_of(optimizer.model.mesh(), &phi);
        optimizer.phi = phi;
        Ok(optimizer)
    }

    fn apply_pins(&self, phi: &mut [f64]) {
        for (value, pin) in phi.iter_mut().zip(&self.pins) {
            match pin {
                Pin::Free => {}
                Pin::Solid => *value = 1.0,
                Pin::Void => *value = -1.0,
            }
        }
    }

    fn fraction_of(&self, rho: &[f64]) -> f64 {
        rho.iter()
            .zip(&self.volumes)
            .map(|(density, volume)| density * volume)
            .sum::<f64>()
            / self.total_volume
    }

    fn extreme_fraction(&self, free_value: f64) -> f64 {
        let mut phi = vec![free_value; self.pins.len()];
        self.apply_pins(&mut phi);
        self.fraction_of(&density_of(self.model.mesh(), &phi))
    }

    /// Analyse the current design and take one reaction–diffusion step.
    ///
    /// # Errors
    /// The run has finished, a solve fails, or the load does no work.
    #[allow(
        clippy::too_many_lines,
        reason = "the four stages of one C++ iteration, kept in their order"
    )]
    pub fn step(&mut self) -> Result<StepReport, FemError> {
        if self.finished {
            return Err(topology_error("the optimization has already finished"));
        }
        if let Some((phi, rho)) = self.next.take() {
            self.phi = phi;
            self.rho = rho;
        }
        let settings = self.settings.clone();
        let iteration = self.history.len() + 1;

        // (1) Ersatz-material solve: SIMP with p = 1 on the volume fraction.
        let evaluation = self
            .model
            .evaluate_compliance(&self.rho, 1.0, settings.emin_rel)?;
        let volume = self.fraction_of(&self.rho);

        // (2) Sensitivity: the strain-energy density of the current material,
        // normalized by its volume-weighted mean so d − λ is O(1).
        let energy: Vec<f64> = self
            .rho
            .iter()
            .zip(&evaluation.strain_energy)
            .map(|(&density, &strain)| simp_scale(density, 1.0, settings.emin_rel) * strain)
            .collect();
        let mean_density = energy.iter().sum::<f64>() / self.total_volume;
        if mean_density.is_nan() || mean_density <= 0.0 {
            return Err(topology_error(
                "the strain energy is zero everywhere — the load does no work on the structure",
            ));
        }
        let mesh = self.model.mesh();
        let mut forcing = vec![0.0; self.phi.len()];
        for (element, &element_energy) in energy.iter().enumerate() {
            let nodes = mesh.element_nodes(element);
            #[allow(
                clippy::cast_precision_loss,
                reason = "4 or 8 nodes, exactly representable"
            )]
            let share = element_energy / mean_density / nodes.len() as f64;
            for &node in nodes {
                forcing[node as usize] += share;
            }
        }

        // (3) The step without the multiplier: A ψ = M φ + Δt·F.
        let mut rhs = vec![0.0; self.phi.len()];
        self.mass.mul_vec(&self.phi, &mut rhs);
        for (value, force) in rhs.iter_mut().zip(&forcing) {
            *value += settings.time_step * force;
        }
        let (psi, _) = solve_pcg_with(
            &mut SymmetricGaussSeidel::new(self.operator.clone()),
            &rhs,
            CgSettings {
                relative_tolerance: UPDATE_CG_TOLERANCE,
                max_iterations: UPDATE_CG_BUDGET,
                stopping: StoppingRule::PreconditionedNorm,
            },
        )?;

        // (4) λ: since A·1 = M·1, the multiplier shifts ψ uniformly by
        // μ = Δt·λ. Bisect μ so the clamped update meets this iteration's
        // volume target.
        let target = settings.volume_fraction.max(volume - settings.volume_step);
        let trial = |mu: f64| {
            let mut phi: Vec<f64> = psi
                .iter()
                .map(|&value| (value - mu).clamp(-1.0, 1.0))
                .collect();
            self.apply_pins(&mut phi);
            let rho = density_of(mesh, &phi);
            let fraction = self.fraction_of(&rho);
            (phi, rho, fraction)
        };
        let (low_psi, high_psi) = psi
            .iter()
            .fold((f64::INFINITY, f64::NEG_INFINITY), |(low, high), &value| {
                (low.min(value), high.max(value))
            });
        let mut low = low_psi - 1.0; // every vertex clamps to +1: full material
        let mut high = high_psi + 1.0; // every vertex clamps to −1: empty
        for _ in 0..60 {
            if high - low <= 1e-12 {
                break;
            }
            let mid = f64::midpoint(low, high);
            let fraction = trial(mid).2;
            if (fraction - target).abs() < 1e-6 {
                low = mid;
                high = mid;
                break;
            }
            if fraction > target {
                low = mid;
            } else {
                high = mid;
            }
        }
        let (phi_next, rho_next, _) = trial(f64::midpoint(low, high));

        let max_change = rho_next
            .iter()
            .zip(&self.rho)
            .map(|(next, current)| (next - current).abs())
            .fold(0.0, f64::max);
        let compliance = evaluation.compliance;
        let entry = HistoryEntry {
            iteration,
            compliance,
            volume,
            max_change,
            stress: None,
            max_stress: None,
        };
        self.history.push(entry);
        self.displacements = evaluation.displacements;

        // Converged once the analysed design meets the volume target and
        // either the densities stop moving or the compliance has flattened out
        // over the last five iterations.
        let volume_met = (volume - settings.volume_fraction).abs() < 5e-3;
        let flat = self.history.len() >= 6 && {
            let recent = &self.history[self.history.len() - 6..];
            let (low, high) = recent
                .iter()
                .fold((compliance, compliance), |(low, high), entry| {
                    (low.min(entry.compliance), high.max(entry.compliance))
                });
            high - low < 0.1 * settings.tolerance * compliance
        };
        let converged = volume_met && (max_change < settings.tolerance || flat);
        let finished = converged || iteration >= settings.max_iterations;
        let stream = finished || iteration.is_multiple_of(settings.stream_every);
        if finished {
            self.finished = true;
            self.converged = converged;
        } else {
            self.next = Some((phi_next, rho_next));
        }
        Ok(StepReport {
            entry,
            finished,
            converged,
            stream,
            density_iteration: iteration,
            note: None,
        })
    }

    /// The design the last step analysed; once finished, the returned one.
    #[must_use]
    pub fn density(&self) -> &[f64] {
        &self.rho
    }

    /// φ per vertex of the design in [`LevelSetOptimizer::density`].
    #[must_use]
    pub fn level_set(&self) -> &[f64] {
        &self.phi
    }

    #[must_use]
    pub fn history(&self) -> &[HistoryEntry] {
        &self.history
    }

    #[must_use]
    pub fn element_count(&self) -> usize {
        self.volumes.len()
    }

    #[must_use]
    pub fn dof_count(&self) -> usize {
        self.model.mesh().dof_count()
    }

    /// ℓ in use (the mean element size when the settings name none).
    #[must_use]
    pub fn regularization_length(&self) -> f64 {
        self.regularization_length
    }

    #[must_use]
    pub fn settings(&self) -> &LevelSetSettings {
        &self.settings
    }

    #[must_use]
    pub fn into_result(self) -> LevelSetResult {
        LevelSetResult {
            iterations: self.history.len(),
            density: self.rho,
            level_set: self.phi,
            displacements: self.displacements,
            history: self.history,
            converged: self.converged,
        }
    }
}

fn check_settings(settings: &LevelSetSettings) -> Result<(), FemError> {
    let positive = |value: f64| value.is_finite() && value > 0.0;
    if !(settings.volume_fraction > 0.0 && settings.volume_fraction <= 1.0) {
        return Err(topology_error(format!(
            "the volume fraction must be in (0, 1], got {}",
            settings.volume_fraction
        )));
    }
    if !settings.regularization_length.is_finite() {
        return Err(topology_error("the regularization length must be finite"));
    }
    if !positive(settings.time_step) {
        return Err(topology_error("the time step must be finite and positive"));
    }
    if !(positive(settings.volume_step) && settings.volume_step <= 1.0) {
        return Err(topology_error("the volume step must be in (0, 1]"));
    }
    if settings.max_iterations == 0 {
        return Err(topology_error("maxIterations must be a positive integer"));
    }
    if !positive(settings.tolerance) {
        return Err(topology_error("the tolerance must be finite and positive"));
    }
    if !(positive(settings.emin_rel) && settings.emin_rel < 1.0) {
        return Err(topology_error(
            "the stiffness floor emin_rel must be in (0, 1)",
        ));
    }
    if settings.stream_every == 0 {
        return Err(topology_error("streamEvery must be a positive integer"));
    }
    Ok(())
}

/// The scalar mass matrix M and the update operator M + `diffusion`·L on the
/// linear H1 space of `mesh`, one row per vertex. A vertex no element uses
/// gets an identity row in both, so it keeps its value.
fn scalar_operators(mesh: &TetMesh, diffusion: f64) -> (CsrMatrix, CsrMatrix) {
    let neighbours = node_neighbours(mesh);
    let mut mass = CsrMatrix::from_node_blocks(&neighbours, 1);
    let mut laplacian = mass.clone();
    let tet_count = mesh.tets().len();
    let rule = cube_rule(3);
    for element in 0..mesh.element_count() {
        let nodes = mesh.element_nodes(element);
        let (element_mass, element_laplacian) = match mesh.shape(element) {
            ElementShape::Tetrahedron => tet_matrices(&mesh.corners(element)),
            ElementShape::Hexahedron => hex_matrices(&mesh.hex_corners(element - tet_count), &rule),
        };
        let width = nodes.len();
        for (row, &row_node) in nodes.iter().enumerate() {
            for (column, &column_node) in nodes.iter().enumerate() {
                let position = mass
                    .find(row_node as usize, column_node as usize)
                    .unwrap_or_else(|| unreachable!("nodes of one element are neighbours"));
                mass.values_mut()[position] += element_mass[row * width + column];
                laplacian.values_mut()[position] += element_laplacian[row * width + column];
            }
        }
    }
    for vertex in (0..mesh.vertex_count()).filter(|&vertex| !mesh.is_used(vertex)) {
        let position = mass.diagonal_position(vertex);
        mass.values_mut()[position] = 1.0;
    }
    let mut operator = mass.clone();
    for (value, &diffusive) in operator.values_mut().iter_mut().zip(laplacian.values()) {
        *value += diffusion * diffusive;
    }
    (mass, operator)
}

/// Consistent mass `V/20·(1 + δ_ij)` and Laplacian `V·∇N_i·∇N_j` of a linear
/// tet, row-major.
fn tet_matrices(corners: &[[f64; 3]; 4]) -> (Vec<f64>, Vec<f64>) {
    let (gradients, volume) = tet4_gradients(corners);
    let mut mass = vec![0.0; 16];
    let mut laplacian = vec![0.0; 16];
    for i in 0..4 {
        for j in 0..4 {
            mass[4 * i + j] = volume / 20.0 * if i == j { 2.0 } else { 1.0 };
            laplacian[4 * i + j] = volume * dot(gradients[i], gradients[j]);
        }
    }
    (mass, laplacian)
}

/// Mass and Laplacian of a trilinear hex by tensor Gauss quadrature, row-major.
fn hex_matrices(corners: &[[f64; 3]; 8], rule: &[([f64; 3], f64)]) -> (Vec<f64>, Vec<f64>) {
    let mut mass = vec![0.0; 64];
    let mut laplacian = vec![0.0; 64];
    for &(point, weight) in rule {
        let (gradients, det) = hex_gradients(corners, &hex8_reference_gradients(point), point);
        let measure = weight * det.abs();
        let values: [f64; 8] = std::array::from_fn(|node| {
            (0..3)
                .map(|axis| {
                    if HEX_CORNERS[node][axis] == 0 {
                        1.0 - point[axis]
                    } else {
                        point[axis]
                    }
                })
                .product()
        });
        for i in 0..8 {
            for j in 0..8 {
                mass[8 * i + j] += measure * values[i] * values[j];
                laplacian[8 * i + j] += measure * dot(gradients[i], gradients[j]);
            }
        }
    }
    (mass, laplacian)
}

fn dot(lhs: [f64; 3], rhs: [f64; 3]) -> f64 {
    lhs[0] * rhs[0] + lhs[1] * rhs[1] + lhs[2] * rhs[2]
}

/// Run a whole level-set optimization of `model`, handing the design to
/// `on_density` as [`LevelSetSettings::stream_every`] asks.
///
/// # Errors
/// As [`LevelSetOptimizer::new`] and [`LevelSetOptimizer::step`].
pub fn optimize_level_set(
    model: SimpModel,
    settings: &LevelSetSettings,
    mut on_density: impl FnMut(usize, &[f64]),
) -> Result<LevelSetResult, FemError> {
    let mut optimizer = LevelSetOptimizer::new(model, settings)?;
    loop {
        let report = optimizer.step()?;
        if report.stream {
            on_density(report.density_iteration, optimizer.density());
        }
        if report.finished {
            return Ok(optimizer.into_result());
        }
    }
}
