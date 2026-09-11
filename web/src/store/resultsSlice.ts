// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Results slice: solver output, solve settings, and the app's stage
// transitions (mode navigation).

import type { SliceCreator } from "./modelStore";

export interface SolverResult {
  displacements: Float64Array;
  vonMises?: Float64Array;
}

export const RESULT_TYPES = [
  "Displacement (magnitude)",
  "Ux",
  "Uy",
  "Uz",
  "Von Mises stress",
] as const;
export type ResultType = (typeof RESULT_TYPES)[number];

export type AppMode =
  "geometry" | "constraints" | "solve" | "optimize" | "results";

// User-chosen colorbar limits, in the units of the displayed result field.
export interface LegendRange {
  min: number;
  max: number;
}

// Which pipeline produced the result currently on display. Both a static solve
// (`result`) and a topology-optimization run (`densityResult`) hand off to
// Results, and a model can carry both at once (solve, then optimize). This
// discriminator records the most recently completed of the two so Results shows
// the run the user just launched, not the older field left in the store.
export type ActiveResult = "static" | "density";

export interface ResultsSlice {
  result: SolverResult | null;
  resultType: ResultType;
  activeResult: ActiveResult;
  isRunning: boolean;
  // FE polynomial order for the solve: 1 = linear, 2 = quadratic (second-order).
  // Quadratic elements resolve bending and stress gradients far better at the
  // cost of more DOFs and a slower solve (issue #215).
  elementOrder: number;
  // Colorbar limits for the displayed field, or null for the field's own
  // min/max. A single stress concentration otherwise takes the whole colour
  // map and flattens everything else to blue, hiding the second-highest
  // stressed region (#390); clamping to a manual range brings it back.
  legendRange: LegendRange | null;
  mode: AppMode;
  hasStarted: boolean;

  setResult(result: SolverResult): void;
  setResultType(t: ResultType): void;
  setRunning(v: boolean): void;
  setElementOrder(order: number): void;
  setLegendRange(range: LegendRange | null): void;

  // Mode navigation
  setMode(mode: AppMode): void;
}

export const createResultsSlice: SliceCreator<ResultsSlice> = (set) => ({
  result: null,
  resultType: "Displacement (magnitude)",
  activeResult: "static",
  isRunning: false,
  // Default to linear: it's fast and reliable for every mesh size. Quadratic is
  // an opt-in upgrade (Solver settings) — far more accurate but ~8× the DOFs.
  elementOrder: 1,
  legendRange: null,
  mode: "geometry",
  hasStarted: false,

  setResult: (result) =>
    set((s) => {
      s.result = result;
      s.resultType = "Displacement (magnitude)";
      s.legendRange = null;
      // A static solve just finished — it, not any earlier density field, is
      // what Results should show.
      s.activeResult = "static";
    }),
  // Switching the field changes both the quantity and its unit, so limits
  // picked for the previous one no longer mean anything — back to auto.
  setResultType: (t) =>
    set((s) => {
      s.resultType = t;
      s.legendRange = null;
    }),
  setRunning: (v) =>
    set((s) => {
      s.isRunning = v;
    }),
  setElementOrder: (order) =>
    set((s) => {
      s.elementOrder = order;
    }),
  setLegendRange: (range) =>
    set((s) => {
      if (
        range !== null &&
        !(
          Number.isFinite(range.min) &&
          Number.isFinite(range.max) &&
          range.max > range.min
        )
      )
        throw new Error(
          `legend range needs finite limits with min < max, got min=${range?.min}, max=${range?.max}`,
        );
      s.legendRange = range;
    }),

  setMode: (mode) =>
    set((s) => {
      s.mode = mode;
    }),
});
