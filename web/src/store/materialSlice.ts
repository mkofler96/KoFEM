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
};

export interface MaterialSlice {
  materials: Material[];
  nextMatId: number;

  addMaterial(mat: Material): void;
  createMaterial(mat: Omit<Material, "id">): void;
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
      s.materials.push({ ...mat, id: s.nextMatId++ });
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
