// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Topology-optimization slice (KOF-232, TO epic KOF-226): the SIMP setup the
// Optimize panel configures, and the run status. Settings are the persisted
// half — they travel in the saved analysis file alongside the solve settings —
// so they live here in the store rather than in the panel's component state.
// The density field the run produces is a transient result and is NOT
// serialized; loading an analysis restores the settings but not a stale run.

import type { TopOptHistoryEntry } from "../wasm/pkg/kofem_wasm.js";
import type { SliceCreator } from "./modelStore";

// The two objectives the panel offers: minimize compliance under a volume
// fraction (KOF-230) or minimize volume under a compliance limit (KOF-235).
export type TopOptObjective = "min_compliance" | "min_volume";

// How the element stresses are aggregated into the single max-stress constraint
// (KOF-236): P-norm or Kreisselmeier–Steinhauser.
export type StressAggregation = "pnorm" | "ks";

// The numeric settings are held as the raw strings the user typed, exactly as
// the mesh-size fields are (KOF-222): there is no single meaningful range to
// clamp typing to (a compliance limit spans many orders of magnitude with the
// model's units), and keeping the text lets an in-progress or invalid edit
// round-trip through save/load without being coerced. useTopOpt parses and
// validates them when the run starts, and refuses to run while any is invalid.
export interface TopOptSettingsState {
  objective: TopOptObjective;
  // Constraint for min_compliance: target volume fraction ∈ (0, 1).
  volumeFraction: string;
  // Constraint for min_volume: the compliance ceiling (> 0, model work units).
  // May be left blank when the max-stress constraint bounds the run instead.
  complianceLimit: string;
  // Maximum von Mises stress constraint (KOF-236), available with either
  // objective: whether it is on, the limit σ_allow (> 0, the material's stress
  // units), and — advanced — the aggregation method and its parameter P.
  stressConstraint: boolean;
  maxStress: string;
  stressAggregation: StressAggregation;
  stressP: string;
  // SIMP penalty p (≥ 1), filter radius r_min (> 0, model length units),
  // MMA move limit (∈ (0, 1]), iteration cap (integer > 0), and the
  // convergence tolerance on max |Δρ| (> 0).
  penalty: string;
  filterRadius: string;
  moveLimit: string;
  maxIterations: string;
  tolerance: string;
}

// A completed run's output: one density per element (solve/element order) plus
// the per-iteration history that drives the convergence plot (KOF-233).
export interface DensityResult {
  density: Float64Array;
  history: TopOptHistoryEntry[];
}

// Sensible starting point. complianceLimit has no universal default — it is in
// the model's own work units — so it starts empty and is required before a
// min_volume run, shown as an inline error rather than guessed.
export const DEFAULT_TOPOPT_SETTINGS: TopOptSettingsState = {
  objective: "min_compliance",
  volumeFraction: "0.5",
  complianceLimit: "",
  stressConstraint: false,
  maxStress: "",
  stressAggregation: "pnorm",
  stressP: "8",
  penalty: "3",
  filterRadius: "1.5",
  moveLimit: "0.2",
  maxIterations: "50",
  tolerance: "0.01",
};

// The numeric fields, so the setter and the panel can iterate them generically.
export type TopOptNumericField = Exclude<
  keyof TopOptSettingsState,
  "objective" | "stressConstraint" | "stressAggregation"
>;

// Default aggregation parameter per method: the P-norm is tight at 8, while KS
// works on σ/σ_allow ≈ 1 and needs a larger P for the same tightness.
export const DEFAULT_STRESS_P: Record<StressAggregation, string> = {
  pnorm: "8",
  ks: "40",
};

// The design density of the iteration currently being streamed from a running
// optimization (KOF-240). Transient: set per progress message, cleared when a
// run starts, finishes or is cancelled — never persisted, never a "best so far".
export interface LiveDensity {
  it: number;
  density: Float64Array;
}

export interface TopOptSlice {
  topOpt: TopOptSettingsState;
  isOptimizing: boolean;
  densityResult: DensityResult | null;
  liveDensity: LiveDensity | null;

  setTopOptObjective(objective: TopOptObjective): void;
  setTopOptSetting(field: TopOptNumericField, value: string): void;
  setStressConstraint(enabled: boolean): void;
  setStressAggregation(aggregation: StressAggregation): void;
  setOptimizing(v: boolean): void;
  setDensityResult(result: DensityResult | null): void;
  setLiveDensity(live: LiveDensity | null): void;
}

export const createTopOptSlice: SliceCreator<TopOptSlice> = (set) => ({
  topOpt: { ...DEFAULT_TOPOPT_SETTINGS },
  isOptimizing: false,
  densityResult: null,
  liveDensity: null,

  // Changing any setting makes an existing density stale — it was computed with
  // the previous setup. Clear it so the Optimize/Results nav steps no longer read
  // as complete and Results stops showing a density that no longer matches the
  // configured run (mirrors how the mesh/BC setters invalidate a static result).
  setTopOptObjective: (objective) =>
    set((s) => {
      s.topOpt.objective = objective;
      s.densityResult = null;
    }),
  setTopOptSetting: (field, value) =>
    set((s) => {
      s.topOpt[field] = value;
      s.densityResult = null;
    }),
  setStressConstraint: (enabled) =>
    set((s) => {
      s.topOpt.stressConstraint = enabled;
      s.densityResult = null;
    }),
  // Switching method resets P to that method's default: a P-norm exponent and a
  // KS parameter live on different scales, so carrying one over is never right.
  setStressAggregation: (aggregation) =>
    set((s) => {
      s.topOpt.stressAggregation = aggregation;
      s.topOpt.stressP = DEFAULT_STRESS_P[aggregation];
      s.densityResult = null;
    }),
  setOptimizing: (v) =>
    set((s) => {
      s.isOptimizing = v;
    }),
  setDensityResult: (result) =>
    set((s) => {
      s.densityResult = result;
      // A completed run is the freshly produced output; make Results show it in
      // preference to any static result left from an earlier solve.
      if (result) s.activeResult = "density";
    }),
  setLiveDensity: (live) =>
    set((s) => {
      s.liveDensity = live;
    }),
});
