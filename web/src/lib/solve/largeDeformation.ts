// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Large deformation (KOF-486): the solid solve with the elements as
// compressible Neo-Hookean solids (crates/kofem-fem/src/hyperelastic.rs),
// the loads applied over load increments, each solved by Newton's method in
// the Rust module (crates/kofem-wasm LargeDeformationRun). This drives the run
// to convergence, logging each Newton iteration as it finishes and handing
// control back to the worker's event loop now and then.

import type {
  ElasticModel,
  LargeDeformationSolution,
  SolveOptions,
} from "../../wasm/fem/kofem_wasm.js";
import type { LargeDeformation } from "../../workers/solverTypes.js";
import { release } from "./rustFailure.js";

// The load increments a new analysis starts with.
export const DEFAULT_LOAD_INCREMENTS = 10;

// The most load increments the Solve panel offers: past this, more increments
// stop helping a Newton iteration that does not converge.
export const MAX_LOAD_INCREMENTS = 100;

export function isLoadIncrementCount(count: number): boolean {
  return Number.isInteger(count) && count >= 1 && count <= MAX_LOAD_INCREMENTS;
}

// What a solve request carries for the Solve panel's large-deformation
// option and increment count: null while the option is off.
export function largeDeformationSetting(
  on: boolean,
  increments: number,
): LargeDeformation | null {
  return on ? { increments } : null;
}

// Newton iterations allowed per increment. Near the solution each iteration
// squares the error, so an increment that has not converged in this many is
// too large or past a limit load; the error says which increment it was.
const NEWTON_ITERATION_LIMIT = 30;

// CG iterations between checks of the clock.
const CG_STEP = 50;

// How long the solve may run without handing control back to the worker's
// event loop.
const YIELD_AFTER_MS = 200;

// Solve `elastic` with large deformation over `increments` load increments;
// `options` sets each correction's tolerance, preconditioner and CG budget,
// and the tolerance of the out-of-balance force. The caller frees the
// solution.
export async function runLargeDeformationSolve(
  elastic: ElasticModel,
  fixedDofs: Uint32Array,
  fixedValues: Float64Array,
  forces: Float64Array,
  options: SolveOptions,
  increments: number,
  log: (line: string) => void,
): Promise<LargeDeformationSolution> {
  const run = elastic.startLargeDeformationSolve(
    fixedDofs,
    fixedValues,
    forces,
    options,
    increments,
    NEWTON_ITERATION_LIMIT,
  );
  let finished = false;
  try {
    let lastYield = performance.now();
    for (;;) {
      const converged = run.advance(CG_STEP);
      if (converged) {
        finished = true;
        return run.finish();
      }
      if (run.iterated)
        log(
          `Increment ${run.increment}/${run.increments} (load factor ${(run.increment / run.increments).toFixed(3)}), Newton iteration ${run.iteration}: residual ${run.relativeResidual.toExponential(2)}`,
        );
      if (performance.now() - lastYield >= YIELD_AFTER_MS) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        lastYield = performance.now();
      }
    }
  } finally {
    // finish() consumes the run; free it only when it was not reached.
    if (!finished) release(run);
  }
}
