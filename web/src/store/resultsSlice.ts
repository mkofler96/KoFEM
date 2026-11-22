// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Results slice: solver output, solve settings, and the app's stage
// transitions (mode navigation).

import type { SliceCreator } from "./modelStore";
import type { HandCheck } from "../lib/handCheck";
import { anchorAtPoint, type ResultProbe } from "../lib/resultProbe";
import type { ReactionSummary } from "../lib/solve/reactions";
import { modeSelection, applyTreeSelection } from "./viewSlice";
import { ensurePlot } from "./studySlice";
import { endPickSessionOutside } from "./pickSlice";
import { DEFAULT_SOLVER_METHOD, type SolverMethod } from "../lib/solve/amg";
import {
  SHELL_SURFACES,
  STRESS_FIELDS,
  type ElementStress,
  type ShellSurface,
} from "../lib/stressFields";
export {
  SHELL_SURFACES,
  STRESS_FIELDS,
  isStressField,
  type ElementStress,
  type ShellSurface,
  type StressField,
} from "../lib/stressFields";

export interface SolverResult {
  displacements: Float64Array;
  vonMises?: Float64Array;
  // Absent on a result solved or saved before stress components existed.
  stress?: ElementStress;
  // Each support's reaction and the applied load (KOF-387); absent on a
  // result that did not come from a static solve here (a saved file).
  reactions?: ReactionSummary | null;
}

export const RESULT_TYPES = [
  "Displacement (magnitude)",
  "Ux",
  "Uy",
  "Uz",
  "Von Mises stress",
  ...STRESS_FIELDS,
] as const;
export type ResultType = (typeof RESULT_TYPES)[number];

export type AppMode =
  "geometry" | "constraints" | "solve" | "optimize" | "results";

// User-chosen colorbar limits, in the units of the displayed result field.
export interface LegendRange {
  min: number;
  max: number;
}

// The section plane of Results (KOF-390): normal to x, y or z (axis 0, 1, 2)
// at `position`, a fraction 0…1 of the model's extent along the axis as drawn,
// keeping the part below it, or above it when `flipped`.
export interface ResultSection {
  axis: 0 | 1 | 2;
  position: number;
  flipped: boolean;
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
  // The shell surface the stress components are read on. Von Mises is always
  // the worse of the two surfaces; a solid element ignores the choice.
  shellSurface: ShellSurface;
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
  // The section plane, or null for the whole model.
  section: ResultSection | null;
  // Whether Results shows the min and max of the field on the cut.
  showSectionRange: boolean;
  // The min and max of the plotted field on the cut, as the viewport's
  // section layer measured it; null with no section or nothing cut.
  sectionRange: LegendRange | null;
  // Why the section could not be drawn (the Rust module failed to load, or
  // the cut refused its input), or null.
  sectionError: string | null;

  setResult(result: SolverResult): void;
  setResultType(t: ResultType): void;
  setRunning(v: boolean): void;
  setElementOrder(order: number): void;
  setSolverMethod(method: SolverMethod): void;
  setLegendRange(range: LegendRange | null): void;
  setShellSurface(surface: ShellSurface): void;
  setProbing(on: boolean): void;
  setShowExtremeProbes(on: boolean): void;
  setSection(section: ResultSection | null): void;
  setShowSectionRange(on: boolean): void;
  setSectionRange(range: LegendRange | null): void;
  setSectionError(message: string | null): void;
  addProbe(
    point: [number, number, number],
    anchor: { cadFaceId: number } | { triangle: [number, number, number] },
  ): void;
  // A probe at a point given by its coordinates, on the surface triangle
  // nearest it (KOF-447). Throws when the mesh has no surface to place it on.
  addProbeAt(point: [number, number, number]): void;
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
  shellSurface: "top",
  mode: "geometry",
  hasStarted: false,
  handCheck: null,
  probes: [],
  nextProbeId: 1,
  probing: false,
  showExtremeProbes: true,
  section: null,
  showSectionRange: false,
  sectionRange: null,
  sectionError: null,

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
  setShellSurface: (surface) =>
    set((s) => {
      if (!SHELL_SURFACES.includes(surface))
        throw new Error(`unknown shell surface ${JSON.stringify(surface)}`);
      s.shellSurface = surface;
      s.legendRange = null;
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
  setSection: (section) =>
    set((s) => {
      if (
        section !== null &&
        !(
          [0, 1, 2].includes(section.axis) &&
          Number.isFinite(section.position) &&
          section.position >= 0 &&
          section.position <= 1
        )
      )
        throw new Error(
          `section needs axis 0, 1 or 2 and a position in [0, 1], got axis ${section.axis}, position ${section.position}`,
        );
      s.section = section;
      if (section === null) {
        s.sectionRange = null;
        s.sectionError = null;
      }
    }),
  setShowSectionRange: (on) =>
    set((s) => {
      s.showSectionRange = on;
    }),
  setSectionRange: (range) =>
    set((s) => {
      s.sectionRange = range;
    }),
  setSectionError: (message) =>
    set((s) => {
      s.sectionError = message;
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
  addProbeAt: (point) =>
    set((s) => {
      const anchor = anchorAtPoint(point, {
        nodes: s.nodes,
        surfaceTriangles: s.surfaceTriangles,
        surfaceFaceIds: s.surfaceFaceIds,
      });
      const id = s.nextProbeId++;
      s.probes.push({ id, ...anchor });
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
      endPickSessionOutside(s, mode);
      applyTreeSelection(s, modeSelection(mode, s));
    }),
});
