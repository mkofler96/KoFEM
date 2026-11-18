// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Deformation scale of the result view (KOF-383). The deformed shape is drawn
// at node + factor · displacement, and the factor is what the Results panel
// shows. "Auto" picks it so the largest displacement component shows as
// TARGET_DEFORM_FRACTION of the model size; a manual factor is used as set
// (1 = true scale, 0 = undeformed). appliedDeformFactor is the one place the
// factor the renderer multiplies displacements by is decided.

export type DeformScale = { mode: "auto" } | { mode: "manual"; factor: number };

export const AUTO_DEFORM_SCALE: DeformScale = { mode: "auto" };
export const TRUE_DEFORM_SCALE: DeformScale = { mode: "manual", factor: 1 };

const TARGET_DEFORM_FRACTION = 0.2;

interface Point {
  x: number;
  y: number;
  z: number;
}

// Largest side of the nodes' bounding box (1 for an empty mesh).
export function modelExtent(nodes: readonly Point[]): number {
  if (nodes.length === 0) return 1;
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
    if (n.z < minZ) minZ = n.z;
    if (n.z > maxZ) maxZ = n.z;
  }
  return Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-9);
}

function round3(v: number): number {
  return Number(v.toPrecision(3));
}

// The automatic factor, rounded to 3 significant digits so the number shown is
// exactly the one applied. A result without displacement is drawn at 1.
export function autoDeformFactor(
  displacements: ArrayLike<number>,
  modelSize: number,
): number {
  let maxDisp = 0;
  for (let i = 0; i < displacements.length; i++) {
    const mag = Math.abs(displacements[i]);
    if (mag > maxDisp) maxDisp = mag;
  }
  if (maxDisp < 1e-30) return 1;
  return round3((TARGET_DEFORM_FRACTION * modelSize) / maxDisp);
}

export function checkDeformFactor(factor: number): void {
  if (!Number.isFinite(factor) || factor < 0)
    throw new Error(
      `Deformation factor must be a finite number of 0 or more, got ${factor}`,
    );
}

// The factor the renderer multiplies the displacements by.
export function appliedDeformFactor(
  scale: DeformScale,
  displacements: ArrayLike<number>,
  modelSize: number,
): number {
  if (scale.mode === "auto") return autoDeformFactor(displacements, modelSize);
  checkDeformFactor(scale.factor);
  return scale.factor;
}

// ── Logarithmic slider ──────────────────────────────────────────────────────
// Position 0 is factor 0 (undeformed); above it, one unit per decade with
// position 1 at true scale: factor = 10^(position − 1).

// The right end: at least 10 000×, and at least a decade past the automatic
// factor, in whole decades.
export function deformSliderMax(autoFactor: number): number {
  const decades = Math.max(4, Math.ceil(Math.log10(autoFactor * 10)));
  return decades + 1;
}

export function sliderToFactor(position: number): number {
  if (position <= 0) return 0;
  return round3(10 ** (position - 1));
}

export const DEFORM_SLIDER_STEP = 0.01;

export function factorToSlider(factor: number, max: number): number {
  checkDeformFactor(factor);
  if (factor === 0) return 0;
  const position = Math.log10(factor) + 1;
  return Math.min(max, Math.max(DEFORM_SLIDER_STEP, position));
}

// ── Text ────────────────────────────────────────────────────────────────────

// Up to 6 significant digits, thousands grouped by spaces: "1 240", "0.316".
export function formatDeformFactor(factor: number): string {
  const shown = Number(factor.toPrecision(6));
  if (Math.abs(shown) < 1000) return String(shown);
  const [whole, frac] = String(shown).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return frac === undefined ? grouped : `${grouped}.${frac}`;
}

export function parseDeformFactor(
  text: string,
): { factor: number } | { error: string } {
  const factor = Number(text);
  if (text.trim() === "" || Number.isNaN(factor))
    return { error: "Enter a number" };
  if (!Number.isFinite(factor) || factor < 0)
    return { error: "Enter a factor of 0 or more" };
  return { factor };
}
