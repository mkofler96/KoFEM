// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Large deformation of solids: a compressible Neo-Hookean material in a
//! total-Lagrangian formulation, as a [`NonlinearProblem`] for the Newton
//! driver.
//!
//! The strain energy per undeformed volume is
//!
//! ```text
//! ψ = μ/2·(tr C − 3) − μ·ln J + λ/2·(ln J)²,   C = FᵀF,  J = det F,
//! ```
//!
//! with the Lamé constants (λ, μ) of the element's E and ν, so that under
//! small strains it is the linear-elastic material. Its Cauchy stress is
//! `σ = μ/J·(b − I) + λ/J·ln J·I` with `b = FFᵀ` (Bonet & Wood, Nonlinear
//! Continuum Mechanics for Finite Element Analysis, 2nd ed., §6.4.3).
//!
//! Every quantity is measured from the undeformed mesh: F = I + ∂u/∂X at
//! the integration points of the undeformed elements. The internal force and
//! its tangent are those integrals pushed forward to the deformed state
//! (Bonet & Wood §9.2–9.4), which is the same total-Lagrangian quantity in
//! the form that is cheapest to evaluate:
//!
//! ```text
//! f_a     = ∫ σ·g_a dv
//! K_ab,ik = ∫ ( g_a[j]·c_ijkl·g_b[l] + (g_a·σ·g_b)·δ_ik ) dv
//! ```
//!
//! with `g_a = F⁻ᵀ·∇_X N_a` the spatial shape-function gradients, `dv = J·dV`,
//! and the spatial elasticity tensor `c_ijkl = λ'·δ_ij·δ_kl + μ'·(δ_ik·δ_jl +
//! δ_il·δ_jk)`, `λ' = λ/J`, `μ' = (μ − λ·ln J)/J` — the isotropic form of the
//! linear material with modified constants, so its first term is the linear
//! stiffness integrand. Each element uses the integration rule of its linear
//! stiffness ([`crate::element`]), so at rest the tangent is that stiffness
//! exactly.
//!
//! Loads keep their direction and magnitude as the body deforms (dead loads).

use crate::assembly::{node_neighbours, scatter};
use crate::error::FemError;
use crate::mesh::{cross, determinant, dot, TetMesh};
use crate::nonlinear::NonlinearProblem;
use crate::piece::PiecePoint;
use crate::sparse::CsrMatrix;
use crate::stress::{check_length, corner_count, displacement_gradient, Location};

/// The Neo-Hookean solid on a mesh of tetrahedra and hexahedra of either
/// order, each element with its own material.
pub struct NeoHookean {
    mesh: TetMesh,
    neighbours: Vec<Vec<u32>>,
}

impl NeoHookean {
    #[must_use]
    pub fn new(mesh: &TetMesh) -> Self {
        Self {
            neighbours: node_neighbours(mesh),
            mesh: mesh.clone(),
        }
    }
}

impl NonlinearProblem for NeoHookean {
    fn tangent_pattern(&self) -> CsrMatrix {
        CsrMatrix::from_node_pattern(&self.neighbours)
    }

    fn tangent_varies(&self) -> bool {
        true
    }

    fn internal_force_and_tangent(
        &mut self,
        displacements: &[f64],
        tangent: &mut CsrMatrix,
    ) -> Result<Vec<f64>, FemError> {
        check_length(&self.mesh, displacements)?;
        let dof_count = self.mesh.dof_count();
        if tangent.rows() != dof_count {
            return Err(FemError::NonlinearInput {
                reason: format!(
                    "the tangent has {} rows, but the mesh {dof_count} DOFs",
                    tangent.rows()
                ),
            });
        }
        let mut force = vec![0.0; dof_count];
        for element in 0..self.mesh.element_count() {
            let lame = self.mesh.material(element).lame();
            for piece in self.mesh.pieces(element) {
                let nodal = piece.local_values(displacements, 3);
                let (mut piece_force, mut piece_tangent) =
                    integrate(&piece.stiffness_points(), &nodal, lame, element)?;
                piece.fold_rows(&mut piece_force, 3);
                piece.fold_matrix(&mut piece_tangent);
                scatter(
                    tangent,
                    &self.neighbours,
                    element,
                    piece.nodes,
                    &piece_tangent,
                );
                for (&node, local) in piece.nodes.iter().zip(piece_force.as_chunks::<3>().0) {
                    for axis in 0..3 {
                        force[3 * node as usize + axis] += local[axis];
                    }
                }
            }
        }
        Ok(force)
    }
}

