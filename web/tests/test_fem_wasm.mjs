// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Rust finite-element module (crates/kofem-wasm) against the MFEM engine.
//
// Both solve the same linear-tet cantilever: same mesh, supports and nodal
// loads, the same CG method (one symmetric Gauss–Seidel sweep, relative
// tolerance 1e-6 in the preconditioned norm). Their displacements must agree
// to the solver tolerance, so any difference in the element, the assembly or
// the boundary-condition handling shows up here. The Rust multigrid
// preconditioner (SA-AMG), stopped on the force residual ‖f − K·u‖/‖f‖, must
// reach the same displacements. A clamped cantilever of
// linear tets is stiff in bending, so the beam-theory check only bounds the
// result from above.
//
// Quadratic (order 2) tets are then checked the same way, displacements and
// element von Mises stress, on the cantilever and on a thin wall one element
// thick that carries a pressure surface load (6-node faces) and a prescribed
// displacement (extended to the edge nodes, as in MFEM).
//
// Usage:  bash ../scripts/build-fem-wasm.sh && bun tests/test_fem_wasm.mjs
//         (from web/; the MFEM engine comes from scripts/fetch-wasm-engine.sh)

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { boxHexMesh } from "../../examples/validation/lib/mesh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const enginePkg = join(here, "../src/wasm/pkg");
const femPkg = join(here, "../src/wasm/fem");

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

// ── Mesh: a box of hexes, each split into six tets (Kuhn) ─────────────────────
const LENGTH = 100;
const WIDTH = 10;
const HEIGHT = 10;
const box = boxHexMesh(LENGTH, WIDTH, HEIGHT, 40, 4, 4);
// Hex corner order (MFEM AddHex) for each Kuhn cube corner bx + 2·by + 4·bz.
const HEX_OF_CUBE_CORNER = [0, 1, 3, 2, 4, 5, 7, 6];
const KUHN = [
  [0, 1, 3, 7],
  [0, 3, 2, 7],
  [0, 2, 6, 7],
  [0, 6, 4, 7],
  [0, 4, 5, 7],
  [0, 5, 1, 7],
];
const tetList = [];
for (const hex of box.hexahedra)
  for (const tet of KUHN)
    for (const corner of tet) tetList.push(hex[HEX_OF_CUBE_CORNER[corner]]);
const vertices = new Float64Array(box.vertices.flat());
const tets = new Int32Array(tetList);
const nodeCount = box.vertices.length;

const YOUNG = 210000;
const POISSON = 0.3;
const TIP_FORCE = -1000; // total, in z, spread equally over the free end
const clamped = [];
const tip = [];
box.vertices.forEach(([x], node) => {
  if (Math.abs(x) < 1e-9) clamped.push(node);
  if (Math.abs(x - LENGTH) < 1e-9) tip.push(node);
});
const perNode = TIP_FORCE / tip.length;
console.log(
  `cantilever: ${nodeCount} nodes, ${tets.length / 4} tets, ${clamped.length} clamped, ${tip.length} loaded`,
);

// ── MFEM engine ───────────────────────────────────────────────────────────────
const { default: createModule } = await import(
  join(enginePkg, "kofem_wasm_emcc.js")
);
const engine = await createModule({
  wasmBinary: readFileSync(join(enginePkg, "kofem_wasm_emcc.wasm")).buffer,
  print: () => {},
  printErr: () => {},
});
const mfem = engine.solve_linear_elastic(
  { vertices, tetrahedra: tets, hexahedra: new Int32Array(0) },
  JSON.stringify({ young_modulus: YOUNG, poisson_ratio: POISSON }),
  JSON.stringify({
    fixed_vertices: clamped,
    point_loads: tip.map((vertex) => ({ vertex, force: [0, 0, perNode] })),
  }),
  1,
);
assert(!("error" in mfem), `MFEM solve failed: ${mfem.error}`);

