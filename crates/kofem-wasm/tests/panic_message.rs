// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! In the browser a Rust panic and an allocation failure both stop the module
//! with the same `unreachable` trap. The module records a panic's message, so
//! the app can tell the two apart (KOF-454): a trap with a message is a bug,
//! a trap without one ran out of memory.

use kofem_wasm::{record_panics, take_panic_message};

#[test]
fn a_panic_leaves_its_message_and_taking_it_clears_it() {
    record_panics();
    assert_eq!(take_panic_message(), None);

    let outcome = std::panic::catch_unwind(|| {
        let empty: Vec<f64> = Vec::new();
        let index = empty.len() + 3;
        empty[index]
    });

    assert!(outcome.is_err());
    let message = take_panic_message().unwrap_or_default();
    assert!(
        message.contains("index out of bounds"),
        "recorded message: {message}"
    );
    assert_eq!(take_panic_message(), None);
}
