// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Per-body solid materials in the coupled solve.
//
// solve_coupled used to read ONE solid material, so an assembly of a steel
// bracket carrying an aluminium part could not be solved at all through the
// coupled path — and solve_linear_elastic, which does take a material array,
// does not converge on models containing sub-millimetre walls. `mat.solid` now
// accepts an array selected per tet by `mesh.attributes` (1-based).
//
// The check that matters is cross-validation: on a two-block cantilever that
// BOTH solvers can handle, solve_coupled's per-material answer must equal
// solve_linear_elastic's, which has carried per-element attributes since #353.
//
// Both run on the app's Rust paths (web/tests/support/rust-solvers.mjs): the
// coupled entry is the mixed solid/shell solve (lib/solve/coupledRust.ts), the
// linear-elastic entry the solid AMG solve (lib/solve/amg.ts) — two separate
// assemblies of the same per-element materials.

import { beforeAll, describe, expect, test } from "bun:test";
import { loadRustSolvers } from "../support/rust-solvers.mjs";

const STEEL = { young_modulus: 210000, poisson_ratio: 0.3 };
const ALU = { young_modulus: 70000, poisson_ratio: 0.3 };

// ── Two-block cantilever: body 1 (x < 20) then body 2, clamped at x = 0 ───────
const verts = [];
const index = new Map();
const addV = (x, y, z) => {
  const key = `${x},${y},${z}`;
  let i = index.get(key);
  if (i === undefined) {
    i = verts.length / 3;
    index.set(key, i);
    verts.push(x, y, z);
  }
  return i;
};
const KUHN = [
  [0, 1, 3, 7],
  [0, 3, 2, 7],
  [0, 2, 6, 7],
  [0, 6, 4, 7],
  [0, 4, 5, 7],
  [0, 5, 1, 7],
];
const tet = [];
const attributes = [];
const NX = 8,
  NY = 3,
  NZ = 3,
  CELL = 5;
for (let i = 0; i < NX; i++)
  for (let j = 0; j < NY; j++)
    for (let k = 0; k < NZ; k++) {
      const gid = (a, b, c) =>
        addV((i + a) * CELL, (j + b) * CELL, (k + c) * CELL);
      const cell = [
        gid(0, 0, 0),
        gid(1, 0, 0),
        gid(0, 1, 0),
        gid(1, 1, 0),
        gid(0, 0, 1),
        gid(1, 0, 1),
        gid(0, 1, 1),
        gid(1, 1, 1),
      ];
      for (const t of KUHN) {
        tet.push(cell[t[0]], cell[t[1]], cell[t[2]], cell[t[3]]);
        attributes.push(i < NX / 2 ? 1 : 2);
      }
    }
const nVerts = verts.length / 3;
const clamped = [],
  tipNodes = [];
for (let i = 0; i < nVerts; i++) {
  if (Math.abs(verts[3 * i]) < 1e-9) clamped.push(i);
  if (Math.abs(verts[3 * i] - NX * CELL) < 1e-9) tipNodes.push(i);
}
let solvers = null;
const TIP_FORCE = -100;

const maxU = (disp) => {
  let mx = 0;
  for (let i = 0; i < nVerts; i++)
    mx = Math.max(
      mx,
      Math.hypot(disp[3 * i], disp[3 * i + 1], disp[3 * i + 2]),
    );
  return mx;
};

// solve_coupled: tets only, no shells, no couplings (solid-only rotations are
// auto-fixed by the core). Rejects with the Rust path's error on bad input.
const coupled = (mats, attrs) => {
  const fixed = [],
    load_dofs = [],
    load_vals = [];
  for (const v of clamped) for (let c = 0; c < 3; c++) fixed.push(6 * v + c);
  for (const v of tipNodes) {
    load_dofs.push(6 * v + 1);
    load_vals.push(TIP_FORCE / tipNodes.length);
  }
  const meshArg = {
    vertices: Float64Array.from(verts),
    tets: Int32Array.from(tet),
    triangles: new Int32Array(0),
    thicknesses: new Float64Array(0),
  };
  if (attrs) meshArg.attributes = Int32Array.from(attrs);
  return solvers.solve_coupled(
    meshArg,
    {
      ref: new Int32Array(0),
      offsets: Int32Array.from([0]),
      solid: new Int32Array(0),
      mpc: new Int32Array(0),
      dof_mask: new Int32Array(0),
      relaxation: 1.0,
    },
    {
      fixed_dofs: Int32Array.from(fixed),
      prescribed_dofs: new Int32Array(0),
      prescribed_vals: new Float64Array(0),
      load_dofs: Int32Array.from(load_dofs),
      load_vals: Float64Array.from(load_vals),
    },
    JSON.stringify({ solid: mats, shell: STEEL }),
  );
};

