// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Kirchhoff (shear-free) flat-facet shells: OPT drilling membrane + DKT
//! bending per triangle, 6 DOFs per node (u, v, w, θx, θy, θz), with a
//! thickness and a material per facet. The DKT enforces the Kirchhoff
//! constraint discretely, so the element needs only the C⁰ triangle meshes the
//! surface mesher produces. The solve and the DKT bending are ports of the C++
//! engine's pure-shell solve (`shell_core.cpp`, `shell_element.cpp`,
//! `solve_shell.cpp`); the membrane is not (KOF-453): the C++ CST membrane
//! with a fictitious drilling spring locked curved shells.

pub mod assembly;
pub mod element;
pub mod membrane;
pub mod mesh;
pub mod solve;
pub mod stress;

pub use assembly::{assemble_shell_stiffness, SHELL_NODE_DOFS};
pub use element::facet_stiffness;
pub use mesh::{ShellMesh, MAX_SHELL_VERTICES};
pub use solve::{
    prepare_shell_static, shell_translations, solve_shell_static, PreparedShell,
    ShellPreconditioner, ShellSolution,
};
pub use stress::{
    shell_corner_stress_tensors, shell_stress_tensors, shell_von_mises, ShellSurface,
};
