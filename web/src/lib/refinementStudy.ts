// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Mesh refinement study (KOF-401): solve the same model on successively finer
// meshes and judge whether the result still depends on the mesh. This module
// holds the arithmetic — the sizes of each level and the convergence verdict;
// hooks/useRefinementStudy runs the meshes and solves.
//
// Each level divides every element size by the study's ratio. A constant ratio
// is what Richardson extrapolation needs. The default √2 halves the size in two
// levels and keeps the finest of three levels at about 8× the elements of the
// first (a solid) instead of 64× for plain halving. The user sets the number
// of levels, the ratio and the error the verdict accepts (KOF-424).

import type { MeshSizes } from "../store/geometrySlice";

export interface RefinementSettings {
  // Meshes the study solves, the current one included.
  levels: number;
  // Each level's element sizes are the level before's divided by this.
  ratio: number;
  // The max displacement is converged when its estimated discretisation error
  // is below this fraction of its value.
  tolerance: number;
}

// The settings as typed: the target is a percentage.
export interface RefinementSettingsInput {
  levels: string;
  ratio: string;
  tolerance: string;
}

export type RefinementFieldErrors = Partial<
  Record<keyof RefinementSettingsInput, string>
>;

export const DEFAULT_REFINEMENT_SETTINGS: RefinementSettings = {
  levels: 3,
  ratio: Math.SQRT2,
  tolerance: 0.02,
};

export const DEFAULT_REFINEMENT_INPUT: RefinementSettingsInput = {
  levels: String(DEFAULT_REFINEMENT_SETTINGS.levels),
  ratio: String(DEFAULT_REFINEMENT_SETTINGS.ratio),
  tolerance: String(DEFAULT_REFINEMENT_SETTINGS.tolerance * 100),
};

// The ratios the panel offers, gentle to steep.
export const REFINEMENT_RATIOS: { value: number; label: string }[] = [
  { value: Math.SQRT2, label: "√2 (halves the size every 2 levels)" },
  { value: 1.5, label: "1.5" },
  { value: 2, label: "2 (halves the size every level)" },
];

// A peak stress that grows by more than this fraction at every refinement is
// not converging: it sits on a singularity (a re-entrant corner, a point
// support or load) where the exact stress is infinite.
const STRESS_RISE = 0.05;
// The study stops before a level whose mesh would have more nodes than this:
// beyond it a browser solve takes minutes and can run out of memory.
export const STUDY_NODE_BUDGET = 250_000;

const LEVELS_RANGE = { min: 2, max: 6 };
const RATIO_RANGE = { min: 1, max: 2 };
const TOLERANCE_PERCENT_RANGE = { min: 0.1, max: 20 };

// The typed settings, or why each invalid one is refused. Nothing falls back
// to a default: an invalid field blocks the run.
export function parseRefinementSettings(input: RefinementSettingsInput): {
  settings: RefinementSettings | null;
  errors: RefinementFieldErrors;
} {
  const errors: RefinementFieldErrors = {};
  const number = (text: string) =>
    text.trim() === "" ? Number.NaN : Number(text);
  const levels = number(input.levels);
  if (
    !Number.isInteger(levels) ||
    levels < LEVELS_RANGE.min ||
    levels > LEVELS_RANGE.max
  )
    errors.levels = `Levels is a whole number from ${LEVELS_RANGE.min} to ${LEVELS_RANGE.max}.`;
  const ratio = number(input.ratio);
  if (
    !Number.isFinite(ratio) ||
    ratio <= RATIO_RANGE.min ||
    ratio > RATIO_RANGE.max
  )
    errors.ratio = `The ratio is between ${RATIO_RANGE.min} and ${RATIO_RANGE.max}: above 1 to refine, at most 2 to keep the finest mesh solvable.`;
  const percent = number(input.tolerance);
  if (
    !Number.isFinite(percent) ||
    percent < TOLERANCE_PERCENT_RANGE.min ||
    percent > TOLERANCE_PERCENT_RANGE.max
  )
    errors.tolerance = `The target is ${TOLERANCE_PERCENT_RANGE.min} to ${TOLERANCE_PERCENT_RANGE.max} %.`;
  return Object.keys(errors).length > 0
    ? { settings: null, errors }
    : {
        settings: { levels, ratio, tolerance: percent / 100 },
        errors,
      };
}

// One solved level of the study.
export interface StudyLevel {
  sizes: MeshSizes;
  nodes: number;
  elements: number;
  // Largest nodal displacement magnitude, mm.
  maxDisplacement: number;
  // Largest nodal (averaged) von Mises stress, MPa; null when the solve
  // returned no stress.
  maxVonMises: number | null;
}

// An element size as the user would type it: 16, 11.3, 8.
export function sizeLabel(mm: number): string {
  return String(Number(mm.toPrecision(3)));
}

// The element sizes of level `level`: every size of the base mesh divided by
// ratio^level.
export function levelSizes(
  base: MeshSizes,
  level: number,
  ratio: number,
): MeshSizes {
  if (!Number.isInteger(level) || level < 0)
    throw new Error(
      `A refinement level is a whole number from 0 — got ${level}`,
    );
  if (!(ratio > 1))
    throw new Error(
      `A refinement ratio must be above 1 to refine — got ${ratio}`,
    );
  const scale = ratio ** level;
  return {
    max: base.max / scale,
    min: base.min / scale,
    regions: Object.fromEntries(
      Object.entries(base.regions).map(([id, size]) => [id, size / scale]),
    ),
  };
}

// Nodes the next level's mesh will have, roughly: a mesh `dimension`-
// dimensional in its elements gains ratio^dimension times the nodes.
export function nextLevelNodes(
  nodes: number,
  dimension: 2 | 3,
  ratio: number,
): number {
  return nodes * ratio ** dimension;
}

