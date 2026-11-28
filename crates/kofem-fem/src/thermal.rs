// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Thermal loads on solid meshes. A temperature change ΔT in a material with
//! expansion coefficient α imposes the free thermal strain
//! `ε_th = α·ΔT·[1, 1, 1, 0, 0, 0]`. The stress is `σ = D·(ε − ε_th)`, so the
//! weak form gains the equivalent nodal forces
//!
//! ```text
//! f_a = ∫ B_aᵀ·D·ε_th dV = ∫ (3λ + 2μ)·α·ΔT · ∇N_a dV
//! ```
//!
//! (`D·ε_th` is the isotropic stress (3λ + 2μ)·α·ΔT·I, and Bᵀ of an isotropic
//! stress s·I is s·∇N). ΔT is interpolated from its nodal values with the
//! element's own shape functions and integrated with the element's stiffness
//! rule, so a displacement field the element reproduces exactly (free
//! expansion, u = α·ΔT·x) satisfies K·u = f exactly, element by element.
//!
//! `α` is given per element (1/°C, or 1/K: only differences count) and ΔT per
//! node (every node of the mesh, including the edge, face and centre nodes a
//! quadratic mesh adds), relative to the stress-free reference temperature.
//! The forces add to the mechanical load vector; stress recovery subtracts
//! [`thermal_strain_at_centre`] from the diagonal of the strain.

use crate::element::{degree_three_points, CENTROID};
use crate::error::FemError;
use crate::mesh::{ElementOrder, TetMesh};
use crate::piece::{centre_samples, PieceGeometry, PiecePoint, PieceRef};

/// Check one α per element and one ΔT per node, all finite.
fn check_input(mesh: &TetMesh, alpha: &[f64], delta_t: &[f64]) -> Result<(), FemError> {
    check_lengths(mesh, alpha, delta_t)?;
    check_finite(alpha.iter(), delta_t.iter())
}

fn check_lengths(mesh: &TetMesh, alpha: &[f64], delta_t: &[f64]) -> Result<(), FemError> {
    if alpha.len() != mesh.element_count() {
        return Err(FemError::ExpansionCoefficientCount {
            count: alpha.len(),
            elements: mesh.element_count(),
        });
    }
    if delta_t.len() != mesh.node_count() {
        return Err(FemError::TemperatureCount {
            count: delta_t.len(),
            nodes: mesh.node_count(),
        });
    }
    Ok(())
}

fn check_finite<'a>(
    mut alpha: impl Iterator<Item = &'a f64>,
    mut delta_t: impl Iterator<Item = &'a f64>,
) -> Result<(), FemError> {
    if let Some(&value) = alpha.find(|value| !value.is_finite()) {
        return Err(FemError::NonFinite {
            what: "a thermal expansion coefficient",
            value,
        });
    }
    if let Some(&value) = delta_t.find(|value| !value.is_finite()) {
        return Err(FemError::NonFinite {
            what: "a temperature change",
            value,
        });
    }
    Ok(())
}

/// Call `visit(values, gradients, weight)` at every point of a rule exact for
/// a piece's thermal-force integrand (∇N times the interpolated ΔT), with the
/// shape-function values and physical gradients there (in the piece's node
/// order) and the quadrature weight times the volume scale.
fn for_each_thermal_point(piece: &PieceRef<'_>, mut visit: impl FnMut(&[f64], &[[f64; 3]], f64)) {
    match (piece.geometry, piece.order) {
        (PieceGeometry::Tetrahedron(_), ElementOrder::Linear) => {
            // Constant gradients: the one-point rule is exact for the linear ΔT.
            let point = PiecePoint::Tetrahedron(CENTROID);
            let (gradients, volume) = piece.gradients(point);
            visit(&piece.shape_values(point), &gradients, volume);
        }
        (PieceGeometry::Tetrahedron(_), ElementOrder::Quadratic) => {
            // A quadratic ΔT times the linear gradient is cubic: the stiffness
            // rule (exact for quadratics) is not enough.
            for (local, fraction) in degree_three_points() {
                let point = PiecePoint::Tetrahedron(local);
                let (gradients, volume) = piece.gradients(point);
                visit(&piece.shape_values(point), &gradients, fraction * volume);
            }
        }
        (PieceGeometry::Hexahedron(_), _) => {
            for (point, gradients, weight) in piece.stiffness_points() {
                visit(&piece.shape_values(point), &gradients, weight);
            }
        }
    }
}

/// ΔT at shape-function `values` of a piece whose nodal ΔT is `local`.
fn interpolate(values: &[f64], local: &[f64]) -> f64 {
    values
        .iter()
        .zip(local)
        .map(|(value, delta)| value * delta)
        .sum()
}

