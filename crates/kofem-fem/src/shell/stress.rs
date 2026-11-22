// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Shell stress recovery, as the C++ engine's `shell_von_mises` reports it.

use crate::error::FemError;
use crate::mesh::dot;
use crate::shell::assembly::SHELL_NODE_DOFS;
use crate::shell::element::{constitutive, dkt_curvature_b, membrane_b, FacetFrame};
use crate::shell::mesh::ShellMesh;

/// One value per facet: plane-stress von Mises at the worse of the two
/// surfaces z = ±t/2, from the CST membrane strain and the DKT curvature at
/// the facet centroid, σ(z) = D·(`ε_m` + z·κ), with each facet's own (E, ν).
/// Taking the worse surface makes the result independent of the curvature's
/// sign convention.
///
/// # Errors
/// [`FemError::DisplacementLength`] when `dofs` is not 6 per vertex.
pub fn shell_von_mises(mesh: &ShellMesh, dofs: &[f64]) -> Result<Vec<f64>, FemError> {
    check_length(mesh, dofs)?;
    let stresses = (0..mesh.triangles().len())
        .map(|triangle| {
            let facet = FacetStrain::new(mesh, dofs, triangle);
            [facet.half, -facet.half]
                .into_iter()
                .map(|depth| {
                    let [sx, sy, txy] = facet.stress_at(depth);
                    (sx * sx - sx * sy + sy * sy + 3.0 * txy * txy).sqrt()
                })
                .fold(0.0, f64::max)
        })
        .collect();
    Ok(stresses)
}

/// The surface of a shell a stress is read on: z = +t/2 along the facet
/// normal (the right-hand normal of its corner order), the mid-surface, or
/// z = −t/2.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellSurface {
    Top,
    Middle,
    Bottom,
}

/// One value per facet: the plane-stress tensor on `surface` at the facet
/// centroid, rotated into global axes as `[σxx, σyy, σzz, τxy, τyz, τzx]`.
/// The bending part follows the physical sign: a facet curving towards its
/// normal is shortened on its top surface.
///
/// # Errors
/// [`FemError::DisplacementLength`] when `dofs` is not 6 per vertex.
pub fn shell_stress_tensors(
    mesh: &ShellMesh,
    dofs: &[f64],
    surface: ShellSurface,
) -> Result<Vec<[f64; 6]>, FemError> {
    check_length(mesh, dofs)?;
    Ok((0..mesh.triangles().len())
        .map(|triangle| FacetStrain::new(mesh, dofs, triangle).global_tensor(surface))
        .collect())
}

/// Three values per facet, at its corners in its node order: the plane-stress
/// tensor on `surface` from the facet's own field (its constant membrane
/// strain and its DKT curvature at the corner), in global axes as for
/// [`shell_stress_tensors`].
///
/// # Errors
/// [`FemError::DisplacementLength`] when `dofs` is not 6 per vertex.
pub fn shell_corner_stress_tensors(
    mesh: &ShellMesh,
    dofs: &[f64],
    surface: ShellSurface,
) -> Result<Vec<[f64; 6]>, FemError> {
    check_length(mesh, dofs)?;
    Ok((0..mesh.triangles().len())
        .flat_map(|triangle| {
            [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]]
                .map(|point| FacetStrain::at(mesh, dofs, triangle, point).global_tensor(surface))
        })
        .collect())
}

fn check_length(mesh: &ShellMesh, dofs: &[f64]) -> Result<(), FemError> {
    let count = SHELL_NODE_DOFS * mesh.vertex_count();
    if dofs.len() == count {
        Ok(())
    } else {
        Err(FemError::DisplacementLength {
            len: dofs.len(),
            count,
        })
    }
}

/// A facet's CST membrane strain and DKT curvature at its centroid, in its
/// own frame, with its plane-stress law and half thickness.
struct FacetStrain {
    axes: [[f64; 3]; 3],
    membrane: [f64; 3],
    curvature: [f64; 3],
    law: [[f64; 3]; 3],
    half: f64,
}

impl FacetStrain {
    fn new(mesh: &ShellMesh, dofs: &[f64], triangle: usize) -> Self {
        Self::at(mesh, dofs, triangle, [1.0 / 3.0, 1.0 / 3.0])
    }

    /// The strains at the facet's parametric point (ξ, η): the membrane strain
    /// is constant, the DKT curvature varies over the facet.
    fn at(mesh: &ShellMesh, dofs: &[f64], triangle: usize, [xi, eta]: [f64; 2]) -> Self {
        let nodes = mesh.triangles()[triangle];
        let frame = FacetFrame::new(&mesh.corners(triangle));
        let [e1, e2, e3] = frame.axes;
        // Nodal DOFs in the facet frame: (u, v) for the membrane, (w, θx,
        // θy) for bending.
        let mut membrane_dofs = [0.0; 6];
        let mut bending_dofs = [0.0; 9];
        for (local, &node) in nodes.iter().enumerate() {
            let base = SHELL_NODE_DOFS * node as usize;
            let translation = [dofs[base], dofs[base + 1], dofs[base + 2]];
            let rotation = [dofs[base + 3], dofs[base + 4], dofs[base + 5]];
            membrane_dofs[2 * local] = dot(e1, translation);
            membrane_dofs[2 * local + 1] = dot(e2, translation);
            bending_dofs[3 * local] = dot(e3, translation);
            bending_dofs[3 * local + 1] = dot(e1, rotation);
            bending_dofs[3 * local + 2] = dot(e2, rotation);
        }
        let material = mesh.material(triangle);
        let poisson = material.poisson();
        Self {
            axes: frame.axes,
            membrane: apply(&membrane_b(&frame), &membrane_dofs),
            curvature: apply(&dkt_curvature_b(&frame, xi, eta), &bending_dofs),
            law: constitutive(material.young() / (1.0 - poisson * poisson), poisson),
            half: 0.5 * mesh.thickness(triangle),
        }
    }

    /// The stress on `surface`, rotated into global axes:
    /// σ = sx·e1⊗e1 + sy·e2⊗e2 + txy·(e1⊗e2 + e2⊗e1).
    fn global_tensor(&self, surface: ShellSurface) -> [f64; 6] {
        let depth = match surface {
            ShellSurface::Top => self.half,
            ShellSurface::Middle => 0.0,
            ShellSurface::Bottom => -self.half,
        };
        let [sx, sy, txy] = self.stress_at(depth);
        let [e1, e2, _] = self.axes;
        let entry = |i: usize, j: usize| {
            sx * e1[i] * e1[j] + sy * e2[i] * e2[j] + txy * (e1[i] * e2[j] + e2[i] * e1[j])
        };
        [
            entry(0, 0),
            entry(1, 1),
            entry(2, 2),
            entry(0, 1),
            entry(1, 2),
            entry(2, 0),
        ]
    }

    /// The plane stress [σx, σy, τxy] at height `depth` along the facet
    /// normal: `σ(z) = D·(ε_m + z·κ)`.
    fn stress_at(&self, depth: f64) -> [f64; 3] {
        let strain: [f64; 3] =
            std::array::from_fn(|i| self.membrane[i] + depth * self.curvature[i]);
        apply(&self.law, &strain)
    }
}

/// matrix · vector for a 3-row matrix.
fn apply<const N: usize>(matrix: &[[f64; N]; 3], vector: &[f64; N]) -> [f64; 3] {
    matrix.map(|row| {
        row.iter()
            .zip(vector)
            .map(|(entry, value)| entry * value)
            .sum()
    })
}
