// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Stress-constrained SIMP: the relaxed element von Mises stress, its
//! aggregation into one differentiable constraint, and the adjoint
//! sensitivity of that aggregate. Port of the C++ engine's
//! `topology_stress.cpp`.
//!
//! 1. Singularity: qp-relaxation (Bruggi 2008) divides the SIMP stress by ρ^q,
//!    0 ≤ q < p, so `σ̃_e = ρ_e^(p−q)·σ_vm(D·B_e·u_e)` — ρ^½ for p = 3,
//!    q = 2.5 (Le et al. 2010, "Stress-based topology optimization for
//!    continua", SMO 41:605–620, eq. 11).
//! 2. Many local constraints: one aggregate over `s_e = σ̃_e/σ_allow`, the
//!    P-norm `(Σ s_e^P)^(1/P)` or KS `(1/P)·ln Σ exp(P·s_e)`; the loop scales it
//!    by the lagged adaptive normalization of Le et al. (eq. 17).
//! 3. Non-self-adjoint sensitivities: `K(ρ)·λ = ∂g/∂u`, then
//!    `dg/dρ_e = ∂g/∂ρ_e − s'(ρ_e)·λ_eᵀ·k0_e·u_e`.
//!
//! The stress is sampled once per element at its centre, as the static
//! result's von Mises is.

use crate::element::{hex8_reference_gradients, hex_gradients, tet4_gradients, HEX_CENTRE};
use crate::error::FemError;
use crate::mesh::{ElementShape, TetMesh};

use super::simp::{simp_scale_deriv, SimpModel};
use super::topology_error;

/// Voigt components: xx, yy, zz, yz, xz, xy.
const VOIGT: usize = 6;

/// How the relaxed element stresses are aggregated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Aggregation {
    /// (Σ `s_e^P`)^(1/P).
    PNorm,
    /// Kreisselmeier–Steinhauser, `(1/P)·ln Σ exp(P·s_e)`.
    Ks,
}

/// A maximum von Mises stress constraint.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StressConstraint {
    /// `σ_allow`, > 0, in the model's stress units.
    pub limit: f64,
    pub aggregation: Aggregation,
    /// P: the P-norm exponent (typically 6–12) or the KS parameter (20–60 on
    /// `σ/σ_allow` ≈ 1). Larger tracks the max more tightly but is less smooth.
    pub parameter: f64,
    /// The qp-relaxation exponent q, 0 ≤ q < p.
    pub relaxation: f64,
    /// Weight α ∈ (0, 1] of the newest ratio in the adaptive normalization.
    pub alpha: f64,
}

impl StressConstraint {
    /// A P-norm (P = 8) limit with q = 2.5 and α = ½, the C++ engine's
    /// defaults at p = 3.
    #[must_use]
    pub fn new(limit: f64) -> Self {
        Self {
            limit,
            aggregation: Aggregation::PNorm,
            parameter: 8.0,
            relaxation: 2.5,
            alpha: 0.5,
        }
    }
}

/// The full-material stress operators `S_e` = `D_e·B_e` at every element's
/// centre: `σ_e` = `S_e·u_e`, 6 × (3·nodes) row-major, concatenated.
pub(super) struct StressOperators {
    operators: Vec<f64>,
    offsets: Vec<usize>,
}

impl StressOperators {
    pub(super) fn new(mesh: &TetMesh) -> Self {
        let mut operators = Vec::new();
        let mut offsets = Vec::with_capacity(mesh.element_count() + 1);
        let tet_count = mesh.tets().len();
        for element in 0..mesh.element_count() {
            offsets.push(operators.len());
            let gradients: Vec<[f64; 3]> = match mesh.shape(element) {
                ElementShape::Tetrahedron => tet4_gradients(&mesh.corners(element)).0.to_vec(),
                ElementShape::Hexahedron => {
                    let corners = mesh.hex_corners(element - tet_count);
                    let reference = hex8_reference_gradients(HEX_CENTRE);
                    hex_gradients(&corners, &reference, HEX_CENTRE).0.to_vec()
                }
            };
            let (lambda, mu) = mesh.material(element).lame();
            let width = 3 * gradients.len();
            let mut strain = vec![0.0; VOIGT * width];
            for (node, gradient) in gradients.iter().enumerate() {
                let [dx, dy, dz] = *gradient;
                let (ux, uy, uz) = (3 * node, 3 * node + 1, 3 * node + 2);
                strain[ux] = dx;
                strain[width + uy] = dy;
                strain[2 * width + uz] = dz;
                strain[3 * width + uy] = dz;
                strain[3 * width + uz] = dy;
                strain[4 * width + ux] = dz;
                strain[4 * width + uz] = dx;
                strain[5 * width + ux] = dy;
                strain[5 * width + uy] = dx;
            }
            // D in Voigt form with engineering shear strains.
            for row in 0..VOIGT {
                for col in 0..width {
                    let value = if row < 3 {
                        (0..3)
                            .map(|normal| {
                                let modulus = if normal == row {
                                    lambda + 2.0 * mu
                                } else {
                                    lambda
                                };
                                modulus * strain[normal * width + col]
                            })
                            .sum()
                    } else {
                        mu * strain[row * width + col]
                    };
                    operators.push(value);
                }
            }
        }
        offsets.push(operators.len());
        Self { operators, offsets }
    }

