// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Maxima and minima of many values that keep a NaN.
//!
//! `f64::max` and `f64::min` return the other operand when one is NaN, so
//! `fold(0.0, f64::max)` turns a NaN into a plausible number: a NaN design
//! change into "converged", a NaN stress into 0. These reductions return NaN
//! instead, so the caller's finiteness check or comparison sees it.

/// The largest of `start` and `values`; NaN when any of them is NaN.
#[must_use]
pub fn largest(start: f64, values: impl IntoIterator<Item = f64>) -> f64 {
    values.into_iter().fold(start, |found, value| {
        if found.is_nan() || value.is_nan() {
            f64::NAN
        } else {
            found.max(value)
        }
    })
}

/// The smallest of `start` and `values`; NaN when any of them is NaN.
#[must_use]
pub fn smallest(start: f64, values: impl IntoIterator<Item = f64>) -> f64 {
    values.into_iter().fold(start, |found, value| {
        if found.is_nan() || value.is_nan() {
            f64::NAN
        } else {
            found.min(value)
        }
    })
}
