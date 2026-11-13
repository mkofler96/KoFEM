// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Per-body shell materials through the engine's entry points (issue #389).
//
// solve_shell and solve_coupled used to read ONE shell (E, ν), so a steel shell
// body joined to an aluminium one could not be solved. The shell material is
// now one object or an ARRAY selected per triangle by 1-based attributes
// (`mesh.attributes` for solve_shell, `mesh.shell_attributes` for
// solve_coupled) — the contract solve_linear_elastic uses for solids.
//
// Reference: a strip in uniaxial tension with ν = 0, split across its length
// into a steel and an aluminium half. The halves act in series, so the end
// moves by σ·(L/2)·(1/E₁ + 1/E₂) and every facet carries σ.

import { beforeAll, describe, expect, test } from "bun:test";
import { loadEngine } from "../support/wasm.mjs";

let Module;
beforeAll(async () => {
  Module = await loadEngine();
});

// Relative tolerance, as the old close(): |got - ref| <= relTol * |ref|.
function expectClose(got, ref, relTol) {
  expect(Math.abs(got - ref), `${got} vs ${ref}`).toBeLessThanOrEqual(
    relTol * Math.abs(ref),
  );
}

const STEEL = { young_modulus: 210000, poisson_ratio: 0 };
const ALU = { young_modulus: 70000, poisson_ratio: 0 };
const LENGTH = 100,
  WIDTH = 25,
  THICKNESS = 1,
  NX = 8,
  NY = 2,
  SIGMA = 10;

const id = (i, j) => i * (NY + 1) + j;
const vertices = [];
for (let i = 0; i <= NX; i++)
  for (let j = 0; j <= NY; j++)
    vertices.push((LENGTH * i) / NX, (WIDTH * j) / NY, 0);
const triangles = [];
const attributes = [];
for (let i = 0; i < NX; i++)
  for (let j = 0; j < NY; j++) {
    triangles.push(id(i, j), id(i + 1, j), id(i + 1, j + 1));
    triangles.push(id(i, j), id(i + 1, j + 1), id(i, j + 1));
    const material = i < NX / 2 ? 1 : 2;
    attributes.push(material, material);
  }
const nNodes = (NX + 1) * (NY + 1);
const nTris = triangles.length / 3;

// Membrane only: w and the rotations are held everywhere, x = 0 holds ux, and
// the y = 0 edge holds uy (ν = 0, so this adds no stress).
const fixedDofsOf = (v) => {
  const dofs = [2, 3, 4, 5];
  if (v <= NY) dofs.push(0);
  if (v % (NY + 1) === 0) dofs.push(1);
  return dofs;
};
const endForce = (j) =>
  ((SIGMA * WIDTH * THICKNESS) / NY) * (j === 0 || j === NY ? 0.5 : 1);

const shellMesh = (withAttributes) => ({
  vertices: Float64Array.from(vertices),
  triangles: Int32Array.from(triangles),
  thicknesses: new Float64Array(nTris).fill(THICKNESS),
  ...(withAttributes ? { attributes: Int32Array.from(withAttributes) } : {}),
});
const shellBcs = JSON.stringify({
  fixed_dofs: Array.from({ length: nNodes }, (_, v) => ({
    vertex: v,
    dofs: fixedDofsOf(v),
  })),
  point_loads: Array.from({ length: NY + 1 }, (_, j) => ({
    vertex: id(NX, j),
    force: [endForce(j), 0, 0],
  })),
});
const solveShell = (mats, attrs) =>
  Module.solve_shell(shellMesh(attrs), JSON.stringify(mats), shellBcs);

const endUx = (disp) => {
  let sum = 0;
  for (let j = 0; j <= NY; j++) sum += disp[3 * id(NX, j)];
  return sum / (NY + 1);
};
const uniform = (E) => (SIGMA * LENGTH) / E;
const SERIES =
  SIGMA * (LENGTH / 2) * (1 / STEEL.young_modulus + 1 / ALU.young_modulus);

