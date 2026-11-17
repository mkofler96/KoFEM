// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Results slice: solver output, solve settings, and the app's stage
// transitions (mode navigation).

import type { SliceCreator } from "./modelStore";
import type { HandCheck } from "../lib/handCheck";
import type { ResultProbe } from "../lib/resultProbe";
import { modeSelection, applyTreeSelection } from "./viewSlice";
import { ensurePlot } from "./studySlice";
import { DEFAULT_SOLVER_METHOD, type SolverMethod } from "../lib/solve/amg";

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
  // CG preconditioner for static solves (Solve panel). AMG is the default; it
  // covers all-solid tet and hex models of order 1 or 2, as Gauss–Seidel in
  // Rust does. Others fall back to amgFallbackPreconditioner (incomplete
  // Cholesky or Gauss–Seidel).
  solverMethod: SolverMethod;
  // Colorbar limits for the displayed field, or null for the field's own
  // min/max. A single stress concentration otherwise takes the whole colour
  // map and flattens everything else to blue, hiding the second-highest
  // stressed region (#390); clamping to a manual range brings it back.
  legendRange: LegendRange | null;
  mode: AppMode;
  hasStarted: boolean;
  // The closed-form check the loaded example carries (KOF-261), shown beside
  // its result. Null for any model the user built or imported.
  handCheck: HandCheck | null;
  // Points the user clicked on the result to read it (KOF-389). A probe on a
  // CAD face is kept through a re-mesh and read on the new mesh; one on a
  // triangle without a CAD face goes with its mesh.
  probes: ResultProbe[];
  nextProbeId: number;
  // Whether a click on the result places a probe.
  probing: boolean;
  // Whether the min and max probes mark where the plotted field peaks.
  showExtremeProbes: boolean;

  setResult(result: SolverResult): void;
  setResultType(t: ResultType): void;
  setRunning(v: boolean): void;
  setElementOrder(order: number): void;
  setSolverMethod(method: SolverMethod): void;
  setLegendRange(range: LegendRange | null): void;
  setProbing(on: boolean): void;
  setShowExtremeProbes(on: boolean): void;
  addProbe(
    point: [number, number, number],
    anchor: { cadFaceId: number } | { triangle: [number, number, number] },
  ): void;
  removeProbe(id: number): void;

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
  solverMethod: DEFAULT_SOLVER_METHOD,
  legendRange: null,
  mode: "geometry",
  hasStarted: false,
  handCheck: null,
  probes: [],
  nextProbeId: 1,
  probing: false,
  showExtremeProbes: true,

  setResult: (result) =>
    set((s) => {
      s.result = result;
      s.resultType = "Displacement (magnitude)";
      s.legendRange = null;
      // A static solve just finished — it, not any earlier density field, is
      // what Results should show.
      s.activeResult = "static";
      ensurePlot(s, "static");
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
  setSolverMethod: (method) =>
    set((s) => {
      s.solverMethod = method;
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

  setProbing: (on) =>
    set((s) => {
      s.probing = on;
    }),
  setShowExtremeProbes: (on) =>
    set((s) => {
      s.showExtremeProbes = on;
    }),
  addProbe: (point, anchor) =>
    set((s) => {
      if (!point.every(Number.isFinite))
        throw new Error(`probe point must be finite, got ${point.join(", ")}`);
      const id = s.nextProbeId++;
      s.probes.push(
        "cadFaceId" in anchor
          ? { id, point, cadFaceId: anchor.cadFaceId }
          : { id, point, triangle: anchor.triangle },
      );
    }),
  removeProbe: (id) =>
    set((s) => {
      const at = s.probes.findIndex((p) => p.id === id);
      if (at < 0) throw new Error(`no probe P${id} to remove`);
      s.probes.splice(at, 1);
    }),

  setMode: (mode) =>
    set((s) => {
      s.mode = mode;
      // Clicks place probes only on the result they read.
      if (mode !== "results") s.probing = false;
      applyTreeSelection(s, modeSelection(mode, s));
    }),
});
