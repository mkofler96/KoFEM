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

export interface ResultsSlice {
  result: SolverResult | null;
  resultType: ResultType;
  isRunning: boolean;
  // FE polynomial order for the solve: 1 = linear, 2 = quadratic (second-order).
  // Quadratic elements resolve bending and stress gradients far better at the
  // cost of more DOFs and a slower solve (issue #215).
  elementOrder: number;
  mode: AppMode;
  hasStarted: boolean;

  setResult(result: SolverResult): void;
  setResultType(t: ResultType): void;
  setRunning(v: boolean): void;
  setElementOrder(order: number): void;

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
  mode: "geometry",
  hasStarted: false,

  setResult: (result) =>
    set((s) => {
      s.result = result;
      s.resultType = "Displacement (magnitude)";
    }),
  setResultType: (t) =>
    set((s) => {
      s.resultType = t;
    }),
  setRunning: (v) =>
    set((s) => {
      s.isRunning = v;
    }),
  setElementOrder: (order) =>
    set((s) => {
      s.elementOrder = order;
    }),

  setMode: (mode) =>
    set((s) => {
      s.mode = mode;
    }),
});
