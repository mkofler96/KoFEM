// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The reaction arrows Results draws (KOF-387): one per support at its
// centroid, or one per held node. Each arrow ends at the point the support
// pushes on, pointing along the reaction. Display glue for the viewport over
// the Rust module's reactions, so it stays next to the component that draws it.

import type { ReactionSummary, Vec3 } from "./solve/reactions";

export type ReactionDisplay = "resultant" | "nodal";

export interface ReactionArrow {
  key: string;
  // Where the arrow's head ends.
  tip: Vec3;
  direction: Vec3;
  // Length relative to the largest arrow, 0…1.
  size: number;
  // |F| in N, which colours the arrow on the legend's scale.
  magnitude: number;
}

// Below this share of the largest force an arrow is solver noise.
const NOISE = 1e-6;

const length = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);

export function reactionArrows(
  summary: ReactionSummary,
  display: ReactionDisplay,
): ReactionArrow[] {
  const points =
    display === "resultant"
      ? summary.supports
          .filter((s) => s.vertices > 0)
          .map((s) => ({
            key: `support-${s.support}`,
            at: s.centroid,
            force: s.force,
          }))
      : summary.nodal.map((n, i) => ({
          key: `node-${i}`,
          at: n.position,
          force: n.force,
        }));
  const largest = Math.max(0, ...points.map((p) => length(p.force)));
  if (largest === 0) return [];
  return points
    .filter((p) => length(p.force) > NOISE * largest)
    .map((p) => {
      const magnitude = length(p.force);
      return {
        key: p.key,
        tip: p.at,
        direction: [
          p.force[0] / magnitude,
          p.force[1] / magnitude,
          p.force[2] / magnitude,
        ],
        size: magnitude / largest,
        magnitude,
      };
    });
}

// The range of the arrows `display` draws: the legend's scale, which colours
// them; null when there is no arrow.
export function reactionRange(
  summary: ReactionSummary,
  display: ReactionDisplay,
): { min: number; max: number } | null {
  const arrows = reactionArrows(summary, display);
  if (arrows.length === 0) return null;
  const magnitudes = arrows.map((a) => a.magnitude);
  return { min: Math.min(...magnitudes), max: Math.max(...magnitudes) };
}

// A magnitude's place on the legend, 0 (blue) to 1 (red); a range of one
// value is all red.
export function rangeFraction(
  value: number,
  range: { min: number; max: number },
): number {
  const span = range.max - range.min;
  return span > 0 ? (value - range.min) / span : 1;
}