/// Equivalent nodal forces of the thermal strain α·ΔT, 3 per node like a
/// force vector (`f = ∫ Bᵀ·D·ε_th dV`, see the module documentation). Add
/// them to the mechanical forces before the solve; a positive ΔT pushes
/// outward.
///
/// # Errors
/// [`FemError::ExpansionCoefficientCount`] unless `alpha` has one value per
/// element (tets, then hexes), [`FemError::TemperatureCount`] unless
/// `delta_t` has one per node, and [`FemError::NonFinite`] for a value that
/// is not finite.
pub fn thermal_load(mesh: &TetMesh, alpha: &[f64], delta_t: &[f64]) -> Result<Vec<f64>, FemError> {
    check_input(mesh, alpha, delta_t)?;
    let mut forces = vec![0.0; mesh.dof_count()];
    for (element, &expansion) in alpha.iter().enumerate() {
        if expansion == 0.0 {
            continue;
        }
        let (lambda, mu) = mesh.material(element).lame();
        let stiffness = (3.0 * lambda + 2.0 * mu) * expansion;
        for piece in mesh.pieces(element) {
            let local = piece.local_values(delta_t, 1);
            let mut piece_forces = vec![0.0; 3 * piece.nodes.len()];
            for_each_thermal_point(&piece, |values, gradients, weight| {
                let stress = stiffness * interpolate(values, &local) * weight;
                for (slot, gradient) in gradients.iter().enumerate() {
                    for (axis, component) in gradient.iter().enumerate() {
                        piece_forces[3 * slot + axis] += component * stress;
                    }
                }
            });
            piece.fold_rows(&mut piece_forces, 3);
            for (&node, force) in piece.nodes.iter().zip(piece_forces.as_chunks::<3>().0) {
                for (axis, component) in force.iter().enumerate() {
                    forces[3 * node as usize + axis] += component;
                }
            }
        }
    }
    Ok(forces)
}

/// The thermal strain α·ΔT of one element at its centre (for a transition
/// element, the volume mean of its pieces' centres), after the input is
/// checked.
fn centre_strain(mesh: &TetMesh, element: usize, alpha: &[f64], delta_t: &[f64]) -> f64 {
    let temperature: f64 = centre_samples(mesh, element)
        .into_iter()
        .map(|(piece, point, weight)| {
            weight * interpolate(&piece.shape_values(point), &piece.local_values(delta_t, 1))
        })
        .sum();
    alpha[element] * temperature
}

/// The free thermal strain α·ΔT of `element` (each normal component; the
/// shear components are zero) at its centre — the point where
/// [`crate::stress`] recovers the stress — with ΔT interpolated by the
/// element's shape functions. Subtract it from `ε_xx`, `ε_yy` and `ε_zz`
/// before applying D: `σ = D·(ε − ε_th)`.
///
/// # Errors
/// [`FemError::ElementOutOfRange`] for an element the mesh does not have,
/// and the input errors of [`thermal_load`].
pub fn thermal_strain_at_centre(
    mesh: &TetMesh,
    element: usize,
    alpha: &[f64],
    delta_t: &[f64],
) -> Result<f64, FemError> {
    if element >= mesh.element_count() {
        return Err(FemError::ElementOutOfRange {
            element,
            count: mesh.element_count(),
        });
    }
    // Only this element's values are checked, so a caller may recover one
    // element after another without rescanning the arrays.
    check_lengths(mesh, alpha, delta_t)?;
    let nodes = mesh.element_nodes(element);
    check_finite(
        std::iter::once(&alpha[element]),
        nodes.iter().map(|node| &delta_t[*node as usize]),
    )?;
    Ok(centre_strain(mesh, element, alpha, delta_t))
}

/// [`thermal_strain_at_centre`] of every element, tets first, then hexes.
///
/// # Errors
/// The input errors of [`thermal_load`].
pub fn thermal_strains_at_centres(
    mesh: &TetMesh,
    alpha: &[f64],
    delta_t: &[f64],
) -> Result<Vec<f64>, FemError> {
    check_input(mesh, alpha, delta_t)?;
    Ok((0..mesh.element_count())
        .map(|element| centre_strain(mesh, element, alpha, delta_t))
        .collect())
}

/// The stress tensor of every element at each of its corner vertices, as
/// [`crate::corner_stress_tensors`] gives it, with the thermal strain
/// removed: `σ = D·(ε − α·ΔT·I)`, so each normal component drops by
/// `(3λ + 2μ)·α·ΔT` with ΔT at that corner. A corner is a vertex node, where
/// the interpolated ΔT is its nodal value.
///
/// # Errors
/// The displacement error of [`crate::corner_stress_tensors`] and the input
/// errors of [`thermal_load`].
pub fn corner_stress_tensors_thermal(
    mesh: &TetMesh,
    displacements: &[f64],
    alpha: &[f64],
    delta_t: &[f64],
) -> Result<Vec<[f64; 6]>, FemError> {
    check_input(mesh, alpha, delta_t)?;
    let mut tensors = crate::stress::corner_stress_tensors(mesh, displacements)?;
    let mut corner = 0;
    for (element, &expansion) in alpha.iter().enumerate() {
        let (lambda, mu) = mesh.material(element).lame();
        let stiffness = (3.0 * lambda + 2.0 * mu) * expansion;
        for &node in mesh.element_corners(element) {
            let thermal = stiffness * delta_t[node as usize];
            for component in &mut tensors[corner][..3] {
                *component -= thermal;
            }
            corner += 1;
        }
    }
    Ok(tensors)
}
