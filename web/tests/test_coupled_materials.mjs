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
// Run:  bun tests/test_coupled_materials.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const PKG = join(here, "../src/wasm/pkg");
const { default: createModule } = await import(join(PKG, "kofem_wasm_emcc.js"));
const Module = await createModule({
  wasmBinary: readFileSync(join(PKG, "kofem_wasm_emcc.wasm")).buffer,
  print: () => {},
  printErr: () => {},
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
// auto-fixed by the core).
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
  return Module.solve_coupled(
    meshArg,
    {
      ref: new Int32Array(0),
      offsets: Int32Array.from([0]),
      solid: new Int32Array(0),
      mpc: new Int32Array(0),
      relaxation: 1.0,
    },
    {
      fixed_dofs: Int32Array.from(fixed),
      load_dofs: Int32Array.from(load_dofs),
      load_vals: Float64Array.from(load_vals),
    },
    JSON.stringify({ solid: mats, shell: STEEL }),
  );
};

// solve_linear_elastic: the reference per-element-attribute path (#353).
const linear = (mats) => {
  const solved = Module.solve_linear_elastic(
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
  if ("error" in solved)
    throw new Error(`solve_linear_elastic: ${solved.error}`);
  return maxU(solved.displacements);
};

console.log("per-body solid materials in the coupled solve:");

// ── The legacy single-material contract is untouched ─────────────────────────
const legacy = coupled(STEEL, null);
const arrayOfOne = coupled([STEEL], null);
if ("error" in legacy) throw new Error(`legacy form: ${legacy.error}`);
if ("error" in arrayOfOne) throw new Error(`array of one: ${arrayOfOne.error}`);
check(
  "a bare material object still means 'every tet uses this'",
  maxU(legacy.displacements) === maxU(arrayOfOne.displacements),
  `object ${maxU(legacy.displacements)} vs array ${maxU(arrayOfOne.displacements)}`,
);

// ── Cross-validation against solve_linear_elastic ────────────────────────────
for (const [name, mats] of [
  ["both steel", [STEEL, STEEL]],
  ["tip block aluminium", [STEEL, ALU]],
  ["root block aluminium", [ALU, STEEL]],
]) {
  const solved = coupled(mats, attributes);
  if ("error" in solved) {
    check(`coupled solves ${name}`, false, solved.error);
    continue;
  }
  const got = maxU(solved.displacements),
    want = linear(mats);
  check(
    `${name}: coupled matches solve_linear_elastic`,
    Math.abs(got / want - 1) < 1e-3,
    `coupled ${got.toPrecision(6)} vs linear ${want.toPrecision(6)}`,
  );
}

// Softening only the tip half must move the answer — a solver that quietly used
// material 1 everywhere would pass the "both steel" case and nothing else.
{
  const stiff = maxU(coupled([STEEL, STEEL], attributes).displacements);
  const soft = maxU(coupled([STEEL, ALU], attributes).displacements);
  check(
    "the second material actually reaches the elements that select it",
    soft > 1.2 * stiff,
    `both steel ${stiff.toPrecision(4)}, tip aluminium ${soft.toPrecision(4)}`,
  );
}

// ── Bad input is named, not absorbed ─────────────────────────────────────────
{
  const bad = attributes.slice();
  bad[0] = 3; // only two materials are supplied
  const solved = coupled([STEEL, ALU], bad);
  check(
    "an attribute with no material is refused, naming the tet and the range",
    "error" in solved &&
      /material 3/.test(solved.error) &&
      /1\.\.2/.test(solved.error),
    "error" in solved ? solved.error : "the solve succeeded",
  );
  const short = coupled([STEEL, ALU], attributes.slice(0, 5));
  check(
    "an attribute array that does not cover every tet is refused",
    "error" in short && /attributes/.test(short.error),
    "error" in short ? short.error : "the solve succeeded",
  );
}

console.log(
  failures === 0
    ? "\nall coupled material checks passed"
    : `\n${failures} check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
