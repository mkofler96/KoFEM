// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// What a failed call into the Rust module means for the user (KOF-454).
//
// A call that traps (the module ran out of memory, or panicked) stops in the
// middle, and wasm-bindgen leaves the object it was called on borrowed. Its
// free() then throws "attempted to take ownership of Rust value while it was
// borrowed", which in a `finally` would replace the trap on its way out.
// `release` frees an object without letting that happen, and
// `explainRustFailure` turns the trap into a message the user can act on.

/** A wasm-bindgen object that owns memory in the Rust module. */
export interface Freeable {
  free(): void;
}

// wasm-bindgen's message when free() meets an object a call still borrows.
const STILL_BORROWED =
  "attempted to take ownership of Rust value while it was borrowed";

/**
 * Free `owned`, for a `finally` around calls into the Rust module. An object
 * still borrowed was left so by a call that trapped; that trap is already on
 * its way to the user and the module cannot reclaim the object anyway, so the
 * second error is dropped instead of replacing the first. Any other failure
 * to free is thrown.
 */
export function release(owned: Freeable): void {
  try {
    owned.free();
  } catch (err) {
    if (err instanceof Error && err.message.includes(STILL_BORROWED)) return;
    throw err;
  }
}

export const OUT_OF_MEMORY_MESSAGE =
  "The solver ran out of memory. Use a coarser mesh, or linear elements instead of quadratic ones, and solve again.";

// The `unreachable` trap as Chrome, Firefox and Safari word it.
const UNREACHABLE = /unreachable/i;
// The browser refusing memory on the JavaScript side, e.g. for a result array
// copied out of the module.
const JS_OUT_OF_MEMORY =
  /out of memory|Array buffer allocation failed|Maximum memory size exceeded/i;

/**
 * The error to show for `err`, thrown by a call into the Rust module. Panics
 * and allocation failures both end in an `unreachable` trap; the module
 * records a panic's message (crates/kofem-wasm/src/failure.rs), so
 * `takePanicMessage` tells them apart: a message names a bug, none means the
 * module ran out of memory. Every other error is returned unchanged.
 */
export function explainRustFailure(
  err: unknown,
  takePanicMessage: () => string | undefined,
): unknown {
  if (err instanceof RangeError && JS_OUT_OF_MEMORY.test(err.message))
    return new Error(OUT_OF_MEMORY_MESSAGE, { cause: err });
  if (
    !(err instanceof WebAssembly.RuntimeError) ||
    !UNREACHABLE.test(err.message)
  )
    return err;
  const panic = takePanicMessage();
  return new Error(
    panic === undefined
      ? OUT_OF_MEMORY_MESSAGE
      : `The Rust solver stopped on an internal error (a bug, please report it): ${panic}`,
    { cause: err },
  );
}