    fn operator(&self, element: usize) -> &[f64] {
        &self.operators[self.offsets[element]..self.offsets[element + 1]]
    }
}

/// Von Mises of a Voigt stress, `σ_vm²` = σᵀ·V·σ (V: 1 on the normal diagonal,
/// −½ off it, 3 on the shears), and ∂`σ_vm/∂σ` = `V·σ/σ_vm` (0 at `σ_vm` = 0).
fn von_mises(stress: &[f64; VOIGT]) -> (f64, [f64; VOIGT]) {
    let weighted = [
        stress[0] - f64::midpoint(stress[1], stress[2]),
        stress[1] - f64::midpoint(stress[0], stress[2]),
        stress[2] - f64::midpoint(stress[0], stress[1]),
        3.0 * stress[3],
        3.0 * stress[4],
        3.0 * stress[5],
    ];
    let squared: f64 = stress
        .iter()
        .zip(&weighted)
        .map(|(lhs, rhs)| lhs * rhs)
        .sum();
    let value = squared.max(0.0).sqrt();
    let gradient = if value > 0.0 {
        weighted.map(|component| component / value)
    } else {
        [0.0; VOIGT]
    };
    (value, gradient)
}

/// The aggregate g of the included `ratio`s (`s_e`, whose max is `largest`)
/// and its partials `w_e = ∂g/∂s_e`, both shifted by the max for stability.
fn aggregate(
    ratio: &[f64],
    largest: f64,
    stress: &StressConstraint,
    included: impl Fn(usize) -> bool,
) -> (f64, Vec<f64>) {
    let parameter = stress.parameter;
    let elements = || (0..ratio.len()).filter(|&element| included(element));
    let mut weight = vec![0.0; ratio.len()];
    match stress.aggregation {
        Aggregation::PNorm => {
            // All-zero stress: g = 0, and for P > 1 every partial is 0 too.
            if largest <= 0.0 {
                return (0.0, weight);
            }
            let sum: f64 = elements()
                .map(|element| (ratio[element] / largest).powf(parameter))
                .sum();
            let value = largest * sum.powf(1.0 / parameter);
            for element in elements() {
                weight[element] = (ratio[element] / value).powf(parameter - 1.0);
            }
            (value, weight)
        }
        Aggregation::Ks => {
            let sum: f64 = elements()
                .map(|element| (parameter * (ratio[element] - largest)).exp())
                .sum();
            for element in elements() {
                weight[element] = (parameter * (ratio[element] - largest)).exp() / sum;
            }
            (largest + sum.ln() / parameter, weight)
        }
    }
}

/// One evaluation of the aggregated stress at a solved design.
#[derive(Debug, Clone)]
pub struct StressEvaluation {
    /// `σ̃_e` per element (0 if excluded).
    pub relaxed: Vec<f64>,
    /// max `σ̃_e` over the included elements, and where.
    pub max_relaxed: f64,
    pub argmax: usize,
    /// g over `s_e` = `σ̃_e/σ_allow` (raw, dimensionless).
    pub aggregate: f64,
    /// `dg/dρ_e`, explicit plus adjoint.
    pub daggregate: Vec<f64>,
    pub adjoint_cg_iterations: usize,
}

impl SimpModel {
    fn check_stress_inputs(
        &self,
        rho: &[f64],
        displacements: &[f64],
        exponent: f64,
        stress: &StressConstraint,
        excluded: Option<&[bool]>,
    ) -> Result<(), FemError> {
        let count = self.element_count();
        if rho.len() != count {
            return Err(topology_error(format!(
                "the density field has {} entries, but the mesh has {count} elements",
                rho.len()
            )));
        }
        if displacements.len() != self.mesh().dof_count() {
            return Err(FemError::DisplacementLength {
                len: displacements.len(),
                count: self.mesh().dof_count(),
            });
        }
        if excluded.is_some_and(|flags| flags.len() != count) {
            return Err(topology_error(
                "the stress exclusion mask does not fit the mesh",
            ));
        }
        if !(exponent > 0.0 && exponent.is_finite()) {
            return Err(topology_error(
                "the relaxation exponent p − q must be positive",
            ));
        }
        if !(stress.limit > 0.0 && stress.parameter > 0.0) {
            return Err(topology_error(
                "the stress limit and the aggregation parameter must be positive",
            ));
        }
        Ok(())
    }

