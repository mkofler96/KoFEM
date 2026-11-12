// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Drive a resumable CG solve from the Rust finite-element module
// (crates/kofem-wasm SolveRun) to convergence: log progress, hand control back
// to the worker's event loop now and then, and when the iteration budget runs
// out either ask the user to continue (residual still falling) or fail
// (stalled) — the MFEM engine's continuation policy
// (engine/cpp/cg_continuation.h). Shared by the solid (AMG) and shell solves.

import type { CgLimitProgress } from "../../wasm/pkg/kofem_wasm.js";

// Asked when the iteration budget runs out while the residual is still
// falling: resolves to the number of extra iterations, or 0 to stop. The
// worker routes it to the same "continue solving?" dialog as the MFEM path.
export type ContinuationPrompt = (progress: CgLimitProgress) => Promise<number>;

// The part of the Rust module's SolveRun this loop drives.
export interface CgRun {
  readonly iterations: number;
  readonly relativeResidual: number;
  readonly tolerance: number;
  advance(steps: number): boolean;
  stillDescending(window: number): boolean;
}

export interface CgRunOptions {
  // Iterations before the user is first asked to continue.
  initialBudget: number;
  // Progress is logged every this many iterations.
  logEvery: number;
  // Prefix of the progress lines, e.g. "[amg]".
  tag: string;
  // performance.now() when the solve started, for the elapsed time.
  started: number;
}

// How long the solve may run without handing control back to the worker's
// event loop, so messages (a continuation answer) are never starved.
const YIELD_AFTER_MS = 200;

export async function iterateToConvergence(
  run: CgRun,
  { initialBudget, logEvery, tag, started }: CgRunOptions,
  askToContinue: ContinuationPrompt,
  log: (line: string) => void,
): Promise<void> {
  if (!Number.isSafeInteger(initialBudget) || initialBudget <= 0)
    throw new Error(
      `The CG iteration limit must be a positive integer, got ${initialBudget}`,
    );
  // The C++ engine's window: half the first budget, between 2 and 100.
  const window = Math.min(100, Math.max(2, Math.floor(initialBudget / 2)));
  let limit = initialBudget;
  let budget = initialBudget;
  let waitedMs = 0;
  let lastYield = performance.now();
  for (;;) {
    // Stop at the next multiple of logEvery (or the budget), so progress
    // lines keep their cadence after a pause at an arbitrary budget.
    const steps = Math.min(
      logEvery - (run.iterations % logEvery),
      limit - run.iterations,
    );
    const converged = run.advance(steps);
    if (converged) return;
    if (run.iterations % logEvery === 0)
      log(
        `${tag} CG iteration ${String(run.iterations).padStart(4)}: relative residual ${run.relativeResidual.toExponential(3)}`,
      );
    if (run.iterations >= limit) {
      if (!run.stillDescending(window))
        throw new Error(
          `CG did not converge: relative residual ${run.relativeResidual.toExponential(3)} ` +
            `after ${run.iterations} iterations (target ${run.tolerance.toExponential(0)}) ` +
            "and is no longer improving. The partial result was discarded — check that the " +
            "model is fully constrained, or refine the mesh.",
        );
      const asked = performance.now();
      const extra = await askToContinue({
        iterations: run.iterations,
        relativeResidual: run.relativeResidual,
        target: run.tolerance,
        elapsedSeconds: (asked - started - waitedMs) / 1000,
        suggestedIterations: budget,
      });
      waitedMs += performance.now() - asked;
      lastYield = performance.now();
      if (extra === 0)
        throw new Error(
          "Solve stopped by user. The partial result was discarded.",
        );
      if (!Number.isSafeInteger(extra) || extra < 0 || extra > 1_000_000)
        throw new Error(
          "Extra CG iterations must be an integer from 1 to 1000000",
        );
      log(`Continuing the solve for ${extra} more iterations…`);
      budget = extra;
      limit += extra;
    } else if (performance.now() - lastYield >= YIELD_AFTER_MS) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  }
}
