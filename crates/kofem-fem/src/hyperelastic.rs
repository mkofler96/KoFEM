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
use crate::element::{
    add_isotropic_point, cube_rule, degree_two_points, hex27_reference_gradients,
    hex8_reference_gradients, hex_gradients, tet10_gradients, tet4_gradients, HEX27_RULE_POINTS,
    HEX8_RULE_POINTS,
};
use crate::error::FemError;
use crate::mesh::{cross, determinant, ElementOrder, ElementShape, TetMesh};
use crate::nonlinear::NonlinearProblem;
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
            let nodes = self.mesh.element_nodes(element);
            match (self.mesh.shape(element), self.mesh.order()) {
                (ElementShape::Tetrahedron, ElementOrder::Linear) => {
                    let (gradients, volume) = tet4_gradients(&self.mesh.corners(element));
                    let contribution: Contribution<4, 12> = integrate(
                        std::iter::once((gradients, volume)),
                        &self.mesh,
                        element,
                        displacements,
                    )?;
                    contribution.add_to(tangent, &mut force, &self.neighbours, element, nodes);
                }
                (ElementShape::Tetrahedron, ElementOrder::Quadratic) => {
                    let (corner_gradients, volume) = tet4_gradients(&self.mesh.corners(element));
                    let points = degree_two_points()
                        .map(|point| (tet10_gradients(&corner_gradients, point), 0.25 * volume));
                    let contribution: Contribution<10, 30> =
                        integrate(points.into_iter(), &self.mesh, element, displacements)?;
                    contribution.add_to(tangent, &mut force, &self.neighbours, element, nodes);
                }
                (ElementShape::Hexahedron, ElementOrder::Linear) => {
                    let corners = self.mesh.hex_corners(element - self.mesh.tets().len());
                    let points = cube_rule(HEX8_RULE_POINTS)
                        .into_iter()
                        .map(|(point, weight)| {
                            let (gradients, scale) =
                                hex_gradients(&corners, &hex8_reference_gradients(point), point);
                            (gradients, weight * scale)
                        });
                    let contribution: Contribution<8, 24> =
                        integrate(points, &self.mesh, element, displacements)?;
                    contribution.add_to(tangent, &mut force, &self.neighbours, element, nodes);
                }
                (ElementShape::Hexahedron, ElementOrder::Quadratic) => {
                    let corners = self.mesh.hex_corners(element - self.mesh.tets().len());
                    let points = cube_rule(HEX27_RULE_POINTS)
                        .into_iter()
                        .map(|(point, weight)| {
                            let (gradients, scale) =
                                hex_gradients(&corners, &hex27_reference_gradients(point), point);
                            (gradients, weight * scale)
                        });
                    let contribution: Contribution<27, 81> =
                        integrate(points, &self.mesh, element, displacements)?;
                    contribution.add_to(tangent, &mut force, &self.neighbours, element, nodes);
                }
            }
        }
        Ok(force)
    }
}

/// One element's internal force and tangent, `N` nodes and `DOFS` = 3·`N`
/// DOFs ordered (node, component).
struct Contribution<const N: usize, const DOFS: usize> {
    force: [f64; DOFS],
    tangent: Box<[[f64; DOFS]; DOFS]>,
}

impl<const N: usize, const DOFS: usize> Contribution<N, DOFS> {
    fn add_to(
        &self,
        tangent: &mut CsrMatrix,
        force: &mut [f64],
        neighbours: &[Vec<u32>],
        element: usize,
        nodes: &[u32],
    ) {
        scatter(
            tangent,
            neighbours,
            element,
            nodes,
            self.tangent.as_flattened(),
        );
        for (local, &node) in nodes.iter().enumerate() {
            for axis in 0..3 {
                force[3 * node as usize + axis] += self.force[3 * local + axis];
            }
        }
    }
}

/// Integrate one element's force and tangent over `points`: the undeformed
/// shape-function gradients and volume weight of each integration point.
fn integrate<const N: usize, const DOFS: usize>(
    points: impl Iterator<Item = ([[f64; 3]; N], f64)>,
    mesh: &TetMesh,
    element: usize,
    displacements: &[f64],
) -> Result<Contribution<N, DOFS>, FemError> {
    debug_assert_eq!(DOFS, 3 * N);
    let nodes = mesh.element_nodes(element);
    let nodal: [[f64; 3]; N] = std::array::from_fn(|local| {
        let base = 3 * nodes[local] as usize;
        [
            displacements[base],
            displacements[base + 1],
            displacements[base + 2],
        ]
    });
    let lame = mesh.material(element).lame();
    let mut contribution = Contribution {
        force: [0.0; DOFS],
        tangent: Box::new([[0.0; DOFS]; DOFS]),
    };
    for (reference, weight) in points {
        let mut gradient = [[0.0; 3]; 3];
        for (motion, shape) in nodal.iter().zip(&reference) {
            for (row, entries) in gradient.iter_mut().enumerate() {
                for (col, entry) in entries.iter_mut().enumerate() {
                    *entry += motion[row] * shape[col];
                }
            }
        }
        let state = PointState::new(&gradient, lame, element)?;
        // g_a = F⁻ᵀ·G_a.
        let spatial: [[f64; 3]; N] = reference.map(|shape| {
            std::array::from_fn(|axis| {
                (0..3)
                    .map(|inner| state.inverse[inner][axis] * shape[inner])
                    .sum()
            })
        });
        let volume = state.jacobian * weight;
        add_isotropic_point(
            &mut contribution.tangent,
            &spatial,
            volume,
            (state.lambda, state.mu),
        );
        for (node_a, grad_a) in spatial.iter().enumerate() {
            let stressed: [f64; 3] = std::array::from_fn(|row| {
                (0..3).map(|col| state.cauchy[row][col] * grad_a[col]).sum()
            });
            for axis in 0..3 {
                contribution.force[3 * node_a + axis] += volume * stressed[axis];
            }
            for (node_b, grad_b) in spatial.iter().enumerate() {
                let geometric = volume
                    * (0..3)
                        .map(|axis| stressed[axis] * grad_b[axis])
                        .sum::<f64>();
                for axis in 0..3 {
                    contribution.tangent[3 * node_a + axis][3 * node_b + axis] += geometric;
                }
            }
        }
    }
    Ok(contribution)
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
