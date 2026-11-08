// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Shell/solid transition: where a Shell body's wall meets retained solid, cut
//! the solid at a plane a few wall thicknesses in, so the shell edge lands on a
//! through-thickness solid section and couples through its physical footprint.

use std::collections::{BTreeSet, HashSet};

use crate::clip::{clip_shell_transition, TransitionPlane};
use crate::coupled_model::{build_coupled_model, CoupledModel, CouplingOptions};
use crate::coupling_set::CouplingKind;
use crate::error::ShellizeError;
use crate::footprint::shell_boundary_edges;
use crate::geometry::{add, dot, max_of, scale, sub, tet_mesh_boundary, ShellizeMesh, Vec3};
use crate::grid::TriangleGrid;
use crate::mid_surface::ShellExtraction;
use crate::wall_tets::shell_body_tets;
use crate::walls::face_props;

/// The mesh-time shell model: the (possibly clipped) mesh, the shell
/// extraction it was built with, and the coupled model over both.
#[derive(Debug, Clone, PartialEq)]
pub struct ShellTransitionModel {
    pub mesh: ShellizeMesh,
    pub shells: ShellExtraction,
    pub model: CoupledModel,
}

/// Preserve 3-D material at planar wall roots before the shell idealisation:
/// every free shell edge lying on the retained solid's boundary defines a cut
/// plane 3 wall thicknesses into the shell, the solid keeps everything on its
/// side, and the shell edge then couples to the cut section (kind 3).
///
/// # Errors
/// A Shell body the walls do not cover, a shell too short for its joint
/// sections, or a joint the footprint could not connect.
pub fn build_shell_transition_model(
    mesh: &ShellizeMesh,
    shells: &ShellExtraction,
) -> Result<ShellTransitionModel, ShellizeError> {
    let replaced = shell_body_tets(mesh, shells)?;
    let unclipped = |replaced: &BTreeSet<usize>| -> Result<ShellTransitionModel, ShellizeError> {
        Ok(ShellTransitionModel {
            mesh: mesh.clone(),
            shells: shells.clone(),
            model: build_coupled_model(mesh, shells, replaced, &CouplingOptions::default())?,
        })
    };
    let retained: Vec<[usize; 4]> = mesh
        .tets
        .iter()
        .enumerate()
        .filter(|(element, _)| !replaced.contains(element))
        .map(|(_, &tet)| tet)
        .collect();
    let Some(max_thickness) = max_of(&shells.thicknesses).filter(|_| !retained.is_empty()) else {
        return unclipped(&replaced);
    };
    let boundary = tet_mesh_boundary(&retained);
    let tolerance = max_thickness * 1e-7;
    let grid = TriangleGrid::new(
        boundary
            .iter()
            .map(|tri| tri.map(|vertex| mesh.vertices[vertex]))
            .collect(),
        max_thickness,
    )?;
    let on_solid =
        |point: Vec3| grid.any_near(point, |distance2, _| distance2 <= tolerance * tolerance);
    let mut planes: Vec<TransitionPlane> = Vec::new();
    for edge in shell_boundary_edges(&shells.vertices, &shells.triangles, &shells.thicknesses)? {
        let first = shells.vertices[edge.first];
        let second = shells.vertices[edge.second];
        let middle = scale(add(first, second), 0.5);
        if ![first, second, middle].into_iter().all(on_solid) {
            continue;
        }
        let origin = add(middle, scale(edge.inward, 3.0 * edge.thickness));
        let duplicate = planes.iter().any(|plane| {
            (0..3).all(|axis| (plane.normal[axis] - edge.inward[axis]).abs() < 1e-7)
                && dot(plane.normal, sub(plane.origin, origin)).abs() < tolerance
        });
        if !duplicate {
            planes.push(TransitionPlane {
                origin,
                normal: edge.inward,
            });
        }
    }
    if planes.is_empty() {
        return unclipped(&replaced);
    }
    let shell_faces: HashSet<i32> = face_props(mesh)
        .into_iter()
        .filter(|face| face.body.is_some() && face.body == shells.shell_body)
        .map(|face| face.id)
        .collect();
    let (clipped, clipped_shells) =
        clip_shell_transition(mesh, shells, &replaced, &planes, &shell_faces, tolerance)?;
    let model = build_coupled_model(
        &clipped,
        &clipped_shells,
        &BTreeSet::new(),
        &CouplingOptions::default(),
    )?;
    if !model.coupling.kind.contains(&CouplingKind::Footprint) {
        return Err(ShellizeError::FootprintNotConnected);
    }
    Ok(ShellTransitionModel {
        mesh: clipped,
        shells: clipped_shells,
        model,
    })
}
