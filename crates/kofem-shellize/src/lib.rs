// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Solid → shell idealisation for KoFEM: find the thin walls of the body the
//! user marked Shell, collapse them to a Kirchhoff shell mid-surface (one
//! thickness per wall), keep the other bodies as solid tets, and build the
//! node pool and couplings of the coupled shell/solid solve.
//!
//! Ported from the TypeScript pipeline that lived in `web/src/lib/shellize/`
//! (KOF-297); the app reaches it through `web/src/lib/shellize.ts`.
//! Stages, bottom-up:
//!   [`walls`]          thin-wall detection (opposite planar CAD-face pairs)
//!   [`mid_surface`]    collapse the walls to welded mid-surface facets
//!   [`wall_tets`]      which solid tets the shell facets replace
//!   [`transition`]     cut retained solid at a wall root ([`clip`])
//!   [`coupled_model`]  the coupled node pool and the couplings joining it
//!   [`seam`], [`footprint`], [`ties`], [`partners`]  how couplings are found
//!   [`coupling_set`]   the CSR coupling set
//!   [`geometry`], [`grid`]  shared primitives
//!
//! Pure Rust with no I/O, so it runs natively under `cargo test` and in the
//! browser through `kofem-wasm`.

#![allow(
    clippy::implicit_hasher,
    reason = "the stages exchange std HashSets built in this crate; a hasher parameter would only add noise"
)]

pub mod clip;
pub mod coupled_model;
pub mod coupling_set;
pub mod error;
pub mod footprint;
pub mod geometry;
pub mod grid;
pub mod mid_surface;
pub mod partners;
pub mod seam;
pub mod ties;
pub mod transition;
pub mod wall_tets;
pub mod walls;

pub use coupled_model::{
    build_coupled_model, build_explicit_coupled_model, CoupledModel, CouplingOptions,
    ExplicitCoupledModel, ShellNodeLocator,
};
pub use coupling_set::{CouplingKind, CouplingSet, ALL_DOF_MASK};
pub use error::ShellizeError;
pub use geometry::ShellizeMesh;
pub use mid_surface::{extract_thin_wall_shells, ExtractOptions, ShellExtraction};
pub use ties::{TieCouplingDrop, TieCouplingReport, TieSide, TieSurfaces};
pub use transition::{build_shell_transition_model, ShellTransitionModel};
pub use wall_tets::{shell_body_tets, shell_wall_tets};
pub use walls::{detect_wall_pairs, face_props, FaceProp, Wall};