/// One piece's internal force (3 per node) and tangent (row-major over the
/// same DOFs), integrated over `points` — the undeformed shape-function
/// gradients and volume weight of each integration point — from the piece's
/// nodal displacements `nodal` (3 per node).
fn integrate(
    points: &[(PiecePoint, Vec<[f64; 3]>, f64)],
    nodal: &[f64],
    lame: (f64, f64),
    element: usize,
) -> Result<(Vec<f64>, Vec<f64>), FemError> {
    let width = nodal.len();
    let mut force = vec![0.0; width];
    let mut tangent = vec![0.0; width * width];
    for (_, reference, weight) in points {
        let mut gradient = [[0.0; 3]; 3];
        for (motion, shape) in nodal.as_chunks::<3>().0.iter().zip(reference) {
            for (row, entries) in gradient.iter_mut().enumerate() {
                for (col, entry) in entries.iter_mut().enumerate() {
                    *entry += motion[row] * shape[col];
                }
            }
        }
        let state = PointState::new(&gradient, lame, element)?;
        // g_a = F⁻ᵀ·G_a.
        let spatial: Vec<[f64; 3]> = reference
            .iter()
            .map(|shape| {
                std::array::from_fn(|axis| {
                    (0..3)
                        .map(|inner| state.inverse[inner][axis] * shape[inner])
                        .sum()
                })
            })
            .collect();
        let volume = state.jacobian * weight;
        for (node_a, grad_a) in spatial.iter().enumerate() {
            let stressed: [f64; 3] = std::array::from_fn(|row| {
                (0..3).map(|col| state.cauchy[row][col] * grad_a[col]).sum()
            });
            for axis in 0..3 {
                force[3 * node_a + axis] += volume * stressed[axis];
            }
            for (node_b, grad_b) in spatial.iter().enumerate() {
                // The isotropic term with (λ', μ'), then the geometric one.
                let shared = state.mu * dot(*grad_a, *grad_b);
                let geometric: f64 = (0..3).map(|axis| stressed[axis] * grad_b[axis]).sum();
                for row in 0..3 {
                    for col in 0..3 {
                        let diagonal = if row == col { shared + geometric } else { 0.0 };
                        tangent[width * (3 * node_a + row) + 3 * node_b + col] += volume
                            * (state.lambda * grad_a[row] * grad_b[col]
                                + state.mu * grad_a[col] * grad_b[row]
                                + diagonal);
                    }
                }
            }
        }
    }
    Ok((force, tangent))
}

/// The Neo-Hookean state at one point of one element.
struct PointState {
    jacobian: f64,
    inverse: [[f64; 3]; 3],
    cauchy: [[f64; 3]; 3],
    /// λ' and μ' of the spatial elasticity tensor (module documentation).
    lambda: f64,
    mu: f64,
}

