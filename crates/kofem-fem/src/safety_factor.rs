// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The safety factor against yield (KOF-496): a material's yield strength
//! over the von Mises stress, against the max and a volume-weighted
//! percentile. Per body, the stress is averaged over the body's own elements,
//! so a stiff body's stress does not leak into a soft neighbour.

use std::collections::BTreeSet;

use crate::error::FemError;
use crate::field_statistics::{grouped_element_statistics, ElementMesh};

/// A result's von Mises stress and what each element is made of.
#[derive(Debug, Clone, Copy)]
pub struct SafetyInput<'a> {
    pub elements: ElementMesh<'a>,
    /// One per element: tetrahedra, then hexahedra, then shell facets.
    pub von_mises: &'a [f64],
    /// Each element's body, an index into `body_materials`; same order.
    pub element_bodies: &'a [u32],
    /// Each body's material id.
    pub body_materials: &'a [u32],
    /// `(material id, yield strength in MPa)` of each material that has one.
    pub yield_strengths: &'a [(u32, f64)],
}

/// What one safety factor is taken over.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SafetyScope {
    /// Every element: the model is of one material.
    Model,
    /// The elements of one body, by its index.
    Body(usize),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SafetyFactor {
    pub scope: SafetyScope,
    pub material: u32,
    pub yield_strength: f64,
    pub max: f64,
    pub quantile: f64,
    pub max_factor: f64,
    pub quantile_factor: f64,
}

fn invalid(reason: String) -> FemError {
    FemError::SafetyFactorInput { reason }
}

/// The yield strength over the stress; infinite where nothing is stressed.
fn factor(yield_strength: f64, stress: f64) -> f64 {
    if stress == 0.0 {
        f64::INFINITY
    } else {
        yield_strength / stress
    }
}

fn check(input: &SafetyInput<'_>) -> Result<(), FemError> {
    if input.element_bodies.len() != input.von_mises.len() {
        return Err(invalid(format!(
            "{} bodies for {} von Mises values",
            input.element_bodies.len(),
            input.von_mises.len()
        )));
    }
    if let Some(&body) = input
        .element_bodies
        .iter()
        .find(|&&body| body as usize >= input.body_materials.len())
    {
        return Err(invalid(format!(
            "an element is in body {body}, but the model has {} bodies",
            input.body_materials.len()
        )));
    }
    if let Some(stress) = input.von_mises.iter().find(|&&stress| stress < 0.0) {
        return Err(invalid(format!(
            "a von Mises stress cannot be negative, got {stress}"
        )));
    }
    let mut seen = BTreeSet::new();
    for &(material, yield_strength) in input.yield_strengths {
        if !seen.insert(material) {
            return Err(invalid(format!(
                "material {material} has more than one yield strength"
            )));
        }
        if !yield_strength.is_finite() || yield_strength <= 0.0 {
            return Err(invalid(format!(
                "material {material} has the yield strength {yield_strength}, which is not a positive number"
            )));
        }
    }
    Ok(())
}

/// The safety factors of a result: one over the whole model when every
/// element is of one material, else one per body whose material has a yield
/// strength, in body order. Empty when no material in use has one.
///
/// # Errors
/// [`FemError::SafetyFactorInput`] for a body count that differs from the
/// value count, an element of an unknown body, a negative stress, or a yield
/// strength that is not positive or given twice;
/// [`FemError::StatisticsInput`] for the element checks of
/// [`grouped_element_statistics`].
pub fn safety_factors(
    input: &SafetyInput<'_>,
    quantile: f64,
) -> Result<Vec<SafetyFactor>, FemError> {
    check(input)?;
    let yield_of = |material: u32| {
        input
            .yield_strengths
            .iter()
            .find(|(id, _)| *id == material)
            .map(|&(_, yield_strength)| yield_strength)
    };
    let bodies: BTreeSet<usize> = input
        .element_bodies
        .iter()
        .map(|&body| body as usize)
        .collect();
    let materials: BTreeSet<u32> = bodies
        .iter()
        .map(|&body| input.body_materials[body])
        .collect();
    // (scope, material, yield strength) of each factor.
    let scopes: Vec<(SafetyScope, u32, f64)> = match Vec::from_iter(materials)[..] {
        [material] => yield_of(material)
            .map(|yield_strength| (SafetyScope::Model, material, yield_strength))
            .into_iter()
            .collect(),
        _ => bodies
            .iter()
            .filter_map(|&body| {
                let material = input.body_materials[body];
                yield_of(material)
                    .map(|yield_strength| (SafetyScope::Body(body), material, yield_strength))
            })
            .collect(),
    };
    let too_many = || {
        invalid(format!(
            "{} bodies are more than a u32 counts",
            scopes.len()
        ))
    };
    // Each element's group: its factor's index, or one past the last for an
    // element of a body without a yield strength.
    let none = u32::try_from(scopes.len()).map_err(|_| too_many())?;
    let groups = input
        .element_bodies
        .iter()
        .map(|&body| {
            scopes
                .iter()
                .position(|(scope, _, _)| match scope {
                    SafetyScope::Model => true,
                    SafetyScope::Body(of) => *of == body as usize,
                })
                .map_or(Ok(none), |at| u32::try_from(at).map_err(|_| too_many()))
        })
        .collect::<Result<Vec<u32>, FemError>>()?;
    if scopes.is_empty() {
        return Ok(Vec::new());
    }
    // Elements of bodies without a yield strength form one more group, whose
    // statistics are not read.
    let ungrouped = groups.iter().any(|&group| group as usize == scopes.len());
    let statistics = grouped_element_statistics(
        &input.elements,
        input.von_mises,
        &groups,
        scopes.len() + usize::from(ungrouped),
        quantile,
    )?;
    Ok(scopes
        .iter()
        .zip(statistics)
        .map(|(&(scope, material, yield_strength), stats)| SafetyFactor {
            scope,
            material,
            yield_strength,
            max: stats.max,
            quantile: stats.quantile,
            max_factor: factor(yield_strength, stats.max),
            quantile_factor: factor(yield_strength, stats.quantile),
        })
        .collect())
}