// ── Rust module ───────────────────────────────────────────────────────────────
const {
  default: init,
  ElasticModel,
  SolveOptions,
} = await import(join(femPkg, "kofem_wasm.js"));
await init({
  module_or_path: readFileSync(join(femPkg, "kofem_wasm_bg.wasm")),
});
const model = new ElasticModel(
  vertices,
  new Uint32Array(tetList),
  new Uint32Array(tets.length / 4),
  new Float64Array([YOUNG, POISSON]),
  1,
);
model.assemble();
const fixedDofs = new Uint32Array(
  clamped.flatMap((node) => [3 * node, 3 * node + 1, 3 * node + 2]),
);
const forces = new Float64Array(model.dofCount);
for (const node of tip) forces[3 * node + 2] = perNode;
// MFEM's method and stopping rule, so the two must agree to the tolerance.
const rust = model.solve(
  fixedDofs,
  new Float64Array(fixedDofs.length),
  forces,
  new SolveOptions(1e-6, 20000, "gauss-seidel", "preconditioned"),
);
const amg = model.solve(
  fixedDofs,
  new Float64Array(fixedDofs.length),
  forces,
  new SolveOptions(1e-6, 20000, "amg", "residual"),
);

// ── Compare ───────────────────────────────────────────────────────────────────
let maxMfem = 0;
let maxDifference = 0;
for (let i = 0; i < rust.displacements.length; i++) {
  maxMfem = Math.max(maxMfem, Math.abs(mfem.displacements[i]));
  maxDifference = Math.max(
    maxDifference,
    Math.abs(rust.displacements[i] - mfem.displacements[i]),
  );
}
const relative = maxDifference / maxMfem;
console.log(
  `max |u| ${maxMfem.toExponential(4)} mm, Rust − MFEM ${maxDifference.toExponential(3)} mm ` +
    `(${relative.toExponential(2)} relative), Rust CG ${rust.iterations} iterations`,
);
assert(
  relative < 1e-5,
  `Rust and MFEM displacements differ by ${relative} relative`,
);

let maxAmgDifference = 0;
for (let i = 0; i < amg.displacements.length; i++)
  maxAmgDifference = Math.max(
    maxAmgDifference,
    Math.abs(amg.displacements[i] - mfem.displacements[i]),
  );
const amgRelative = maxAmgDifference / maxMfem;
console.log(
  `AMG − MFEM ${amgRelative.toExponential(2)} relative, AMG CG ${amg.iterations} iterations, ` +
    `levels [${Array.from(amg.levelSizes).join(", ")}]`,
);
assert(
  amgRelative < 1e-5,
  `Rust AMG and MFEM displacements differ by ${amgRelative} relative`,
);
assert(
  amg.iterations < rust.iterations,
  `AMG took ${amg.iterations} iterations, Gauss–Seidel ${rust.iterations}`,
);
for (const [preconditioner, stopping, pattern] of [
  ["ilu", "residual", /unknown preconditioner/],
  ["amg", "energy", /unknown stopping rule/],
]) {
  let refusal = "";
  try {
    new SolveOptions(1e-6, 10, preconditioner, stopping);
  } catch (error) {
    refusal = String(error);
  }
  assert(
    pattern.test(refusal),
    `SolveOptions(${preconditioner}, ${stopping}) must throw, got "${refusal}"`,
  );
}

const inertia = (WIDTH * HEIGHT ** 3) / 12;
const beamTip = (Math.abs(TIP_FORCE) * LENGTH ** 3) / (3 * YOUNG * inertia);
assert(
  maxMfem < beamTip && maxMfem > 0.3 * beamTip,
  `tip deflection ${maxMfem} should lie below Euler–Bernoulli ${beamTip} (linear tets are stiff)`,
);

// ── A floating model is refused, not solved ───────────────────────────────────
let refused = "";
try {
  model.solve(
    new Uint32Array(0),
    new Float64Array(0),
    forces,
    new SolveOptions(1e-6, 2000, "gauss-seidel", "preconditioned"),
  );
} catch (error) {
  refused = String(error);
}
assert(
  /positive definite|did not converge/.test(refused),
  `unconstrained solve must throw, got "${refused}"`,
);
console.log(`unconstrained model refused: ${refused}`);

