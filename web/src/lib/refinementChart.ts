// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Layout of the mesh refinement chart (KOF-401): each solved level as a point,
// element count on a logarithmic axis (it grows geometrically, ~2.8× a level),
// and for displacement the band the verdict is judged by — ± the study's target
// around the extrapolated value, or around the finest level when the levels
// allow no extrapolation. Pure, so the chart component only draws.

import {
  assessConvergence,
  percentLabel,
  type RefinementSettings,
  type StudyLevel,
} from "./refinementStudy";

export type ChartField = "displacement" | "stress";

// The plot area inside the SVG, in its units.
export interface ChartBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface ChartPoint {
  x: number;
  y: number;
  value: number;
  elements: number;
  // The level's index in the study.
  level: number;
}

export interface ChartLayout {
  points: ChartPoint[];
  // Displacement only: the value the band is centred on, whether it is an
  // extrapolation, the band and where it is drawn.
  reference: number | null;
  extrapolated: boolean;
  band: { low: number; high: number } | null;
  bandY: { top: number; bottom: number } | null;
  referenceY: number | null;
  // The value range the y axis spans; null without points.
  range: { min: number; max: number } | null;
}

const EMPTY: ChartLayout = {
  points: [],
  reference: null,
  extrapolated: false,
  band: null,
  bandY: null,
  referenceY: null,
  range: null,
};

function fieldValue(level: StudyLevel, field: ChartField): number | null {
  return field === "displacement" ? level.maxDisplacement : level.maxVonMises;
}

export function chartLayout(
  levels: StudyLevel[],
  field: ChartField,
  box: ChartBox,
  settings: Pick<RefinementSettings, "ratio" | "tolerance">,
): ChartLayout {
  const solved = levels.flatMap((l, i) => {
    const value = fieldValue(l, field);
    return value === null ? [] : [{ value, elements: l.elements, level: i }];
  });
  if (solved.length === 0) return EMPTY;

  let reference: number | null = null;
  let extrapolated = false;
  if (field === "displacement" && levels.length >= 2) {
    const assessment = assessConvergence(levels, settings);
    extrapolated = assessment.extrapolated !== null;
    reference =
      assessment.extrapolated ?? levels[levels.length - 1].maxDisplacement;
  }
  const band =
    reference === null
      ? null
      : {
          low: reference * (1 - settings.tolerance),
          high: reference * (1 + settings.tolerance),
        };

  // The value range: every point and the band, with a margin.
  const values = solved.map((p) => p.value);
  if (band) values.push(band.low, band.high);
  let min = Math.min(...values);
  let max = Math.max(...values);
  // A flat series has no span to pad by: pad by 5 % of its value, or by one
  // unit around zero (a stress view of an unloaded part), so the point still
  // sits mid-plot.
  const span = max - min;
  const pad = span > 0 ? 0.1 * span : max !== 0 ? 0.05 * Math.abs(max) : 1;
  min -= pad;
  max += pad;

  const logs = solved.map((p) => Math.log10(p.elements));
  const logMin = Math.min(...logs);
  const logMax = Math.max(...logs);
  const xOf = (elements: number) =>
    logMax > logMin
      ? box.left +
        ((Math.log10(elements) - logMin) / (logMax - logMin)) *
          (box.right - box.left)
      : (box.left + box.right) / 2;
  const yOf = (value: number) =>
    box.top + ((max - value) / (max - min)) * (box.bottom - box.top);

  return {
    points: solved.map((p) => ({ ...p, x: xOf(p.elements), y: yOf(p.value) })),
    reference,
    extrapolated,
    band,
    bandY: band ? { top: yOf(band.high), bottom: yOf(band.low) } : null,
    referenceY: reference === null ? null : yOf(reference),
    range: { min, max },
  };
}

// The band's caption: the value it is centred on and the study's target.
// Null when the layout has no band (the stress view).
export function bandLabel(
  layout: ChartLayout,
  tolerance: number,
): string | null {
  if (layout.reference === null) return null;
  const target = `±${percentLabel(tolerance)} %`;
  return layout.extrapolated
    ? `Extrapolated ${layout.reference.toPrecision(4)} mm · ${target}`
    : `${target} of the finest level`;
}
