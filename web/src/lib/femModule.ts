// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Loading of the Rust finite-element module (crates/kofem-wasm, built into
// src/wasm/fem by scripts/build-fem-wasm.sh). Its functions are synchronous
// once the module is instantiated, so the solver worker awaits this together
// with the engine before it handles a request.

import initFem from "../wasm/fem/kofem_wasm.js";

let loading: Promise<void> | undefined;

export function loadFemModule(): Promise<void> {
  loading ??= initFem().then(
    () => undefined,
    (error: unknown) => {
      loading = undefined;
      throw new Error(
        `The Rust finite-element module failed to load: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  );
  return loading;
}
