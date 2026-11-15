// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Loading of the Rust finite-element module (crates/kofem-wasm, built into
// src/wasm/fem by scripts/build-fem-wasm.sh). Its functions are synchronous
// once the module is instantiated, so the solver worker awaits this together
// with the engine before it reports the engine ready.

import initFem from "../wasm/fem/kofem_wasm.js";

/** The step of the Rust module's load that failed, as the engine names its own. */
export type FemLoadStage = "download" | "compile" | "instantiate";

export class FemLoadError extends Error {
  constructor(
    readonly stage: FemLoadStage,
    detail: string,
  ) {
    super(`The Rust finite-element module failed to load: ${detail}`);
    this.name = "FemLoadError";
  }
}

// wasm-bindgen's init fetches, compiles and instantiates in one call; the
// error type says which step threw.
function stageOf(error: unknown): FemLoadStage {
  if (error instanceof WebAssembly.CompileError) return "compile";
  if (
    error instanceof WebAssembly.LinkError ||
    error instanceof WebAssembly.RuntimeError
  )
    return "instantiate";
  return "download";
}

let loading: Promise<void> | undefined;

export function loadFemModule(): Promise<void> {
  loading ??= initFem().then(
    () => undefined,
    (error: unknown) => {
      // A later call tries again rather than repeating this failure.
      loading = undefined;
      throw new FemLoadError(
        stageOf(error),
        error instanceof Error ? error.message : String(error),
      );
    },
  );
  return loading;
}
