// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Telling a panic from an allocation failure (KOF-454). On
//! `wasm32-unknown-unknown` both abort the call with the same `unreachable`
//! trap, and an allocation failure runs no hook a stable crate can set. So the
//! module records each panic's message: after a trap, a recorded message names
//! a bug, and no message means the module ran out of memory.

use std::sync::Mutex;

use wasm_bindgen::prelude::*;

/// The message of the last panic not yet taken.
static LAST_PANIC: Mutex<Option<String>> = Mutex::new(None);

/// Record every panic's message for `take_panic_message`, then run the hook
/// that was set before. Runs when the module is instantiated.
#[wasm_bindgen(start)]
pub fn record_panics() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = info.payload_as_str().map_or_else(
            || info.to_string(),
            |text| match info.location() {
                Some(location) => format!("{text} ({location})"),
                None => text.to_owned(),
            },
        );
        *LAST_PANIC
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(message);
        previous(info);
    }));
}

/// The message of the last panic since the previous call, if there was one.
#[wasm_bindgen(js_name = takePanicMessage)]
#[must_use]
pub fn take_panic_message() -> Option<String> {
    LAST_PANIC
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take()
}
