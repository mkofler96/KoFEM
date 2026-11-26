// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

use kofem_fem::count_as_f64;
use kofem_fem::mesh::MAX_NODES;

#[test]
fn small_counts_convert_exactly() {
    assert_eq!(count_as_f64(0), 0.0);
    assert_eq!(count_as_f64(8), 8.0);
    assert_eq!(count_as_f64(400), 400.0);
}

#[test]
fn the_largest_mesh_count_converts_exactly() {
    let degrees_of_freedom = 3 * MAX_NODES;
    assert_eq!(count_as_f64(degrees_of_freedom), f64::from(u32::MAX));
}
