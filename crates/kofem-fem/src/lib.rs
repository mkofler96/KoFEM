// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Linear-elastic finite elements for KoFEM: linear and quadratic tetrahedra
//! and hexahedra, Kirchhoff shell facets, sparse assembly, Dirichlet elimination,
//! surface-to-point couplings, constraint ties with dual mortar weights, a
//! preconditioned conjugate-gradient solve and SIMP topology optimization.
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
pub mod convergence;
pub mod count;
pub mod coupled_static;
pub mod coupling;
pub mod element;
pub mod error;
pub mod field_expression;
pub mod incomplete_cholesky;
pub mod material;
pub mod mesh;
pub mod mesh_outline;
pub mod mortar;
pub mod reactions;
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

pub use amg::{AmgSettings, LevelInfo, Preconditioner, SmoothedAggregation, SymmetricGaussSeidel};
pub use assembly::assemble_stiffness;
pub use cg::{solve_pcg, solve_pcg_with, CgOutcome, CgSettings, PcgRun, PcgStatus, StoppingRule};
pub use constraints::{apply_dirichlet, eliminate_dirichlet, Dirichlet, EliminatedEntries};
pub use count::count_as_f64;
pub use coupled_static::{
    prepare_coupled_static, prepare_mixed_static, solve_coupled_static, solve_mixed_static,
    AppliedPreconditioner, CoupledReduction, CoupledSolution, MixedPreconditioner, PreparedCoupled,
    PreparedMixed, ShellPart,
};
pub use coupling::{Coupling, CouplingConstraints, CouplingKind, ALL_DOFS, DOFS_PER_NODE};
pub use error::FemError;
pub use field_expression::{FieldExpression, FieldExpressionError};
pub use incomplete_cholesky::IncompleteCholesky;
pub use material::Isotropic;
pub use mesh::{ElementOrder, ElementShape, TetMesh};
pub use mesh_outline::{outer_faces, unique_edges, OuterFaces};
pub use mortar::{mortar_weights, MortarFace, MortarRow};
pub use reactions::{
    fold_onto_vertices, load_on_held_nodes, nodal_residual, summarize_reactions,
    widen_translations, NodalReaction, ReactionSummary, SupportReaction,
};
pub use rigid_body::{free_rigid_motions, FreeMotion, RigidBodyModel, RigidLink};
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
    node_ties, prepare_tied_static, solve_tied_static, NodeTie, PreparedTied, TieReport,
    TiedSolution, VertexTies,
};
