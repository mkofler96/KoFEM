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
//
// Run:  bun tests/test_shell_materials.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const PKG = join(here, "../src/wasm/pkg");
const { default: createModule } = await import(join(PKG, "kofem_wasm_emcc.js"));
const Module = await createModule({
  wasmBinary: readFileSync(join(PKG, "kofem_wasm_emcc.wasm")).buffer,
  print: () => {
    /* per-solve engine chatter; only the checks below are reported */
  },
  printErr: () => {
    /* the refusal cases EXPECT failures; they are asserted on from the result */
  },
});

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  [PASS] ${name}`);
  } else {
    failures++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const close = (got, ref, relTol) =>
  Math.abs(got - ref) <= relTol * Math.abs(ref);

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

console.log("solve_shell — per-triangle materials:");
{
  const series = solveShell([STEEL, ALU], attributes);
  check("two-material shell solves", !series.error, series.error);
  if (!series.error) {
    check(
      "series strip extension matches σ·(L/2)·(1/E₁ + 1/E₂)",
      close(endUx(series.displacements), SERIES, 1e-6),
      `${endUx(series.displacements)} vs ${SERIES}`,
    );
    check(
      "every facet carries σ, whichever material it is",
      series.von_mises.every((s) => close(s, SIGMA, 1e-6)),
    );
  }
  // The array order must not matter — only what each attribute selects.
  const swapped = solveShell(
    [ALU, STEEL],
    attributes.map((a) => 3 - a),
  );
  check(
    "swapping the array order and the attributes gives the same answer",
    !swapped.error && close(endUx(swapped.displacements), SERIES, 1e-6),
    swapped.error,
  );
  // Uniform cases: array-of-one, the single-object form, and a two-material
  // array whose attributes all select one entry must agree.
  const single = solveShell(STEEL);
  const arrayOfOne = solveShell([STEEL]);
  const allSecond = solveShell(
    [STEEL, ALU],
    attributes.map(() => 2),
  );
  check(
    "single object still solves (uniform steel)",
    !single.error && close(endUx(single.displacements), uniform(210000), 1e-6),
    single.error,
  );
  check(
    "array of one equals the single object",
    !arrayOfOne.error &&
      close(endUx(arrayOfOne.displacements), uniform(210000), 1e-6),
    arrayOfOne.error,
  );
  check(
    "attributes all selecting aluminium solve as uniform aluminium",
    !allSecond.error &&
      close(endUx(allSecond.displacements), uniform(70000), 1e-6),
    allSecond.error,
  );
}

console.log("solve_shell — invalid material payloads are refused:");
{
  const refused = (name, result, pattern) =>
    check(name, pattern.test(result.error ?? ""), result.error ?? "no error");
  refused(
    "several materials without attributes",
    solveShell([STEEL, ALU]),
    /2 shell materials were given but no mesh\.attributes/,
  );
  refused(
    "attribute outside the material array",
    solveShell(
      [STEEL, ALU],
      attributes.map((a, e) => (e === 3 ? 3 : a)),
    ),
    /triangle 3 selects shell material 3, outside 1\.\.2/,
  );
  refused(
    "attribute count differing from the triangle count",
    solveShell([STEEL, ALU], attributes.slice(1)),
    /mesh\.attributes has 31 entries for 32 triangles/,
  );
  refused("empty material array", solveShell([]), /materials array is empty/);
  refused(
    "material missing its Poisson ratio",
    solveShell([STEEL, { young_modulus: 70000 }], attributes),
    /shell material 2 is missing poisson_ratio/,
  );
}

// solve_coupled with shell facets only (no tets, no couplings): the coupled
// assembler must honour the same per-triangle shell materials.
console.log("solve_coupled — per-triangle shell materials:");
{
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
  const series = coupled([STEEL, ALU], attributes);
  check("two-material coupled shell solves", !series.error, series.error);
  if (!series.error) {
    check(
      "coupled series strip extension matches the closed form",
      close(endUx(series.displacements), SERIES, 1e-6),
      `${endUx(series.displacements)} vs ${SERIES}`,
    );
    check(
      "coupled shell facets carry σ",
      series.von_mises_tris.every((s) => close(s, SIGMA, 1e-6)),
    );
  }
  const single = coupled(STEEL);
  check(
    "single shell object still solves (uniform steel)",
    !single.error && close(endUx(single.displacements), uniform(210000), 1e-6),
    single.error,
  );
  const missing = coupled([STEEL, ALU]);
  check(
    "several shell materials without shell_attributes are refused",
    /no mesh\.shell_attributes/.test(missing.error ?? ""),
    missing.error ?? "no error",
  );
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall checks passed");
