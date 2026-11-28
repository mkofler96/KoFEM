// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! What each kind of `FemError` means for the user (KOF-490): the class the
//! browser bindings send next to the message, so the app can say what to
//! change and count the failure without reading its text.

use kofem_fem::{FailureClass, FemError, NumericalReason, INTERNAL_FORCE};

#[test]
fn a_singular_stiffness_matrix_is_numerical() {
    for error in [
        FemError::NotPositiveDefinite { iteration: 3 },
        FemError::CoarseNotPositiveDefinite { unknowns: 315 },
    ] {
        assert_eq!(
            error.class(),
            FailureClass::Numerical(NumericalReason::SingularMatrix)
        );
    }
}

#[test]
fn each_nonlinear_failure_has_its_own_reason() {
    let cases = [
        (
            FemError::TangentNotPositiveDefinite {
                increment: 3,
                increments: 4,
                load_factor: 0.75,
            },
            NumericalReason::UnstableTangent,
        ),
        (
            FemError::NewtonNotConverged {
                increment: 1,
                increments: 1,
                iterations: 30,
                relative_residual: 0.1,
                target: 1e-6,
            },
            NumericalReason::NewtonNotConverged,
        ),
        (
            FemError::InvertedElement {
                element: 0,
                jacobian: -1.0,
            },
            NumericalReason::InvertedElement,
        ),
        (
            FemError::TangentSolve {
                increment: 1,
                iteration: 2,
                reason: "CG did not converge".to_owned(),
            },
            NumericalReason::NotConverged,
        ),
    ];
    for (error, reason) in cases {
        assert_eq!(error.class(), FailureClass::Numerical(reason), "{error}");
    }
}

#[test]
fn a_non_finite_internal_force_is_a_result_and_a_non_finite_load_is_input() {
    let result = FemError::NonFinite {
        what: INTERNAL_FORCE,
        value: f64::NAN,
    };
    assert_eq!(
        result.class(),
        FailureClass::Numerical(NumericalReason::NonFiniteResult)
    );
    let input = FemError::NonFinite {
        what: "a force component",
        value: f64::NAN,
    };
    assert_eq!(input.class(), FailureClass::InvalidInput);
}

#[test]
fn the_model_and_the_app_are_told_apart() {
    assert_eq!(
        FemError::DegenerateTet { tet: 4 }.class(),
        FailureClass::DegenerateElement
    );
    assert_eq!(
        FemError::LoadOnUnusedVertex { vertex: 2 }.class(),
        FailureClass::InvalidInput
    );
    assert_eq!(
        FemError::TooManyNodes { count: 9, max: 4 }.class(),
        FailureClass::ResourceLimit
    );
    assert_eq!(
        FemError::ShellOnQuadraticMesh.class(),
        FailureClass::UnsupportedModel
    );
    assert_eq!(
        FemError::VertexArrayLength { len: 7 }.class(),
        FailureClass::Internal
    );
}

/// KOF-433: a hex face that tets meet on one half only is the user's mesh to
/// fix.
#[test]
fn a_partial_hex_tet_interface_is_the_users_mesh_to_fix() {
    assert_eq!(
        FemError::PartialHexTetInterface {
            hex: 3,
            face: 1,
            triangles: 1
        }
        .class(),
        FailureClass::InvalidInput
    );
}

#[test]
fn the_class_reaches_the_browser_as_a_category_and_a_reason() {
    let singular = FailureClass::Numerical(NumericalReason::SingularMatrix);
    assert_eq!(singular.category(), "numerical");
    assert_eq!(singular.reason(), Some("singular_matrix"));
    assert_eq!(FailureClass::InvalidInput.category(), "invalid_input");
    assert_eq!(FailureClass::InvalidInput.reason(), None);
}
