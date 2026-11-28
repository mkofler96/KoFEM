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
    #[error("{count} material ids given for {elements} elements (tetrahedra, then hexahedra)")]
    MaterialIdCount { count: usize, elements: usize },
    #[error("tetrahedron {tet} uses material {material}, but only {count} materials are defined")]
    MaterialOutOfRange {
        tet: usize,
        material: u32,
        count: usize,
    },
    #[error("hexahedron array has {len} indices, which is not a multiple of 8")]
    HexArrayLength { len: usize },
    #[error("hexahedron {hex} references vertex {vertex}, but the mesh has {count} vertices")]
    HexVertexOutOfRange {
        hex: usize,
        vertex: u32,
        count: usize,
    },
    #[error(
        "hexahedron {hex} is flat or folded: its volume vanishes or turns inside out within the \
         element, so it has no stiffness to integrate"
    )]
    DegenerateHex { hex: usize },
    #[error("hexahedron {hex} uses material {material}, but only {count} materials are defined")]
    HexMaterialOutOfRange {
        hex: usize,
        material: u32,
        count: usize,
    },
    #[error("material {index}: Young's modulus must be positive and finite, got {value}")]
    YoungsModulus { index: usize, value: f64 },
    #[error("material {index}: Poisson's ratio must lie in (-1, 0.5), got {value}")]
    PoissonRatio { index: usize, value: f64 },
    #[error("the mesh has {count} nodes; at most {max} are supported")]
    TooManyNodes { count: usize, max: usize },
    #[error("the mesh has no elements")]
    EmptyMesh,
    #[error("{what} connectivity has {len} corner indices, which is not a multiple of {per}")]
    ConnectivityLength {
        what: &'static str,
        len: usize,
        per: usize,
    },
    #[error("support reactions: {reason}")]
    ReactionInput { reason: String },
    #[error("report: {reason}")]
    ReportField { reason: String },
    #[error(
        "a coupled, tied or mixed solve works on a reduction of the stiffness matrix, \
         so it has no assembled matrix to give back"
    )]
    ReducedSystem,
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
        "surface load {load}: {unmatched} of the {selected} selected face(s) are not on the \
         mesh boundary, so they would carry no load and the rest would carry it all — a \
         stale face selection after a remesh?"
    )]
    SurfaceLoadUnmatched {
        load: usize,
        unmatched: usize,
        selected: usize,
    },
    #[error(
        "surface load {load}: the selected faces have a total area of {area}, so a total \
         force cannot be spread over them"
    )]
    SurfaceLoadArea { load: usize, area: f64 },
    #[error(
        "triangle {triangle}: the recovered stress is {value}, not a finite number — the \
         displacements it was recovered from are not finite or overflow"
    )]
    NonFiniteStress { triangle: usize, value: f64 },
    #[error("displacement vector has {len} entries, but the model has {count} degrees of freedom")]
    DisplacementLength { len: usize, count: usize },
    #[error("multigrid setup input is invalid: {reason}")]
    AmgInput { reason: &'static str },
    #[error(
        "the coarsest multigrid matrix ({unknowns} unknowns) is not positive definite — \
         the model is probably not fully constrained"
    )]
    CoarseNotPositiveDefinite { unknowns: usize },
    #[error("section cut: {reason}")]
    SectionInput { reason: String },
    #[error("field statistics: {reason}")]
    StatisticsInput { reason: String },
    #[error("safety factor: {reason}")]
    SafetyFactorInput { reason: String },
    #[error("coupling {coupling}: {reason}")]
    Coupling { coupling: usize, reason: String },
    #[error("coupling input is invalid: {reason}")]
    CouplingInput { reason: String },
    #[error("tie constraints: {reason}")]
    Tie { reason: String },
    #[error("rigid-body check: {reason}")]
    RigidBodyInput { reason: String },
    #[error(
        "node {node} DOF {component} is eliminated by two couplings — a DOF can be eliminated \
         by only one constraint. Make one of them distributing, or pick surfaces that do not \
         overlap"
    )]
    CouplingDofConflict { node: usize, component: usize },
    #[error(
        "couplings form a cycle — node {first} and node {second} each depend on the other. \
         Break the loop: a chain of couplings must end at nodes that are free"
    )]
    CouplingCycle { first: usize, second: usize },
    #[error(
        "{what} DOF {component} of node {node} lies on a node that follows a coupling \
         (distributing, kinematic, or a shell-to-solid seam or footprint) — its motion is \
         governed by the coupling, so the condition cannot be honoured. Constrain the coupled \
         nodes or a kinematic reference point instead"
    )]
    ConstraintOnCoupledDof {
        node: usize,
        component: usize,
        what: &'static str,
    },
    #[error(
        "node {node} has no rotational degree of freedom, but a {what} acts on its DOF \
         {component} — only shell nodes and coupling reference points carry rotations"
    )]
    RotationWithoutDof {
        node: usize,
        component: usize,
        what: &'static str,
    },
    #[error(
        "node {node} DOF {component} carries a load, but no element or coupling stiffens it — \
         the load would be lost"
    )]
    LoadWithoutStiffness { node: usize, component: usize },
    #[error(
        "shells mixed with solids are supported on linear tetrahedra only, but this mesh is \
         quadratic"
    )]
    ShellOnQuadraticMesh,
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
    #[error(
        "{count} thermal expansion coefficients given for {elements} elements (tetrahedra, \
         then hexahedra)"
    )]
    ExpansionCoefficientCount { count: usize, elements: usize },
    #[error(
        "{count} temperature changes given for {nodes} nodes (vertices, then the nodes a \
         quadratic mesh adds)"
    )]
    TemperatureCount { count: usize, nodes: usize },
    #[error("element {element} is out of range (the mesh has {count})")]
    ElementOutOfRange { element: usize, count: usize },
    #[error("topology optimization: {reason}")]
    TopologyInput { reason: String },
    #[error("mesh convergence: {reason}")]
    Convergence { reason: String },
    #[error(
        "Newton increment {increment} of {increments} did not converge: relative residual \
         {relative_residual:e} after {iterations} iterations (target {target:e})"
    )]
    NewtonNotConverged {
        increment: u32,
        increments: u32,
        iterations: usize,
        relative_residual: f64,
        target: f64,
    },
    #[error(
        "Newton increment {increment}, iteration {iteration}: the tangent solve failed: {reason}"
    )]
    TangentSolve {
        increment: u32,
        iteration: usize,
        reason: String,
    },
    #[error(
        "Newton increment {increment} of {increments} (load factor {load_factor}): the tangent \
         stiffness is not positive definite — the model loses stability (it buckles or snaps \
         through) at or below this load, so a static solve cannot follow it further"
    )]
    TangentNotPositiveDefinite {
        increment: u32,
        increments: u32,
        load_factor: f64,
    },
    #[error(
        "element {element} is turned inside out (volume ratio J = {jacobian:e}): the \
         deformation is too large for one load increment, or for the element — try more load \
         increments"
    )]
    InvertedElement { element: usize, jacobian: f64 },
    #[error(
        "the Newton solve has not finished: it stands at increment {increment}, iteration \
         {iteration}"
    )]
    NewtonUnfinished { increment: u32, iteration: usize },
    #[error("nonlinear solve: {reason}")]
    NonlinearInput { reason: String },
    #[error("contact: {reason}")]
    Contact { reason: String },
}