// solve_linear_elastic: the reference per-element-attribute path (#353).
const linear = async (mats) => {
  const solved = await solvers.solve_linear_elastic(
    {
      vertices: Float64Array.from(verts),
      tetrahedra: Int32Array.from(tet),
      hexahedra: new Int32Array(0),
      attributes: Int32Array.from(attributes),
    },
    JSON.stringify(mats),
    JSON.stringify({
      fixed_vertices: clamped,
      point_loads: tipNodes.map((v) => ({
        vertex: v,
        force: [0, TIP_FORCE / tipNodes.length, 0],
      })),
    }),
    1,
  );
  return maxU(solved.displacements);
};

describe("per-body solid materials in the coupled solve", () => {
  beforeAll(async () => {
    // The refusal cases below EXPECT the solver to fail; their messages are
    // asserted on from the rejected Error.
    solvers = await loadRustSolvers();
  });

  // ── The legacy single-material contract is untouched ───────────────────────
  test("a bare material object still means 'every tet uses this'", async () => {
    const legacy = await coupled(STEEL, null);
    const arrayOfOne = await coupled([STEEL], null);
    const objectForm = maxU(legacy.displacements);
    const arrayForm = maxU(arrayOfOne.displacements);
    // toBe(NaN, NaN) would pass where the old === did not.
    expect(objectForm).not.toBeNaN();
    expect(objectForm, `object ${objectForm} vs array ${arrayForm}`).toBe(
      arrayForm,
    );
  });

  // ── Cross-validation against solve_linear_elastic ──────────────────────────
  describe.each([
    ["both steel", [STEEL, STEEL]],
    ["tip block aluminium", [STEEL, ALU]],
    ["root block aluminium", [ALU, STEEL]],
  ])("%s", (name, mats) => {
    test("coupled solves it", async () => {
      const solved = await coupled(mats, attributes);
      expect(maxU(solved.displacements)).toBeGreaterThan(0);
    });

    test("coupled matches solve_linear_elastic", async () => {
      const solved = await coupled(mats, attributes);
      const got = maxU(solved.displacements);
      const want = await linear(mats);
      expect(
        Math.abs(got / want - 1),
        `coupled ${got.toPrecision(6)} vs linear ${want.toPrecision(6)}`,
      ).toBeLessThan(1e-3);
    });
  });

  // Softening only the tip half must move the answer — a solver that quietly
  // used material 1 everywhere would pass the "both steel" case and nothing
  // else.
  test("the second material actually reaches the elements that select it", async () => {
    const stiff = maxU(
      (await coupled([STEEL, STEEL], attributes)).displacements,
    );
    const soft = maxU((await coupled([STEEL, ALU], attributes)).displacements);
    expect(
      soft,
      `both steel ${stiff.toPrecision(4)}, tip aluminium ${soft.toPrecision(4)}`,
    ).toBeGreaterThan(1.2 * stiff);
  });

  // ── Bad input is named, not absorbed ───────────────────────────────────────
  test("an attribute with no material is refused, naming the tet and the range", async () => {
    const bad = attributes.slice();
    bad[0] = 3; // only two materials are supplied
    const refusal = coupled([STEEL, ALU], bad);
    await expect(refusal).rejects.toThrow(/tet 0 selects solid material 3/);
    await expect(refusal).rejects.toThrow(/1\.\.2/);
  });

  test("an attribute array that does not cover every tet is refused", async () => {
    await expect(coupled([STEEL, ALU], attributes.slice(0, 5))).rejects.toThrow(
      /5 mesh\.attributes for \d+ tets/,
    );
  });
});