let badOrder = "";
try {
  new ElasticModel(
    vertices,
    new Uint32Array(tetList),
    new Uint32Array(tets.length / 4),
    new Float64Array([YOUNG, POISSON]),
    3,
  );
} catch (error) {
  badOrder = String(error);
}
assert(
  /element order 3 is not supported/.test(badOrder),
  `order 3 must be refused, got "${badOrder}"`,
);

// ── Quadratic tetrahedra (order 2) ────────────────────────────────────────────
// A box of Kuhn tets, as above, with its vertex positions and connectivity.
function kuhnBox(length, width, height, nx, ny, nz) {
  const hexBox = boxHexMesh(length, width, height, nx, ny, nz);
  const corners = [];
  for (const hex of hexBox.hexahedra)
    for (const tet of KUHN)
      for (const corner of tet) corners.push(hex[HEX_OF_CUBE_CORNER[corner]]);
  return {
    points: hexBox.vertices,
    vertices: new Float64Array(hexBox.vertices.flat()),
    tets: corners,
  };
}

// Boundary triangles of a box side (all three corners on axis = value).
function sideFaces(mesh, axis, value) {
  const on = (vertex) => Math.abs(mesh.points[vertex][axis] - value) < 1e-9;
  const faces = [];
  for (let first = 0; first < mesh.tets.length; first += 4) {
    const tet = mesh.tets.slice(first, first + 4);
    for (let skip = 0; skip < 4; skip++) {
      const face = tet.filter((_, corner) => corner !== skip);
      if (face.every(on)) faces.push(face);
    }
  }
  return faces;
}

// Largest difference relative to the largest MFEM value.
function relativeDifference(reference, other, count) {
  let peak = 0;
  let difference = 0;
  for (let i = 0; i < count; i++) {
    peak = Math.max(peak, Math.abs(reference[i]));
    difference = Math.max(difference, Math.abs(other[i] - reference[i]));
  }
  return { peak, relative: difference / peak };
}

// Solve one order-2 case in MFEM and in Rust (AMG on the force residual);
// compare displacements and von Mises stress. `bcs` is the MFEM payload: fixed_vertices, prescribed_dofs,
// point_loads and pressure surface_loads.
function compareQuadratic(name, mesh, bcs) {
  const elementCount = mesh.tets.length / 4;
  const reference = engine.solve_linear_elastic(
    {
      vertices: mesh.vertices,
      tetrahedra: new Int32Array(mesh.tets),
      hexahedra: new Int32Array(0),
    },
    JSON.stringify({ young_modulus: YOUNG, poisson_ratio: POISSON }),
    JSON.stringify(bcs),
    2,
  );
  assert(!("error" in reference), `${name}: MFEM failed: ${reference.error}`);

  const quadratic = new ElasticModel(
    mesh.vertices,
    new Uint32Array(mesh.tets),
    new Uint32Array(elementCount),
    new Float64Array([YOUNG, POISSON]),
    2,
  );
  const vertexCount = quadratic.vertexCount;
  assert(
    vertexCount === mesh.points.length && quadratic.dofCount > 3 * vertexCount,
    `${name}: order 2 adds edge nodes after the ${mesh.points.length} vertices`,
  );
  quadratic.assemble();
  const dofs = [];
  const values = [];
  for (const vertex of bcs.fixed_vertices)
    for (let component = 0; component < 3; component++) {
      dofs.push(3 * vertex + component);
      values.push(0);
    }
  for (const { vertex, dof, value } of bcs.prescribed_dofs ?? []) {
    dofs.push(3 * vertex + dof);
    values.push(value);
  }
  const loads = new Float64Array(quadratic.dofCount);
  for (const { vertex, force } of bcs.point_loads)
    for (let component = 0; component < 3; component++)
      loads[3 * vertex + component] += force[component];
  (bcs.surface_loads ?? []).forEach((load, index) => {
    const unmatched = quadratic.addSurfaceLoad(
      loads,
      index,
      new Uint32Array(load.faces.flat()),
      load.type,
      new Float64Array([load.pressure]),
    );
    assert(unmatched === 0, `${name}: surface load ${index} fully matched`);
  });

  // MFEM stops at 1e-6 in its Gauss–Seidel-preconditioned norm, which on the
  // ill-conditioned thin wall leaves a few 1e-6 of error. The converged Rust
  // solve isolates the formulation: it must match MFEM to that error. The
  // app's setting (AMG, force residual 1e-6) must land as close.
  for (const [label, tolerance] of [
    ["converged (1e-10)", 1e-10],
    ["app setting (1e-6)", 1e-6],
  ]) {
    const solution = quadratic.solve(
      new Uint32Array(dofs),
      new Float64Array(values),
      loads,
      new SolveOptions(tolerance, 50000, "amg", "residual"),
    );
    const nodal = solution.displacements;
    const stress = quadratic.vonMises(nodal);
    const motion = relativeDifference(
      reference.displacements,
      nodal,
      3 * vertexCount,
    );
    const vonMises = relativeDifference(
      reference.von_mises,
      stress,
      elementCount,
    );
    console.log(
      `${name}, order 2, AMG ${label}: ${quadratic.dofCount} unknowns, ` +
        `${solution.iterations} iterations; max |u| ${motion.peak.toExponential(4)}, ` +
        `Rust − MFEM ${motion.relative.toExponential(2)} relative; max von Mises ` +
        `${vonMises.peak.toExponential(4)}, Rust − MFEM ${vonMises.relative.toExponential(2)} relative`,
    );
    assert(
      motion.relative < 1e-5,
      `${name} (${label}): displacements differ by ${motion.relative} relative`,
    );
    assert(
      vonMises.relative < 1e-4,
      `${name} (${label}): von Mises differs by ${vonMises.relative} relative`,
    );
  }
  quadratic.free();
  return reference;
}