impl PointState {
    /// The state at displacement gradient `H = ∂u/∂X`. The strain measures
    /// are formed from H, not from F = I + H: `b − I = H + Hᵀ + H·Hᵀ` and
    /// `J − 1 = I₁ + I₂ + I₃` (the invariants of H), with `ln J` as
    /// `ln_1p(J − 1)`. Subtracting I from F·Fᵀ, or taking ln of J near 1,
    /// would cancel all but the strain's leading digits, and a solve under a
    /// small load could not resolve its residual below that floor.
    fn new(
        displacement_gradient: &[[f64; 3]; 3],
        (lambda, mu): (f64, f64),
        element: usize,
    ) -> Result<Self, FemError> {
        let gradient = displacement_gradient;
        let trace = gradient[0][0] + gradient[1][1] + gradient[2][2];
        let trace_of_square: f64 = (0..3)
            .flat_map(|row| (0..3).map(move |col| (row, col)))
            .map(|(row, col)| gradient[row][col] * gradient[col][row])
            .sum();
        let stretch = trace + 0.5 * (trace * trace - trace_of_square) + determinant(gradient);
        let jacobian = 1.0 + stretch;
        if !(jacobian.is_finite() && jacobian > 0.0) {
            return Err(FemError::InvertedElement { element, jacobian });
        }
        let mut deformation = *gradient;
        for (axis, row) in deformation.iter_mut().enumerate() {
            row[axis] += 1.0;
        }
        // F⁻¹ by cofactors: row k is (col_{k+1} × col_{k+2}) / J, with col_j
        // the columns of F.
        let column = |axis: usize| {
            [
                deformation[0][axis],
                deformation[1][axis],
                deformation[2][axis],
            ]
        };
        let inverse: [[f64; 3]; 3] = std::array::from_fn(|axis| {
            cross(column((axis + 1) % 3), column((axis + 2) % 3)).map(|entry| entry / jacobian)
        });
        let log = stretch.ln_1p();
        let cauchy: [[f64; 3]; 3] = std::array::from_fn(|row| {
            std::array::from_fn(|col| {
                let product: f64 = (0..3)
                    .map(|inner| gradient[row][inner] * gradient[col][inner])
                    .sum();
                let strain = gradient[row][col] + gradient[col][row] + product;
                let spherical = if row == col { lambda * log } else { 0.0 };
                (mu * strain + spherical) / jacobian
            })
        });
        Ok(Self {
            jacobian,
            inverse,
            cauchy,
            lambda: lambda / jacobian,
            mu: (mu - lambda * log) / jacobian,
        })
    }

    /// `[σxx, σyy, σzz, τxy, τyz, τzx]`.
    fn voigt(&self) -> [f64; 6] {
        let sigma = &self.cauchy;
        [
            sigma[0][0],
            sigma[1][1],
            sigma[2][2],
            sigma[0][1],
            sigma[1][2],
            sigma[2][0],
        ]
    }
}

/// The Cauchy stress of `element` at `location`.
fn cauchy_at(
    mesh: &TetMesh,
    element: usize,
    location: Location,
    displacements: &[f64],
) -> Result<[f64; 6], FemError> {
    let gradient = displacement_gradient(mesh, element, location, displacements);
    let state = PointState::new(&gradient, mesh.material(element).lame(), element)?;
    Ok(state.voigt())
}

/// The Cauchy stress of every element (tets first, then hexes) at its
/// centre, in global axes as `[σxx, σyy, σzz, τxy, τyz, τzx]`: the large-
/// deformation counterpart of [`crate::stress_tensors`].
///
/// # Errors
/// [`FemError::DisplacementLength`] when `displacements` is not 3 per node;
/// [`FemError::InvertedElement`] where the displacement turns an element
/// inside out.
pub fn cauchy_stress_tensors(
    mesh: &TetMesh,
    displacements: &[f64],
) -> Result<Vec<[f64; 6]>, FemError> {
    check_length(mesh, displacements)?;
    (0..mesh.element_count())
        .map(|element| cauchy_at(mesh, element, Location::Centre, displacements))
        .collect()
}

/// The Cauchy stress of every element at each of its corner vertices, in its
/// node order, laid out as [`crate::corner_stress_tensors`] lays out the
/// linear stress.
///
/// # Errors
/// As [`cauchy_stress_tensors`].
pub fn cauchy_corner_stress_tensors(
    mesh: &TetMesh,
    displacements: &[f64],
) -> Result<Vec<[f64; 6]>, FemError> {
    check_length(mesh, displacements)?;
    let mut tensors = Vec::new();
    for element in 0..mesh.element_count() {
        for corner in 0..corner_count(mesh, element) {
            tensors.push(cauchy_at(
                mesh,
                element,
                Location::Corner(corner),
                displacements,
            )?);
        }
    }
    Ok(tensors)
}

/// Von Mises stress of the Cauchy stress of every element at its centre.
///
/// # Errors
/// As [`cauchy_stress_tensors`].
pub fn cauchy_von_mises(mesh: &TetMesh, displacements: &[f64]) -> Result<Vec<f64>, FemError> {
    Ok(cauchy_stress_tensors(mesh, displacements)?
        .into_iter()
        .map(|[xx, yy, zz, xy, yz, zx]| {
            (0.5 * ((xx - yy).powi(2) + (yy - zz).powi(2) + (zz - xx).powi(2))
                + 3.0 * (xy * xy + yz * yz + zx * zx))
                .sqrt()
        })
        .collect())
}