describe("solve_shell — per-triangle materials", () => {
  let series;
  let swapped;
  let single;
  let arrayOfOne;
  let allSecond;
  beforeAll(() => {
    series = solveShell([STEEL, ALU], attributes);
    // The array order must not matter — only what each attribute selects.
    swapped = solveShell(
      [ALU, STEEL],
      attributes.map((a) => 3 - a),
    );
    // Uniform cases: array-of-one, the single-object form, and a two-material
    // array whose attributes all select one entry must agree.
    single = solveShell(STEEL);
    arrayOfOne = solveShell([STEEL]);
    allSecond = solveShell(
      [STEEL, ALU],
      attributes.map(() => 2),
    );
  });

  test("two-material shell solves", () => {
    expect(series.error, series.error).toBeUndefined();
  });

  test("series strip extension matches σ·(L/2)·(1/E₁ + 1/E₂)", () => {
    expect(series.error, series.error).toBeUndefined();
    expectClose(endUx(series.displacements), SERIES, 1e-6);
  });

  test("every facet carries σ, whichever material it is", () => {
    expect(series.error, series.error).toBeUndefined();
    for (const stress of series.von_mises) expectClose(stress, SIGMA, 1e-6);
  });

  test("swapping the array order and the attributes gives the same answer", () => {
    expect(swapped.error, swapped.error).toBeUndefined();
    expectClose(endUx(swapped.displacements), SERIES, 1e-6);
  });

  test("single object still solves (uniform steel)", () => {
    expect(single.error, single.error).toBeUndefined();
    expectClose(endUx(single.displacements), uniform(210000), 1e-6);
  });

  test("array of one equals the single object", () => {
    expect(arrayOfOne.error, arrayOfOne.error).toBeUndefined();
    expectClose(endUx(arrayOfOne.displacements), uniform(210000), 1e-6);
  });

  test("attributes all selecting aluminium solve as uniform aluminium", () => {
    expect(allSecond.error, allSecond.error).toBeUndefined();
    expectClose(endUx(allSecond.displacements), uniform(70000), 1e-6);
  });
});

describe("solve_shell — invalid material payloads are refused", () => {
  const refused = (result, pattern) =>
    expect(result.error ?? "no error").toMatch(pattern);

  test("several materials without attributes", () => {
    refused(
      solveShell([STEEL, ALU]),
      /2 shell materials were given but no mesh\.attributes/,
    );
  });

  test("attribute outside the material array", () => {
    refused(
      solveShell(
        [STEEL, ALU],
        attributes.map((a, e) => (e === 3 ? 3 : a)),
      ),
      /triangle 3 selects shell material 3, outside 1\.\.2/,
    );
  });

  test("attribute count differing from the triangle count", () => {
    refused(
      solveShell([STEEL, ALU], attributes.slice(1)),
      /mesh\.attributes has 31 entries for 32 triangles/,
    );
  });

  test("empty material array", () => {
    refused(solveShell([]), /materials array is empty/);
  });

  test("material missing its Poisson ratio", () => {
    refused(
      solveShell([STEEL, { young_modulus: 70000 }], attributes),
      /shell material 2 is missing poisson_ratio/,
    );
  });
});

// solve_coupled with shell facets only (no tets, no couplings): the coupled
// assembler must honour the same per-triangle shell materials.
describe("solve_coupled — per-triangle shell materials", () => {
  const fixed = [];
  for (let v = 0; v < nNodes; v++)
    for (const d of fixedDofsOf(v)) fixed.push(6 * v + d);
  const coupled = (shell, shellAttributes) =>
    Module.solve_coupled(
      {
        vertices: Float64Array.from(vertices),
        tets: new Int32Array(0),
        triangles: Int32Array.from(triangles),
        thicknesses: new Float64Array(nTris).fill(THICKNESS),
        ...(shellAttributes
          ? { shell_attributes: Int32Array.from(shellAttributes) }
          : {}),
      },
      {
        ref: new Int32Array(0),
        offsets: Int32Array.from([0]),
        solid: new Int32Array(0),
        mpc: new Int32Array(0),
        relaxation: 1.0,
      },
      {
        fixed_dofs: Int32Array.from(fixed),
        load_dofs: Int32Array.from(
          Array.from({ length: NY + 1 }, (_, j) => 6 * id(NX, j)),
        ),
        load_vals: Float64Array.from(
          Array.from({ length: NY + 1 }, (_, j) => endForce(j)),
        ),
      },
      JSON.stringify({ solid: STEEL, shell }),
    );

  let series;
  let single;
  let missing;
  beforeAll(() => {
    series = coupled([STEEL, ALU], attributes);
    single = coupled(STEEL);
    missing = coupled([STEEL, ALU]);
  });

  test("two-material coupled shell solves", () => {
    expect(series.error, series.error).toBeUndefined();
  });

  test("coupled series strip extension matches the closed form", () => {
    expect(series.error, series.error).toBeUndefined();
    expectClose(endUx(series.displacements), SERIES, 1e-6);
  });

  test("coupled shell facets carry σ", () => {
    expect(series.error, series.error).toBeUndefined();
    for (const stress of series.von_mises_tris)
      expectClose(stress, SIGMA, 1e-6);
  });

  test("single shell object still solves (uniform steel)", () => {
    expect(single.error, single.error).toBeUndefined();
    expectClose(endUx(single.displacements), uniform(210000), 1e-6);
  });

  test("several shell materials without shell_attributes are refused", () => {
    expect(missing.error ?? "no error").toMatch(/no mesh\.shell_attributes/);
  });
});
