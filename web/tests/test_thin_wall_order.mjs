// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Thin walls with linear tets (KOF-274): the regression case behind the
// pre-flight warning in src/lib/thinWallCheck.ts.
//
// A 100 × 20 × 3 mm steel cantilever plate, meshed by Netgen with the app's
// settings at a 3 mm max element size (about one element through the
// thickness), clamped at x = 0 with 10 N on the free end across the thickness.
// Euler–Bernoulli gives δ = P·L³/(3·E·I), I = b·t³/12 = 0.353 mm.
//
//   - order 1 locks: well under half the deflection, with no error raised;
//   - order 2 on the same mesh lands within 5 % of the beam reference;
//   - underResolvedWalls flags the plate (3 mm wall, < 4 elements through it),
//     and not a 30 mm cube meshed at 5 mm, a Shell body or a suppressed body.
//
// Meshing and each solve run in separate module instances, as the browser
// does (see test_wall_bracket.mjs).
//
// Run:  bun tests/test_thin_wall_order.mjs   (from the web/ directory)

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { prismStep } from "../../examples/gallery/step-prism.mjs";
import {
  MIN_LINEAR_ELEMENTS_THROUGH_WALL,
  underResolvedWalls,
} from "../src/lib/thinWallCheck.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "../src/wasm/pkg");
const wasmBinary = readFileSync(join(pkg, "kofem_wasm_emcc.wasm")).buffer;
const { default: createModule } = await import(join(pkg, "kofem_wasm_emcc.js"));
const makeModule = () =>
  createModule({ wasmBinary, print: () => {}, printErr: () => {} });

let failures = 0;
function check(name, cond, detail = "") {
  console.log(
    `  [${cond ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`,
  );
  if (!cond) failures++;
}

// Mesh a prism (polygon in xy, extruded along z) the way the app's worker does.
async function meshPrism(polygon, depth, maxElementSize) {
  const step = new TextEncoder().encode(prismStep(polygon, depth, "part"));
  const mesher = await makeModule();
  mesher.tessellate_step(
    step,
    JSON.stringify({
      deflection_relative: 0.001,
      angular_deflection: 0.5,
      format: "step",
    }),
  );
  const dto = mesher.generate_fem_mesh(
    JSON.stringify({
      max_element_size: maxElementSize,
      min_element_size: maxElementSize / 10,
      grading: 0.3,
      second_order: false,
      elementsperedge: 2.0,
      elementspercurve: 2.0,
      optsteps_2d: 3,
      optsteps_3d: 3,
    }),
  );
  const nodes = [];
  for (let i = 0; i < dto.vertices.length / 3; i++)
    nodes.push({
      id: i,
      x: dto.vertices[3 * i],
      y: dto.vertices[3 * i + 1],
      z: dto.vertices[3 * i + 2],
    });
  const elements = [];
  for (let i = 0; i < dto.tetrahedra.length / 4; i++)
    elements.push({
      id: i,
      type: "CTETRA",
      nodeIds: Array.from(dto.tetrahedra.subarray(4 * i, 4 * i + 4)),
      propertyId: dto.bodyIds[i],
    });
  const surfaceTriangles = [];
  for (let t = 0; t < dto.surfaceTriangles.length / 3; t++)
    surfaceTriangles.push(
      Array.from(dto.surfaceTriangles.subarray(3 * t, 3 * t + 3)),
    );
  return {
    dto,
    model: {
      nodes,
      elements,
      surfaceTriangles,
      surfaceFaceIds: Array.from(dto.surfaceFaceIds),
    },
  };
}

/* eslint-disable kofem/min-identifier-length -- symbols from the Euler–Bernoulli formula: δ = P·L³/(3·E·I), I = b·t³/12 */
const L = 100,
  b = 20,
  t = 3,
  E = 210000,
  P = 10;
const I = (b * t ** 3) / 12;
const reference = (P * L ** 3) / (3 * E * I);

