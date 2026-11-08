// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

use thiserror::Error;

/// Every way the shell idealisation refuses its input or its result. The
/// user-facing variants keep the wording of the TypeScript pipeline they
/// replace, so the app shows the same sentence whichever side produced it.
#[derive(Debug, Error, PartialEq)]
pub enum ShellizeError {
    #[error("{what} has {len} values, which is not a multiple of {stride}")]
    ArrayLength {
        what: &'static str,
        len: usize,
        stride: usize,
    },
    #[error("{what} has {len} entries, but {expected} were expected")]
    ArrayCount {
        what: &'static str,
        len: usize,
        expected: usize,
    },
    #[error("{what} references vertex {vertex}, but the mesh has {count} vertices")]
    VertexOutOfRange {
        what: &'static str,
        vertex: usize,
        count: usize,
    },
    #[error("a non-finite value ({value}) was given for {what}")]
    NonFinite { what: &'static str, value: f64 },
    #[error("{what} must be positive and finite, got {value}")]
    NotPositive { what: &'static str, value: f64 },
    #[error("mid-surface offset asked for unknown wall face {face}")]
    UnknownWallFace { face: i32 },
    #[error(
        "Body {body} is marked \"Shell\", but {lost} of its {total} elements ({percent:.1} % of \
         its volume) lie outside every flat thin wall the shell idealisation found — a curved or \
         small face, or a thick block, that the shells would drop. Split that part into a body of \
         its own and keep it Solid, or set the body to Solid."
    )]
    UncoveredShellBody {
        body: i32,
        lost: usize,
        total: usize,
        percent: f64,
    },
    #[error("Degenerate shell triangle at transition")]
    DegenerateShellTriangle,
    #[error(
        "A tie connection overlaps the shell/solid transition. Reverse its master and slave \
         surfaces or keep the body Solid."
    )]
    TieOverlapsTransition,
    #[error(
        "A shell/solid transition node is prescribed. Move the support away from the transition \
         or keep the body Solid."
    )]
    PrescribedTransitionNode,
    #[error("Shell body is too short to retain its solid joint sections. Keep this body Solid.")]
    ShellTooShort,
    #[error(
        "The retained solid joint could not be connected to the shell footprint. Keep this body \
         Solid."
    )]
    FootprintNotConnected,
    #[error(
        "shellNodeLocator: no shell mid-surface node found within {radius} units of query point \
         ({point_x}, {point_y}, {point_z}) — a boundary condition or load on the shelled body could not be mapped \
         onto the shell mesh. The node may lie farther from any thin wall than the search radius, \
         or the model may be mis-scaled."
    )]
    NoShellNodeNear {
        radius: f64,
        point_x: f64,
        point_y: f64,
        point_z: f64,
    },
    #[error("internal shell idealisation error: {reason}")]
    Internal { reason: &'static str },
    #[error("coupling set is malformed: {reason}")]
    MalformedCoupling { reason: &'static str },
}
