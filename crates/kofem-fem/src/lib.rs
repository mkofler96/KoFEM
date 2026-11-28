// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Linear-elastic finite elements for KoFEM: linear and quadratic tetrahedra
//! and hexahedra, Kirchhoff shell facets, sparse assembly, Dirichlet elimination,
//! surface-to-point couplings, constraint ties with dual mortar weights, a
//! preconditioned conjugate-gradient solve, a Newton driver for nonlinear
//! solves (frictionless contact, and a compressible Neo-Hookean solid for
//! large deformation) and SIMP topology optimization.
//! Pure Rust with no I/O or clock, so the same code runs natively under
//! `cargo test` and in the browser through `kofem-wasm`.
//!
//! MFEM attribution: this module reimplements the linear-elastic formulation
//! and iterative-solver approach used by KoFEM's MFEM-based engine. MFEM and
//! its contributors are the upstream numerical implementation reference.
//! See `../NOTICE.md` for source references and `../LICENSE-MFEM` for MFEM's
//! copyright notice and BSD-3-Clause terms, retained alongside KoFEM's license.

pub mod amg;
pub mod assembly;
pub mod cg;
pub mod constraints;
pub mod contact;
pub mod convergence;
pub mod count;
pub mod coupled_static;
pub mod coupling;
pub mod element;
pub mod error;
pub mod extremum;
pub mod failure_class;
pub mod field_expression;
pub mod field_peak;
pub mod field_statistics;
pub mod hyperelastic;
pub mod incomplete_cholesky;
pub mod material;
pub mod mesh;
pub mod mesh_outline;
pub mod mesh_statistics;
pub mod mortar;
pub mod nonlinear;
pub mod piece;
pub mod reactions;
pub mod report;
pub mod rigid_body;
pub mod section;
pub mod shell;
pub mod sparse;
pub mod static_solve;
pub mod stress;
pub mod surface;
pub mod thermal;
pub mod tie;
pub mod topology;
pub mod transition;

pub use amg::{
    AmgSettings, LevelInfo, NodeBlock, Preconditioner, SmoothedAggregation, SymmetricGaussSeidel,
};
pub use assembly::assemble_stiffness;
pub use cg::{solve_pcg, solve_pcg_with, CgOutcome, CgSettings, PcgRun, PcgStatus, StoppingRule};
pub use constraints::{apply_dirichlet, eliminate_dirichlet, Dirichlet, EliminatedEntries};
pub use count::{count_as_f64, index_as_u32};
pub use coupled_static::{
    constrained_reduction, prepare_constrained_static, prepare_coupled_static,
    prepare_mixed_static, solve_coupled_static, solve_mixed_static, AppliedPreconditioner,
    CoupledReduction, CoupledSolution, MixedPreconditioner, NormalConstraint, PreparedCoupled,
    PreparedMixed, ShellPart,
};
pub use coupling::{Coupling, CouplingConstraints, CouplingKind, ALL_DOFS, DOFS_PER_NODE};
pub use error::FemError;
pub use failure_class::{FailureClass, NumericalReason, INTERNAL_FORCE};
pub use field_expression::{FieldExpression, FieldExpressionError};
pub use field_peak::{
    field_peak, BoundaryGroup, Condition, CouplingSurface, FieldPeak, PeakInput, PickGeometry,
    Selection,
};
pub use field_statistics::{nodal_percentiles, StatisticsMesh};
pub use incomplete_cholesky::IncompleteCholesky;
pub use material::Isotropic;
pub use mesh::{ElementOrder, ElementShape, Pieces, TetMesh};
pub use mesh_outline::{outer_faces, unique_edges, OuterFaces};
pub use mesh_statistics::{body_statistics, BodyMesh, BodyStatistics};
pub use mortar::{mortar_integrals, mortar_weights, MortarFace, MortarRow, SlaveIntegrals};
pub use reactions::{
    fold_onto_vertices, fold_onto_vertices_at, load_on_held_nodes, nodal_residual,
    summarize_reactions, summarize_reactions_at, widen_translations, NodalReaction,
    ReactionSummary, SupportReaction,
};
pub use report::{percentile, report_stats, ReportStats};
pub use rigid_body::{free_rigid_motions, FreeMotion, RigidBodyModel, RigidContact, RigidLink};
pub use section::{section_cut, SectionCut, SectionMesh, SectionPlane};
pub use shell::{
    assemble_shell_stiffness, prepare_shell_static, shell_corner_stress_tensors,
    shell_stress_tensors, shell_translations, shell_von_mises, solve_shell_static, PreparedShell,
    ShellMesh, ShellPreconditioner, ShellSolution, ShellSurface,
};
pub use sparse::CsrMatrix;
pub use static_solve::{
    prepare_static, solve_static, PreconditionerChoice, PreparedStatic, StaticSolution,
};
pub use stress::{corner_stress_tensors, stress_tensors, von_mises};
pub use surface::{BoundaryFaces, SurfaceLoadKind, SurfaceLoadReport};
pub use thermal::{
    corner_stress_tensors_thermal, thermal_load, thermal_strain_at_centre,
    thermal_strains_at_centres,
};
pub use tie::{
    node_ties, prepare_tied_static, solve_tied_static, tie_couplings, NodeTie, PreparedTied,
    TieReport, TiedSolution, VertexTies,
};
pub use transition::{find_interface_faces, Diagonal, InterfaceFace};
