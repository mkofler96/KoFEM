// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

use thiserror::Error;

/// Every way the finite-element pipeline refuses its input. Each variant names
/// the offending item so the message can reach the user unchanged.
#[derive(Debug, Error, PartialEq)]
pub enum FemError {
    #[error("vertex array has {len} values, which is not a multiple of 3")]
    VertexArrayLength { len: usize },
    #[error("tetrahedron array has {len} indices, which is not a multiple of 4")]
    TetArrayLength { len: usize },
    #[error("tetrahedron {tet} references vertex {vertex}, but the mesh has {count} vertices")]
    VertexOutOfRange {
        tet: usize,
        vertex: u32,
        count: usize,
    },
    #[error("tetrahedron {tet} has zero volume (its four vertices are coplanar)")]
    DegenerateTet { tet: usize },
    #[error("{count} material ids given for {tets} tetrahedra")]
    MaterialIdCount { count: usize, tets: usize },
    #[error("tetrahedron {tet} uses material {material}, but only {count} materials are defined")]
    MaterialOutOfRange {
        tet: usize,
        material: u32,
        count: usize,
    },
    #[error("material {index}: Young's modulus must be positive and finite, got {value}")]
    YoungsModulus { index: usize, value: f64 },
    #[error("material {index}: Poisson's ratio must lie in (-1, 0.5), got {value}")]
    PoissonRatio { index: usize, value: f64 },
    #[error("the mesh has {count} nodes; at most {max} are supported")]
    TooManyNodes { count: usize, max: usize },
    #[error("the mesh has no tetrahedra")]
    EmptyMesh,
    #[error("constrained degree of freedom {dof} is out of range (the model has {count})")]
    DofOutOfRange { dof: u32, count: usize },
    #[error("degree of freedom {dof} is constrained twice, to {first} and {second}")]
    ConflictingConstraint { dof: u32, first: f64, second: f64 },
    #[error("vertex {vertex} is constrained, but no element uses it")]
    ConstraintOnUnusedVertex { vertex: usize },
    #[error("vertex {vertex} carries a load, but no element uses it — the load would be lost")]
    LoadOnUnusedVertex { vertex: usize },
    #[error("{values} constraint values given for {dofs} constrained degrees of freedom")]
    ConstraintValueCount { dofs: usize, values: usize },
    #[error("force vector has {len} entries, but the model has {count} degrees of freedom")]
    ForceLength { len: usize, count: usize },
    #[error("a non-finite value ({value}) was given for {what}")]
    NonFinite { what: &'static str, value: f64 },
    #[error(
        "the stiffness matrix is not positive definite (CG breakdown at iteration {iteration}) — \
         the model is probably not fully constrained"
    )]
    NotPositiveDefinite { iteration: usize },
    #[error(
        "CG did not converge: relative residual {relative_residual:e} after {iterations} \
         iterations (target {target:e})"
    )]
    NotConverged {
        iterations: usize,
        relative_residual: f64,
        target: f64,
    },
    #[error("CG settings are invalid: {reason}")]
    InvalidSettings { reason: &'static str },
    #[error(
        "surface load {load}: none of the {faces} selected face(s) is on the mesh boundary, \
         so the load would apply no force at all — a stale face selection after a remesh?"
    )]
    SurfaceLoadUnmatched { load: usize, faces: usize },
    #[error(
        "surface load {load}: the selected faces have a total area of {area}, so a total \
         force cannot be spread over them"
    )]
    SurfaceLoadArea { load: usize, area: f64 },
    #[error("displacement vector has {len} entries, but the model has {count} degrees of freedom")]
    DisplacementLength { len: usize, count: usize },
    #[error("multigrid setup input is invalid: {reason}")]
    AmgInput { reason: &'static str },
    #[error(
        "the coarsest multigrid matrix ({unknowns} unknowns) is not positive definite — \
         the model is probably not fully constrained"
    )]
    CoarseNotPositiveDefinite { unknowns: usize },
    #[error("triangle array has {len} indices, which is not a multiple of 3")]
    TriangleArrayLength { len: usize },
    #[error("the shell mesh has no triangles")]
    EmptyShellMesh,
    #[error("triangle {triangle} references vertex {vertex}, but the mesh has {count} vertices")]
    TriangleVertexOutOfRange {
        triangle: usize,
        vertex: u32,
        count: usize,
    },
    #[error("triangle {triangle} has zero area (its three vertices are collinear or coincide)")]
    DegenerateTriangle { triangle: usize },
    #[error("{count} shell thicknesses given for {triangles} triangles")]
    ThicknessCount { count: usize, triangles: usize },
    #[error("triangle {triangle}: shell thickness must be positive and finite, got {value}")]
    Thickness { triangle: usize, value: f64 },
    #[error("{count} material ids given for {triangles} triangles")]
    ShellMaterialIdCount { count: usize, triangles: usize },
    #[error(
        "triangle {triangle} uses material {material}, but only {count} materials are defined"
    )]
    ShellMaterialOutOfRange {
        triangle: usize,
        material: u32,
        count: usize,
    },
}
