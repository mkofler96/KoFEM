// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! What a [`FemError`] means for the user (KOF-490). The browser bindings send
//! the class next to the message, so the app says what to change and counts
//! the failure without reading the message.

use crate::FemError;

/// The `what` of the [`FemError::NonFinite`] the Newton solve raises for its
/// own internal force: a result, where every other `what` names an input.
pub const INTERNAL_FORCE: &str = "an internal force component";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureClass {
    InvalidInput,
    DegenerateElement,
    ResourceLimit,
    UnsupportedModel,
    /// A malformed payload from the app: a bug in KoFEM, not in the model.
    Internal,
    Numerical(NumericalReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NumericalReason {
    SingularMatrix,
    NotConverged,
    NewtonNotConverged,
    UnstableTangent,
    InvertedElement,
    NonFiniteResult,
}

impl FailureClass {
    #[must_use]
    pub fn category(self) -> &'static str {
        match self {
            Self::InvalidInput => "invalid_input",
            Self::DegenerateElement => "degenerate_element",
            Self::ResourceLimit => "resource_limit",
            Self::UnsupportedModel => "unsupported_model",
            Self::Internal => "internal",
            Self::Numerical(_) => "numerical",
        }
    }

    #[must_use]
    pub fn reason(self) -> Option<&'static str> {
        match self {
            Self::Numerical(reason) => Some(match reason {
                NumericalReason::SingularMatrix => "singular_matrix",
                NumericalReason::NotConverged => "not_converged",
                NumericalReason::NewtonNotConverged => "newton_not_converged",
                NumericalReason::UnstableTangent => "unstable_tangent",
                NumericalReason::InvertedElement => "inverted_element",
                NumericalReason::NonFiniteResult => "non_finite_result",
            }),
            _ => None,
        }
    }
}

impl FemError {
    #[must_use]
    pub fn class(&self) -> FailureClass {
        use FailureClass::{
            DegenerateElement, Internal, InvalidInput, Numerical, ResourceLimit, UnsupportedModel,
        };
        use NumericalReason::{
            InvertedElement, NewtonNotConverged, NonFiniteResult, NotConverged, SingularMatrix,
            UnstableTangent,
        };
        match self {
            Self::NotPositiveDefinite { .. } | Self::CoarseNotPositiveDefinite { .. } => {
                Numerical(SingularMatrix)
            }
            Self::NotConverged { .. } | Self::TangentSolve { .. } => Numerical(NotConverged),
            Self::NewtonNotConverged { .. } => Numerical(NewtonNotConverged),
            Self::TangentNotPositiveDefinite { .. } => Numerical(UnstableTangent),
            Self::InvertedElement { .. } => Numerical(InvertedElement),
            Self::NonFiniteStress { .. } => Numerical(NonFiniteResult),
            Self::NonFinite { what, .. } if *what == INTERNAL_FORCE => Numerical(NonFiniteResult),
            Self::DegenerateTet { .. }
            | Self::DegenerateHex { .. }
            | Self::DegenerateTriangle { .. } => DegenerateElement,
            Self::TooManyNodes { .. } => ResourceLimit,
            Self::ShellOnQuadraticMesh => UnsupportedModel,
            Self::YoungsModulus { .. }
            | Self::PoissonRatio { .. }
            | Self::EmptyMesh
            | Self::ConflictingConstraint { .. }
            | Self::ConstraintOnUnusedVertex { .. }
            | Self::LoadOnUnusedVertex { .. }
            | Self::NonFinite { .. }
            | Self::InvalidSettings { .. }
            | Self::SurfaceLoadUnmatched { .. }
            | Self::SurfaceLoadArea { .. }
            | Self::Coupling { .. }
            | Self::CouplingInput { .. }
            | Self::Tie { .. }
            | Self::CouplingDofConflict { .. }
            | Self::CouplingCycle { .. }
            | Self::ConstraintOnCoupledDof { .. }
            | Self::RotationWithoutDof { .. }
            | Self::LoadWithoutStiffness { .. }
            | Self::EmptyShellMesh
            | Self::Thickness { .. }
            | Self::Contact { .. }
            | Self::ContactUnheld { .. }
            | Self::PartialHexTetInterface { .. } => InvalidInput,
            Self::VertexArrayLength { .. }
            | Self::TetArrayLength { .. }
            | Self::VertexOutOfRange { .. }
            | Self::MaterialIdCount { .. }
            | Self::MaterialOutOfRange { .. }
            | Self::HexArrayLength { .. }
            | Self::HexVertexOutOfRange { .. }
            | Self::HexMaterialOutOfRange { .. }
            | Self::ConnectivityLength { .. }
            | Self::ReactionInput { .. }
            | Self::ReportField { .. }
            | Self::ReducedSystem
            | Self::DofOutOfRange { .. }
            | Self::ConstraintValueCount { .. }
            | Self::ForceLength { .. }
            | Self::DisplacementLength { .. }
            | Self::AmgInput { .. }
            | Self::SectionInput { .. }
            | Self::StatisticsInput { .. }
            | Self::SafetyFactorInput { .. }
            | Self::RigidBodyInput { .. }
            | Self::TriangleArrayLength { .. }
            | Self::TriangleVertexOutOfRange { .. }
            | Self::ThicknessCount { .. }
            | Self::ShellMaterialIdCount { .. }
            | Self::ShellMaterialOutOfRange { .. }
            | Self::ExpansionCoefficientCount { .. }
            | Self::TemperatureCount { .. }
            | Self::ElementOutOfRange { .. }
            | Self::TopologyInput { .. }
            | Self::Convergence { .. }
            | Self::NewtonUnfinished { .. }
            | Self::NonlinearInput { .. } => Internal,
        }
    }
}
