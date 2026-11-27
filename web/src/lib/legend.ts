// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The result legend: which range the colours of the view stand for, its
// title, and how its gradient and ticks are drawn. The viewport's legend
// (ColorBar) and the analysis report's figures (lib/report) both draw it from
// here, so a report's figure reads exactly as the app's view did.

import type {
  Element,
  LegendRange,
  Node,
  ResultType,
  SolverResult,
} from "../store/modelStore";
import type { ShellSurface } from "./stressFields";
import {
  computeResultRange,
  resultColor,
  resultFieldSymbol,
  resultUnit,
  type ResultRange,
} from "./resultField";
import { reactionRange, type ReactionDisplay } from "./reactionArrows";
import { densityColor } from "./densityField";

const GRADIENT_STOPS = 12;
const TICKS = 5;

// CSS gradient sampled from the same color map as the mesh, blue at the bottom
// (min) to red at the top (max).
export const LEGEND_GRADIENT = (() => {
  const stops: string[] = [];
  for (let i = 0; i <= GRADIENT_STOPS; i++) {
    const frac = i / GRADIENT_STOPS;
    stops.push(`${resultColor(frac).getStyle()} ${frac * 100}%`);
  }
  return `linear-gradient(to top, ${stops.join(", ")})`;
})();

// The density field's grayscale ramp, 0 at the bottom to 1 at the top
// (DensityColorBar and the report's density figure).
export const DENSITY_GRADIENT = (() => {
  const stops: string[] = [];
  for (let i = 0; i <= GRADIENT_STOPS; i++) {
    const frac = i / GRADIENT_STOPS;
    stops.push(`${densityColor(frac).getStyle()} ${frac * 100}%`);
  }
  return `linear-gradient(to top, ${stops.join(", ")})`;
})();

// What the legend shows: its title, the range of the colours and whether a
// manual range clamps them at either end. A clamped end tick stands for
// everything at or beyond its value, not for the extreme of the field.
export interface Legend {
  title: string;
  min: number;
  max: number;
  clampsAbove: boolean;
  clampsBelow: boolean;
}

export interface LegendTick {
  // The tick's place on the bar, 1 at the top (max) to 0 (min); it identifies
  // the tick across renders, as the value changes with the range.
  frac: number;
  label: string;
}

// The ticks from max (top) to min. A clamped end reads "≥" or "≤".
export function legendTicks(legend: Legend): LegendTick[] {
  return Array.from({ length: TICKS }, (_, i) => {
    const frac = 1 - i / (TICKS - 1);
    const value = legend.min + frac * (legend.max - legend.min);
    const clamp =
      frac === 1 && legend.clampsAbove
        ? "≥ "
        : frac === 0 && legend.clampsBelow
          ? "≤ "
          : "";
    return { frac, label: `${clamp}${value.toExponential(2)}` };
  });
}

// The static result's legend of a field: the field's range over all nodes,
// or the user's manual range, which clamps the colouring. `fieldRange` is
// returned too, for the legend's range editor.
export function fieldLegend(
  result: SolverResult,
  resultType: ResultType,
  nodes: Node[],
  elements: Element[],
  shellSurface: ShellSurface,
  legendRange: LegendRange | null,
): { legend: Legend; fieldRange: ResultRange } | null {
  const fieldRange = computeResultRange(
    result,
    resultType,
    nodes,
    elements,
    shellSurface,
  );
  if (!fieldRange) return null;
  const { min, max } = legendRange ?? fieldRange;
  return {
    fieldRange,
    legend: {
      title: `${resultFieldSymbol(resultType)} [${resultUnit(resultType)}]`,
      min,
      max,
      clampsAbove: max < fieldRange.max,
      clampsBelow: min > fieldRange.min,
    },
  };
}

// The reactions view's legend (KOF-387): the reaction force of the arrows on
// view, per node or per support, from the smallest to the largest.
export function reactionLegend(
  result: SolverResult,
  display: ReactionDisplay,
): Legend | null {
  const range = result.reactions
    ? reactionRange(result.reactions, display)
    : null;
  return range
    ? {
        title: "|F| [N]",
        min: range.min,
        max: range.max,
        clampsAbove: false,
        clampsBelow: false,
      }
    : null;
}
