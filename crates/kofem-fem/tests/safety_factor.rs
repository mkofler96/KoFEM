// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The safety factor against yield (KOF-496): the yield strength over the von
//! Mises stress, against the max and a volume-weighted percentile. A model of
//! one material gets one factor over the whole model; a model of several gets
//! one per body whose material has a yield strength. Without a yield strength
//! there is no factor, never one against a default.

use kofem_fem::{safety_factors, ElementMesh, FemError, SafetyInput, SafetyScope};

/// Two tetrahedra on either side of the shared face 0-1-2.
const POINTS: [f64; 15] = [
    0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, -1.0,
];
const TETS: [u32; 8] = [0, 1, 2, 3, 0, 2, 1, 4];

const ELEMENTS: ElementMesh<'static> = ElementMesh {
    points: &POINTS,
    tets: &TETS,
    tet_nodes: 4,
    hexes: &[],
    shell_triangles: &[],
    shell_thicknesses: &[],
};

/// The two tetrahedra at 100 and 50 megapascal, as bodies 0 and 1 of materials
/// `body_materials`, with the yield strengths `yields` by material id.
fn input<'a>(body_materials: &'a [u32], yields: &'a [(u32, f64)]) -> SafetyInput<'a> {
    SafetyInput {
        elements: ELEMENTS,
        von_mises: &[100.0, 50.0],
        element_bodies: &[0, 1],
        body_materials,
        yield_strengths: yields,
    }
}

fn close(actual: f64, expected: f64) -> bool {
    (actual - expected).abs() <= 1e-12 * expected.abs().max(1.0)
}

#[test]
fn several_materials_get_a_factor_per_body_over_its_own_elements() {
    let rows = safety_factors(&input(&[1, 2], &[(1, 250.0), (2, 500.0)]), 0.99).unwrap();
    assert_eq!(rows.len(), 2);
    for (row, (body, material, yield_strength, stress)) in
        rows.iter().zip([(0, 1, 250.0, 100.0), (1, 2, 500.0, 50.0)])
    {
        assert_eq!(row.scope, SafetyScope::Body(body));
        assert_eq!(row.material, material);
        assert_eq!(row.yield_strength, yield_strength);
        assert!(close(row.max, stress), "max {}", row.max);
        assert!(close(row.quantile, stress), "quantile {}", row.quantile);
        assert!(close(row.max_factor, yield_strength / stress));
        assert!(close(row.quantile_factor, yield_strength / stress));
    }
}

#[test]
fn a_body_without_a_yield_strength_gets_no_factor() {
    let rows = safety_factors(&input(&[1, 2], &[(2, 500.0)]), 0.99).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].scope, SafetyScope::Body(1));
}

#[test]
fn one_material_gets_one_factor_over_the_whole_model() {
    let rows = safety_factors(&input(&[1, 1], &[(1, 300.0)]), 0.99).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].scope, SafetyScope::Model);
    // The node only the first tetrahedron touches keeps its 100.
    assert!(close(rows[0].max, 100.0));
    assert!(close(rows[0].max_factor, 3.0));
}

#[test]
fn no_yield_strength_gives_no_factor() {
    assert_eq!(
        safety_factors(&input(&[1, 1], &[]), 0.99).unwrap(),
        Vec::new()
    );
}

#[test]
fn nothing_stressed_is_an_infinite_factor() {
    let rows = safety_factors(
        &SafetyInput {
            von_mises: &[0.0, 0.0],
            ..input(&[1, 1], &[(1, 250.0)])
        },
        0.99,
    )
    .unwrap();
    assert_eq!(rows[0].max_factor, f64::INFINITY);
}

#[test]
fn refuses_a_yield_strength_that_is_not_positive() {
    for wrong in [0.0, -5.0, f64::NAN] {
        let error = safety_factors(&input(&[1, 1], &[(1, wrong)]), 0.99).unwrap_err();
        assert!(
            matches!(error, FemError::SafetyFactorInput { .. }),
            "{error}"
        );
    }
}

#[test]
fn refuses_a_negative_stress() {
    let error = safety_factors(
        &SafetyInput {
            von_mises: &[-1.0, 50.0],
            ..input(&[1, 1], &[(1, 250.0)])
        },
        0.99,
    )
    .unwrap_err();
    assert!(error.to_string().contains("negative"), "{error}");
}

#[test]
fn refuses_an_element_of_a_body_the_model_does_not_have() {
    let error = safety_factors(
        &SafetyInput {
            element_bodies: &[0, 2],
            ..input(&[1, 1], &[(1, 250.0)])
        },
        0.99,
    )
    .unwrap_err();
    assert!(error.to_string().contains("body 2"), "{error}");
}
