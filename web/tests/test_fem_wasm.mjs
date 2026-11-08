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

console.log("\nPASS");
