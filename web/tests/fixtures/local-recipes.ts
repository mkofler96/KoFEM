// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Recipes the GUI harness (examples-by-hand.spec.ts) carries itself until the
// example modules export them (KOF-322):
//
//   SHOWCASE_RECIPES  published examples whose generator has no recipe yet. Each
//                     transcribes its generator step by step; the published
//                     number is still read from the example's own record. Drop
//                     an entry once the example's module exports `recipe`.
//   DRIVER_RECIPES    throwaway models, not examples: they prove the driver on
//                     each load kind (force, pressure, moment) and on a split,
//                     checked against their closed-form result.

import { prismStep } from "../../../examples/gallery/step-prism.mjs";
import type { Recipe } from "./recipe";

// Steel exactly as the app seeds it (N · mm · MPa · tonne).
const STEEL = {
  name: "Steel",
  young: 210000,
  poisson: 0.3,
  density: 7.85e-9,
};

// An L × h × b block along x: y up to h, z up to b.
const block = (length: number, height: number, depth: number, name: string) =>
  prismStep(
    [
      [0, 0],
      [length, 0],
      [length, height],
      [0, height],
    ],
    depth,
    name,
  );

/* eslint-disable kofem/min-identifier-length -- symbols of the closed-form results quoted beside each recipe */
// examples/gallery/generate-cantilever.mjs: δ = P·L³ / (3·E·I), mean Uy of the
// loaded end face.
const L = 1000;
const H = 100;
const B = 100;
const P = 10000;
const I = (B * H ** 3) / 12;
const cantileverBeam: Recipe = {
  step: () => block(L, H, B, "Cantilever beam"),
  splits: [],
  discretization: { kind: "solid" },
  mesh: { maxElementSize: 25, order: 2 },
  material: STEEL,
  supports: [
    {
      name: "Clamped end",
      faces: [{ at: [0, 50, 50] }],
      dofs: [0, 1, 2],
      value: 0,
    },
  ],
  loads: [
    {
      name: "Tip load",
      kind: "force",
      faces: [{ at: [L, 50, 50] }],
      components: [0, -P, 0],
    },
  ],
  readout: {
    quantity: "Tip deflection",
    probe: {
      kind: "displacement",
      component: 1,
      faces: [{ at: [L, 50, 50] }],
      unit: "mm",
    },
    formula: "−P·L³ / (3·E·I)",
    reference: -(P * L ** 3) / (3 * STEEL.young * I),
  },
};

export const SHOWCASE_RECIPES: Record<string, Recipe> = {
  "cantilever-beam": cantileverBeam,
};

// ── Driver self-tests ─────────────────────────────────────────────────────────

export interface DriverRecipe {
  recipe: Recipe;
  // How far the FE value may sit from the closed form, in percent.
  tolPct: number;
}

// Axial bar: δ = P·L / (E·A), a force on the end face.
const axialP = 1e6;
const barForce: DriverRecipe = {
  tolPct: 2,
  recipe: {
    step: () => block(L, 100, 100, "Bar"),
    splits: [],
    discretization: { kind: "solid" },
    mesh: { maxElementSize: 25, order: 1 },
    material: STEEL,
    supports: [
      {
        name: "Fixed end",
        faces: [{ at: [0, 50, 50] }],
        dofs: [0, 1, 2],
        value: 0,
      },
    ],
    loads: [
      {
        name: "Pull",
        kind: "force",
        faces: [{ at: [L, 50, 50] }],
        components: [axialP, 0, 0],
      },
    ],
    readout: {
      quantity: "Tip extension",
      probe: {
        kind: "displacement",
        component: 0,
        faces: [{ at: [L, 50, 50] }],
        unit: "mm",
      },
      formula: "P·L / (E·A)",
      reference: (axialP * L) / (STEEL.young * 100 * 100),
    },
  },
};

// Bar under end pressure: u = −p·L / E. The four long sides are first cut at
// mid-length (one faces split, four faces picked from four sides): the
// geometry changes, the answer does not.
const p = 1;
const barPressure: DriverRecipe = {
  tolPct: 2,
  recipe: {
    step: () => block(L, 100, 100, "Pressure bar"),
    splits: [
      {
        mode: "faces",
        faces: [
          { at: [300, 0, 50] },
          { at: [300, 100, 50] },
          { at: [300, 50, 0] },
          { at: [300, 50, 100] },
        ],
        origin: [500, 0, 0],
        normal: [1, 0, 0],
      },
    ],
    discretization: { kind: "solid" },
    mesh: { maxElementSize: 25, order: 1 },
    material: STEEL,
    supports: [
      {
        name: "Fixed end",
        faces: [{ at: [0, 50, 50] }],
        dofs: [0, 1, 2],
        value: 0,
      },
    ],
    loads: [
      {
        name: "End pressure",
        kind: "pressure",
        faces: [{ at: [L, 50, 50] }],
        value: p,
      },
    ],
    readout: {
      quantity: "Tip displacement",
      probe: {
        kind: "displacement",
        component: 0,
        faces: [{ at: [L, 50, 50] }],
        unit: "mm",
      },
      formula: "−p·L / E",
      reference: (-p * L) / STEEL.young,
    },
  },
};

// Square beam in torsion (as the beam-torsion case): θ = T·L / (G·K),
// K = β·b⁴, β = 1/3 − 0.21·(1 − 1/12). The clamp holds the warping back, hence
// the band.
const b = 100;
const T = 1e6;
const G = STEEL.young / (2 * (1 + STEEL.poisson));
const K = (1 / 3 - 0.21 * (1 - 1 / 12)) * b ** 4;
const boxMoment: DriverRecipe = {
  tolPct: 6,
  recipe: {
    step: () => block(L, b, b, "Torsion beam"),
    splits: [],
    discretization: { kind: "solid" },
    mesh: { maxElementSize: 25, order: 2 },
    material: STEEL,
    supports: [
      {
        name: "Clamped end",
        faces: [{ at: [0, 50, 50] }],
        dofs: [0, 1, 2],
        value: 0,
      },
    ],
    loads: [
      {
        name: "Torque",
        kind: "moment",
        faces: [{ at: [L, 50, 50] }],
        axis: 0,
        value: T,
      },
    ],
    readout: {
      quantity: "Angle of twist",
      probe: {
        kind: "twist",
        axis: 0,
        faces: [{ at: [L, 50, 50] }],
        unit: "rad",
      },
      formula: "T·L / (G·K)",
      reference: (T * L) / (G * K),
    },
  },
};
/* eslint-enable kofem/min-identifier-length */

export const DRIVER_RECIPES: Record<string, DriverRecipe> = {
  "bar-force": barForce,
  "bar-pressure-split": barPressure,
  "box-moment": boxMoment,
};
