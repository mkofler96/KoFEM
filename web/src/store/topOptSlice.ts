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

// The two objectives the panel offers. v1's engine implements only
// `min_compliance`; `min_volume` (KOF-235) shares the contract and returns a
// clear error until it lands, so selecting it and running surfaces that message
// rather than a silent no-op.
export type TopOptObjective = "min_compliance" | "min_volume";

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
  complianceLimit: string;
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
  penalty: "3",
  filterRadius: "1.5",
  moveLimit: "0.2",
  maxIterations: "50",
  tolerance: "0.01",
};

// The numeric fields, so the setter and the panel can iterate them generically.
export type TopOptNumericField = Exclude<
  keyof TopOptSettingsState,
  "objective"
>;

export interface TopOptSlice {
  topOpt: TopOptSettingsState;
  isOptimizing: boolean;
  densityResult: DensityResult | null;

  setTopOptObjective(objective: TopOptObjective): void;
  setTopOptSetting(field: TopOptNumericField, value: string): void;
  setOptimizing(v: boolean): void;
  setDensityResult(result: DensityResult | null): void;
}

export const createTopOptSlice: SliceCreator<TopOptSlice> = (set) => ({
  topOpt: { ...DEFAULT_TOPOPT_SETTINGS },
  isOptimizing: false,
  densityResult: null,

  setTopOptObjective: (objective) =>
    set((s) => {
      s.topOpt.objective = objective;
    }),
  setTopOptSetting: (field, value) =>
    set((s) => {
      s.topOpt[field] = value;
    }),
  setOptimizing: (v) =>
    set((s) => {
      s.isOptimizing = v;
    }),
  setDensityResult: (result) =>
    set((s) => {
      s.densityResult = result;
    }),
});
