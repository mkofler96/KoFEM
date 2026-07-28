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

export type AppMode = "geometry" | "constraints" | "solve" | "results";

// User-chosen colorbar limits, in the units of the displayed result field.
export interface LegendRange {
  min: number;
  max: number;
}

export interface ResultsSlice {
  result: SolverResult | null;
  resultType: ResultType;
  isRunning: boolean;
  // FE polynomial order for the solve: 1 = linear, 2 = quadratic (second-order).
  // Quadratic elements resolve bending and stress gradients far better at the
  // cost of more DOFs and a slower solve (issue #215).
  elementOrder: number;
  // Bonded-tie detection distance (mm) for multibody assemblies (#359): parts
  // that touch without a shared face (e.g. a pin in a hook eye — a line
  // contact) are joined by welding near-contact nodes of different bodies
  // within this distance. 0 disables the tie.
  tieDistance: number;
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
  setTieDistance(distance: number): void;
  setLegendRange(range: LegendRange | null): void;

  // Mode navigation
  setMode(mode: AppMode): void;
}

export const createResultsSlice: SliceCreator<ResultsSlice> = (set) => ({
  result: null,
  resultType: "Displacement (magnitude)",
  isRunning: false,
  // Default to linear: it's fast and reliable for every mesh size. Quadratic is
  // an opt-in upgrade (Solver settings) — far more accurate but ~8× the DOFs.
  elementOrder: 1,
  tieDistance: 0,
  legendRange: null,
  mode: "geometry",
  hasStarted: false,

  setResult: (result) =>
    set((s) => {
      s.result = result;
      s.resultType = "Displacement (magnitude)";
      s.legendRange = null;
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
  setTieDistance: (distance) =>
    set((s) => {
      s.tieDistance = Math.max(0, distance);
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