const cantilever2 = kuhnBox(LENGTH, WIDTH, HEIGHT, 20, 2, 2);
const clamped2 = [];
const tip2 = [];
cantilever2.points.forEach(([x], vertex) => {
  if (Math.abs(x) < 1e-9) clamped2.push(vertex);
  if (Math.abs(x - LENGTH) < 1e-9) tip2.push(vertex);
});
const quadraticCantilever = compareQuadratic("cantilever", cantilever2, {
  fixed_vertices: clamped2,
  point_loads: tip2.map((vertex) => ({
    vertex,
    force: [0, 0, TIP_FORCE / tip2.length],
  })),
});
// Quadratic tets resolve bending: within a few percent of beam theory, where
// linear tets lock (the bound above is loose for that reason).
let tipSum = 0;
for (const vertex of tip2)
  tipSum += quadraticCantilever.displacements[3 * vertex + 2];
const tipRatio = tipSum / tip2.length / -beamTip;
console.log(
  `cantilever, order 2: tip deflection ${tipRatio.toFixed(3)} × Euler–Bernoulli`,
);
assert(
  tipRatio > 0.95 && tipRatio < 1.05,
  `order-2 tip deflection should be near beam theory, got ${tipRatio}`,
);

// Thin wall: 100 × 50 × 2 mm, one element through the thickness, clamped at
// x = 0, a pressure on the top face and the far edge pushed down 0.05 mm.
const wall = kuhnBox(100, 50, 2, 20, 10, 1);
const wallClamped = [];
const wallPushed = [];
wall.points.forEach(([x], vertex) => {
  if (Math.abs(x) < 1e-9) wallClamped.push(vertex);
  if (Math.abs(x - 100) < 1e-9) wallPushed.push(vertex);
});
compareQuadratic("thin wall", wall, {
  fixed_vertices: wallClamped,
  prescribed_dofs: wallPushed.map((vertex) => ({
    vertex,
    dof: 2,
    value: -0.05,
  })),
  point_loads: [],
  surface_loads: [
    { type: "pressure", faces: sideFaces(wall, 2, 2), pressure: 0.2 },
  ],
});

console.log("\nPASS");