    /// The aggregate g and dg/dρ at the design `rho` whose state
    /// `displacements` (3 per node, from [`SimpModel::evaluate_compliance`] at
    /// the same ρ) is given. `exponent` is the relaxation exponent p − q (> 0).
    /// Elements flagged in `excluded` (the passive void) carry no stress. Runs
    /// one adjoint solve.
    ///
    /// # Errors
    /// Arrays that do not fit the model, invalid limits, a zero density with
    /// exponent < 1, every element excluded, or a failed adjoint solve.
    #[allow(
        clippy::too_many_arguments,
        reason = "mirrors the SIMP state: design, solution, penalty, floor, relaxation, \
                  constraint and exclusion are all independent inputs"
    )]
    pub fn evaluate_stress(
        &mut self,
        rho: &[f64],
        displacements: &[f64],
        penalty: f64,
        emin_rel: f64,
        exponent: f64,
        stress: &StressConstraint,
        excluded: Option<&[bool]>,
    ) -> Result<StressEvaluation, FemError> {
        let count = self.element_count();
        self.check_stress_inputs(rho, displacements, exponent, stress, excluded)?;
        let included = |element: usize| excluded.is_none_or(|flags| !flags[element]);
        let operators = self
            .stress_operators
            .get_or_insert_with(|| StressOperators::new(&self.mesh));

        let mut relaxed = vec![0.0; count];
        let mut ratio = vec![0.0; count];
        let mut solid = vec![0.0; count];
        let mut dvm_du: Vec<Vec<f64>> = vec![Vec::new(); count];
        let mut argmax = None;
        let mut max_relaxed = 0.0;
        let mut largest = 0.0_f64;
        for element in (0..count).filter(|&element| included(element)) {
            if exponent < 1.0 && rho[element] <= 0.0 {
                return Err(topology_error(format!(
                    "element {element} has density {} — the relaxed stress needs ρ > 0 (set \
                     rho_min > 0)",
                    rho[element]
                )));
            }
            let dofs: Vec<usize> = self
                .mesh
                .element_nodes(element)
                .iter()
                .flat_map(|&node| (0..3).map(move |component| 3 * node as usize + component))
                .collect();
            let operator = operators.operator(element);
            let width = dofs.len();
            let mut sigma = [0.0; VOIGT];
            for (row, value) in sigma.iter_mut().enumerate() {
                *value = operator[row * width..(row + 1) * width]
                    .iter()
                    .zip(&dofs)
                    .map(|(entry, &dof)| entry * displacements[dof])
                    .sum();
            }
            let (vm, gradient) = von_mises(&sigma);
            solid[element] = vm;
            dvm_du[element] = (0..width)
                .map(|col| {
                    (0..VOIGT)
                        .map(|row| operator[row * width + col] * gradient[row])
                        .sum()
                })
                .collect();
            relaxed[element] = rho[element].powf(exponent) * vm;
            ratio[element] = relaxed[element] / stress.limit;
            if argmax.is_none() || relaxed[element] > max_relaxed {
                max_relaxed = relaxed[element];
                argmax = Some(element);
            }
            largest = largest.max(ratio[element]);
        }
        let argmax = argmax.ok_or_else(|| {
            topology_error("every element is excluded from the stress constraint")
        })?;

        // The aggregate and its partials w_e = ∂g/∂s_e.
        let (aggregate, weight) = aggregate(&ratio, largest, stress, included);

        // Explicit term, and the adjoint load ∂g/∂u.
        let mut daggregate = vec![0.0; count];
        let mut adjoint_load = vec![0.0; self.mesh.dof_count()];
        for element in (0..count).filter(|&element| included(element) && weight[element] != 0.0) {
            daggregate[element] =
                weight[element] * exponent * rho[element].powf(exponent - 1.0) * solid[element]
                    / stress.limit;
            let factor = weight[element] * rho[element].powf(exponent) / stress.limit;
            for (local, dof) in self.element_dofs(element).enumerate() {
                adjoint_load[dof] += factor * dvm_du[element][local];
            }
        }

        let (adjoint, adjoint_cg_iterations) = self.solve(&adjoint_load, rho, penalty, emin_rel)?;
        for (element, value) in daggregate.iter_mut().enumerate() {
            *value -= simp_scale_deriv(rho[element], penalty, emin_rel)
                * self.element_product(element, &adjoint, displacements);
        }
        Ok(StressEvaluation {
            relaxed,
            max_relaxed,
            argmax,
            aggregate,
            daggregate,
            adjoint_cg_iterations,
        })
    }
}