// Thickness along y, width along z: the load in −y bends the plate about z.
const plate = await meshPrism(
  [
    [0, 0],
    [L, 0],
    [L, t],
    [0, t],
  ],
  b,
  3,
);
const V = plate.dto.vertices;
const nNodes = V.length / 3;
const fixed = [];
const tip = [];
for (let i = 0; i < nNodes; i++) {
  if (V[3 * i] < 1e-6) fixed.push(i);
  if (V[3 * i] > L - 1e-6) tip.push(i);
}

async function tipDeflection(order) {
  const solver = await makeModule();
  const result = solver.solve_linear_elastic(
    {
      vertices: V,
      tetrahedra: plate.dto.tetrahedra,
      hexahedra: new Int32Array(0),
    },
    JSON.stringify({ young_modulus: E, poisson_ratio: 0.3 }),
    JSON.stringify({
      fixed_vertices: fixed,
      point_loads: tip.map((v) => ({
        vertex: v,
        force: [0, -P / tip.length, 0],
      })),
    }),
    order,
  );
  if ("error" in result) throw new Error(result.error);
  return (
    -tip.reduce((s, v) => s + result.displacements[3 * v + 1], 0) / tip.length
  );
}

console.log(
  `\nCantilever plate ${L} × ${b} × ${t} mm, ${plate.model.elements.length} tets; δ_ref = ${reference.toFixed(4)} mm`,
);
const linear = await tipDeflection(1);
const quadratic = await tipDeflection(2);
console.log(
  `  order 1: δ = ${linear.toFixed(4)} mm (${((100 * linear) / reference).toFixed(0)} %)`,
);
console.log(
  `  order 2: δ = ${quadratic.toFixed(4)} mm (${((100 * quadratic) / reference).toFixed(0)} %)`,
);
check(
  "linear tets lock on the thin wall",
  linear < 0.5 * quadratic,
  `order 1 gives ${((100 * linear) / quadratic).toFixed(0)} % of order 2`,
);
check(
  "quadratic tets resolve it on the same mesh",
  Math.abs(quadratic - reference) < 0.05 * reference,
  `${((100 * (quadratic - reference)) / reference).toFixed(1)} % from the beam reference`,
);

const solid = [{ id: 1, materialId: 1, discretization: "solid" }];
const walls = underResolvedWalls({ ...plate.model, properties: solid });
check(
  "the plate is flagged",
  walls.length === 1 && walls[0].bodyId === 1,
  JSON.stringify(walls),
);
if (walls.length === 1) {
  check(
    "at its 3 mm thickness",
    Math.abs(walls[0].thickness - t) < 1e-6,
    `${walls[0].thickness} mm`,
  );
  check(
    `with fewer than ${MIN_LINEAR_ELEMENTS_THROUGH_WALL} elements through it`,
    walls[0].elementsThrough < 2,
    walls[0].elementsThrough.toFixed(2),
  );
}
check(
  "a Shell body is not flagged",
  underResolvedWalls({
    ...plate.model,
    properties: [{ id: 1, materialId: 1, discretization: "shell" }],
  }).length === 0,
);
check(
  "a suppressed body is not flagged",
  underResolvedWalls({
    ...plate.model,
    properties: [{ ...solid[0], suppressed: true }],
  }).length === 0,
);
check(
  "a model without a surface mesh is not checked",
  underResolvedWalls({
    ...plate.model,
    surfaceTriangles: null,
    surfaceFaceIds: null,
    properties: solid,
  }).length === 0,
);

const cube = await meshPrism(
  [
    [0, 0],
    [30, 0],
    [30, 30],
    [0, 30],
  ],
  30,
  5,
);
const cubeWalls = underResolvedWalls({ ...cube.model, properties: solid });
check(
  "a 30 mm cube meshed at 5 mm is not flagged",
  cubeWalls.length === 0,
  JSON.stringify(cubeWalls),
);

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nPASS");