export interface ConvergenceAssessment {
  // Change of each level's max displacement / max von Mises from the level
  // before, as a fraction of the previous level's value; null for the first level
  // (and for stress on a level without one).
  displacementChanges: (number | null)[];
  stressChanges: (number | null)[];
  // How the error was estimated: by Richardson extrapolation from the last
  // three levels when they converge monotonically, otherwise by the last
  // change alone.
  method: "richardson" | "last-change";
  // Richardson only: the observed order of convergence and the extrapolated
  // max displacement for an infinitely fine mesh.
  observedOrder: number | null;
  extrapolated: number | null;
  // Estimated relative error of the finest level's max displacement.
  estimatedError: number;
  converged: boolean;
  // The peak stress grew at every refinement and is still growing.
  stressRising: boolean;
}

function relativeChange(previous: number, current: number): number {
  return (current - previous) / previous;
}

export function assessConvergence(
  levels: StudyLevel[],
  settings: Pick<RefinementSettings, "ratio" | "tolerance">,
): ConvergenceAssessment {
  const { ratio, tolerance } = settings;
  if (levels.length < 2)
    throw new Error(
      `A refinement study needs at least two levels to compare — got ${levels.length}`,
    );
  const disp = levels.map((l) => l.maxDisplacement);
  const finest = disp[disp.length - 1];
  if (disp.some((f) => f === 0))
    throw new Error(
      "A level's max displacement is zero — the model is not loaded, so there is nothing to converge",
    );

  const displacementChanges = disp.map((f, i) =>
    i === 0 ? null : relativeChange(disp[i - 1], f),
  );
  const stressChanges = levels.map((l, i) => {
    const prev = i === 0 ? null : levels[i - 1].maxVonMises;
    return prev === null || prev === 0 || l.maxVonMises === null
      ? null
      : relativeChange(prev, l.maxVonMises);
  });

  let method: ConvergenceAssessment["method"] = "last-change";
  let observedOrder: number | null = null;
  let extrapolated: number | null = null;
  let estimatedError = Math.abs(relativeChange(disp[disp.length - 2], finest));
  if (disp.length >= 3) {
    const d1 = disp[disp.length - 2] - disp[disp.length - 3];
    const d2 = finest - disp[disp.length - 2];
    // Monotone and shrinking: the asymptotic range Richardson assumes.
    if (d1 * d2 > 0 && Math.abs(d2) < Math.abs(d1)) {
      const order = Math.log(d1 / d2) / Math.log(ratio);
      const fInf = finest + d2 / (ratio ** order - 1);
      method = "richardson";
      observedOrder = order;
      extrapolated = fInf;
      estimatedError = Math.abs((fInf - finest) / fInf);
    }
  }

  const rises = stressChanges.slice(1);
  const stressRising =
    rises.length > 0 &&
    rises.every((c) => c !== null && c > 0) &&
    (rises[rises.length - 1] as number) > STRESS_RISE;

  return {
    displacementChanges,
    stressChanges,
    method,
    observedOrder,
    extrapolated,
    estimatedError,
    converged: estimatedError < tolerance,
    stressRising,
  };
}

// The physical model a study holds fixed across its levels: materials, the CAD
// bodies' settings, the supports, loads, ties and couplings, the element order
// and the solver. The node ids of the groups, a coupling's reference node and
// the sections a mesh derived are left out — those change with every mesh. Comparing two fingerprints tells whether
// the user edited the model while the study ran.
export interface StudyModel {
  materials: unknown[];
  properties: { sourceBodyId?: number }[];
  bcGroups: unknown[];
  loadGroups: unknown[];
  tieGroups: unknown[];
  couplingGroups: unknown[];
  elementOrder: number;
  solverMethod: string;
}

export function studyFingerprint(model: StudyModel): string {
  return JSON.stringify(
    {
      materials: model.materials,
      // A derived section has a source body; a CAD body has none (isCadBody).
      properties: model.properties.filter((p) => p.sourceBodyId === undefined),
      bcGroups: model.bcGroups,
      loadGroups: model.loadGroups,
      tieGroups: model.tieGroups,
      couplingGroups: model.couplingGroups,
      elementOrder: model.elementOrder,
      solverMethod: model.solverMethod,
    },
    (key, value: unknown) =>
      key === "nodeIds" || key === "refNodeId" ? undefined : value,
  );
}

// A level whose solve moved nothing has no displacement to converge: the loads
// act only where the supports hold the part. Refused with the level's size.
export function checkLevelDisplacement(
  maxDisplacement: number,
  size: number,
): void {
  if (maxDisplacement === 0)
    throw new Error(
      `The solve at ${sizeLabel(size)} mm moved nothing (max displacement 0): the loads act only where the supports hold the part. Check the supports and loads.`,
    );
}

// A fraction as a percentage the way the user typed it: 2, 0.5.
function percentLabel(fraction: number): string {
  return String(Number((fraction * 100).toPrecision(3)));
}

// The verdict in one line, for the panel and the chart.
export function verdictLine(
  levels: StudyLevel[],
  settings: Pick<RefinementSettings, "ratio" | "tolerance">,
): {
  converged: boolean;
  text: string;
} {
  const assessment = assessConvergence(levels, settings);
  // One decimal: an error below 0.1 % reads as "within 0.1 %", a true bound.
  const error = `${Math.max(assessment.estimatedError * 100, 0.1).toFixed(1)} %`;
  return assessment.converged
    ? { converged: true, text: `Converged: max |U| within ${error}` }
    : {
        converged: false,
        text: `Not converged: max |U| still ${error} off (target ${percentLabel(settings.tolerance)} %)`,
      };
}
