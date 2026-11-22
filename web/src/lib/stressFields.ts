// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Stress components and principal stresses as result fields (KOF-447): the
// names, the shell surface they are read on, and the per-element tensors a
// solve returns. No store or React imports, so the solve paths, the result
// fields and the analysis file can all use it.

// The surface of a shell a stress is read on: z = +t/2 along the facet normal,
// the mid-surface, or z = −t/2. A solid element has one stress, the same on
// every "surface".
export type ShellSurface = "top" | "middle" | "bottom";
export const SHELL_SURFACES: readonly ShellSurface[] = [
  "top",
  "middle",
  "bottom",
];

// The stress tensor of every element on each surface (KOF-447), recovered at
// the element's corner vertices: six global components, σxx σyy σzz τxy τyz
// τzx, per corner, the corners in the element's node order (four per tet,
// eight per hex, three per shell facet), the elements in mesh order. A model
// without shells holds the same array on every surface.
export type ElementStress = Record<ShellSurface, Float64Array>;

// Corner tensors of consecutive elements, joined into one array.
export function concatTensors(parts: readonly Float64Array[]): Float64Array {
  const out = new Float64Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// The number of tensors an element carries: one per corner vertex.
export const cornerCount = (element: { nodeIds: readonly number[] }): number =>
  element.nodeIds.length;

// An ElementStress built surface by surface.
export const mapSurfaces = (
  build: (surface: ShellSurface) => Float64Array,
): ElementStress => ({
  top: build("top"),
  middle: build("middle"),
  bottom: build("bottom"),
});

// The stress of a model without shells: one tensor per element, the same on
// every surface.
export const uniformStress = (tensors: Float64Array): ElementStress => ({
  top: tensors,
  middle: tensors,
  bottom: tensors,
});

// The fields read from the stress tensors, in tensor order, then σ1 and σ3.
export const STRESS_FIELDS = [
  "Normal stress σxx",
  "Normal stress σyy",
  "Normal stress σzz",
  "Shear stress τxy",
  "Shear stress τyz",
  "Shear stress τzx",
  "Max principal stress σ1",
  "Min principal stress σ3",
] as const;
export type StressField = (typeof STRESS_FIELDS)[number];

export const isStressField = (field: string): field is StressField =>
  (STRESS_FIELDS as readonly string[]).includes(field);

// The principal stresses σ1 ≥ σ2 ≥ σ3 of the tensor at `offset` in `tensors`:
// the eigenvalues of the symmetric tensor in closed form from its invariants
// (Smith, Comm. ACM 4 (1961) 168). In TypeScript, not Rust: the result fields
// are derived on the main thread, synchronously, also for a result opened from
// a file, where the Rust module is not loaded.
export function principalStresses(
  tensors: Float64Array,
  offset: number,
): [number, number, number] {
  const sx = tensors[offset],
    sy = tensors[offset + 1],
    sz = tensors[offset + 2],
    txy = tensors[offset + 3],
    tyz = tensors[offset + 4],
    tzx = tensors[offset + 5];
  const off = txy * txy + tyz * tyz + tzx * tzx;
  const mean = (sx + sy + sz) / 3;
  const dx = sx - mean,
    dy = sy - mean,
    dz = sz - mean;
  const p2 = dx * dx + dy * dy + dz * dz + 2 * off;
  const size = sx * sx + sy * sy + sz * sz + off;
  if (p2 <= Number.EPSILON * Number.EPSILON * size) return [mean, mean, mean];
  const scale = Math.sqrt(p2 / 6);
  const det =
    dx * (dy * dz - tyz * tyz) -
    txy * (txy * dz - tyz * tzx) +
    tzx * (txy * tyz - dy * tzx);
  const cos3 = Math.min(1, Math.max(-1, det / (scale * scale * scale) / 2));
  const phi = Math.acos(cos3) / 3;
  const s1 = mean + 2 * scale * Math.cos(phi);
  const s3 = mean + 2 * scale * Math.cos(phi + (2 * Math.PI) / 3);
  return [s1, 3 * mean - s1 - s3, s3];
}
