// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Material slice: material definitions and their CRUD actions.

import type { SliceCreator } from "./modelStore";

export interface Material {
  id: number;
  name: string;
  young: number;
  poisson: number;
  density: number;
  // Display colour (hex) used to paint the bodies this material is assigned to
  // in the geometry view, so the body ↔ material mapping is visible at a glance
  // (issue #353). Auto-picked from MATERIAL_PALETTE on creation; user-editable.
  color: string;
}

// Distinct, muted body colours (Tableau-10 order) — enough contrast between
// adjacent bodies of an assembly without the neon look of pure RGB. Reused
// cyclically once exhausted; the picker below prefers unused entries first.
export const MATERIAL_PALETTE = [
  "#4e79a7",
  "#f28e2b",
  "#59a14f",
  "#e15759",
  "#b07aa1",
  "#76b7b2",
  "#edc948",
  "#ff9da7",
  "#9c755f",
  "#bab0ac",
];

// Next palette colour not already used by an existing material; falls back to
// cycling through the palette by count when every colour is taken.
export function pickMaterialColor(existing: Material[]): string {
  const used = new Set(existing.map((m) => m.color));
  const free = MATERIAL_PALETTE.find((c) => !used.has(c));
  return free ?? MATERIAL_PALETTE[existing.length % MATERIAL_PALETTE.length];
}

// Canonical unit system: N · mm · MPa · tonne. Steel: E = 210 GPa = 210000 MPa,
// ρ = 7850 kg/m³ = 7.85e-9 t/mm³. STEP geometry imports in mm, so materials,
// loads (N), and results (mm, MPa) must share this system to stay consistent.
export const DEFAULT_MATERIAL: Material = {
  id: 1,
  name: "Steel",
  young: 210000,
  poisson: 0.3,
  density: 7.85e-9,
  color: MATERIAL_PALETTE[0],
};

export interface MaterialSlice {
  materials: Material[];
  nextMatId: number;

  addMaterial(mat: Material): void;
  // color is optional on create: auto-picked from MATERIAL_PALETTE when omitted.
  createMaterial(
    mat: Omit<Material, "id" | "color"> & { color?: string },
  ): void;
  updateMaterial(id: number, patch: Partial<Omit<Material, "id">>): void;
  deleteMaterial(id: number): void;
}

export const createMaterialSlice: SliceCreator<MaterialSlice> = (set) => ({
  materials: [DEFAULT_MATERIAL],
  nextMatId: 2,

  addMaterial: (mat) =>
    set((s) => {
      s.materials.push(mat);
    }),

  createMaterial: (mat) =>
    set((s) => {
      s.materials.push({
        ...mat,
        color: mat.color ?? pickMaterialColor(s.materials),
        id: s.nextMatId++,
      });
    }),

  updateMaterial: (id, patch) =>
    set((s) => {
      const idx = s.materials.findIndex((m) => m.id === id);
      if (idx >= 0) Object.assign(s.materials[idx], patch);
    }),

  deleteMaterial: (id) =>
    set((s) => {
      s.materials = s.materials.filter((m) => m.id !== id);
    }),
});
