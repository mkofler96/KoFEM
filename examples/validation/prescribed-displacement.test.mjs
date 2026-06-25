// Idiot-proof regression test for non-zero prescribed displacements (issue #216).
//
// THE BUG THIS GUARDS: the UI lets you prescribe a non-zero displacement on a
// face (e.g. Ux = δ), but the solver used to fold every translational Dirichlet
// condition into fixed_vertices/fixed_dofs — which always pin to ZERO. The
// requested value was silently discarded, so a model driven purely by a
// prescribed displacement either did nothing or refused to run.
//
// Setup: uniaxial extension of a box [0,L]×[0,W]×[0,H] driven by displacement
// only, no applied load. Symmetry-plane rollers Ux=0 on x=0, Uy=0 on y=0,
// Uz=0 on z=0, and a NON-ZERO prescribed Ux=δ on the x=L face. The exact
// solution is the linear field
//   ux = εx·x,  uy = −ν·εx·y,  uz = −ν·εx·z,   εx = δ/L,
// independent of E (a pure-displacement boundary-value problem). Trilinear hexes
// reproduce it exactly. The x=L face must reach ux ≈ δ; the buggy binary pins it
// to zero.
//
// Runs against the freshly built WASM in CI. On the committed binary (before a
// rebuild with the engine.cpp `prescribed_dofs` support) it is EXPECTED to fail
// — prescribed_dofs is ignored, the loaded face is pinned to zero, and the field
// collapses. That failure is the signal to run scripts/build-wasm.sh.

import { loadSolver } from "./lib/solver.mjs";
import { boxHexMesh, nodesWhere } from "./lib/mesh.mjs";

const nu = 0.3;
const E = 200e9; // result is E-independent; any positive value works
const L = 4,
  W = 1,
  H = 1;
const delta = 0.01; // prescribed Ux on the x=L face
const epsX = delta / L;
const expUy = -nu * epsX * W; // Poisson contraction at y = W
const expUz = -nu * epsX * H; // Poisson contraction at z = H

const m = boxHexMesh(L, W, H, 4, 2, 2);

// Symmetry-plane rollers (zero Dirichlet), unioned per node so shared edges
// carry several components (the origin gets Ux+Uy+Uz).
const zeroByNode = new Map();
const addZero = (ids, dof) =>
  ids.forEach((i) => {
    if (!zeroByNode.has(i)) zeroByNode.set(i, new Set());
    zeroByNode.get(i).add(dof);
  });
addZero(
  nodesWhere(m.vertices, (x) => x <= 1e-9),
  0,
); // x=0 → Ux=0
addZero(
  nodesWhere(m.vertices, (x, y) => y <= 1e-9),
  1,
); // y=0 → Uy=0
addZero(
  nodesWhere(m.vertices, (x, y, z) => z <= 1e-9),
  2,
); // z=0 → Uz=0
const fixed_dofs = [...zeroByNode].map(([vertex, s]) => ({
  vertex,
  dofs: [...s].sort(),
}));

// The driving condition: NON-ZERO prescribed Ux on the x=L face, no load.
const loaded = nodesWhere(m.vertices, (x) => x >= L - 1e-9);
const prescribed_dofs = loaded.map((vertex) => ({
  vertex,
  dof: 0,
  value: delta,
}));

const solve = await loadSolver();
const r = solve(
  { vertices: m.vertices, hexahedra: m.hexahedra },
  { young_modulus: E, poisson_ratio: nu, density: 7850 },
  { fixed_vertices: [], fixed_dofs, prescribed_dofs, point_loads: [] },
  1,
);

const d = (v, c) => r.displacements[v * 3 + c];
const uxFace = loaded.reduce((s, v) => s + d(v, 0), 0) / loaded.length; // ≈ δ
// Discriminator node: free in y/z to show Poisson contraction — pick the
// (L, W, H) corner, which sits on the x=L face only among the loaded set.
const disc = nodesWhere(
  m.vertices,
  (x, y, z) => x >= L - 1e-9 && y >= W - 1e-9 && z >= H - 1e-9,
)[0];

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

const finite = r.displacements.every(Number.isFinite);
check("solve produced finite displacements", finite, "");

if (finite) {
  // THE DISCRIMINATOR: the prescribed value actually reaches the loaded face.
  // The buggy binary pins it to zero, so "within 5% of δ" cleanly separates
  // applied from discarded.
  check(
    "prescribed Ux is applied on the loaded face (ux ≈ δ, NOT zero)",
    Math.abs((uxFace - delta) / delta) < 0.05,
    `ux=${uxFace.toExponential(3)} vs δ=${delta.toExponential(3)}`,
  );

  // Physics sanity: the linear extension field matches theory. ux is fixed by
  // the prescribed BC, so it converges tightly regardless of solver tolerance.
  check(
    "uniaxial extension ux ≈ εx·L (±5%)",
    Math.abs((uxFace - epsX * L) / (epsX * L)) < 0.05,
    `ux=${uxFace.toExponential(3)} vs ${(epsX * L).toExponential(3)}`,
  );

  // The transverse contraction is a SOLVED unknown (unlike ux, which the BC
  // pins), so the engine's loose showcase CG tolerance (SetRelTol 1e-1) leaves
  // it under-converged and noisy — the magnitude overshoots and uy ≠ uz despite
  // W = H. We therefore assert direction, not tight magnitude: the prescribed
  // face must be FREE in y/z and contract under Poisson (more than half the
  // theoretical amount, correct sign), proving it is not over-pinned. This is
  // the same robust discriminator dof-constraint.test.mjs uses. Tight Poisson
  // accuracy under load is already covered by the main validation suite.
  check(
    "loaded face is FREE in Uy and contracts under Poisson (not over-pinned)",
    d(disc, 1) < 0.5 * expUy,
    `uy=${d(disc, 1).toExponential(3)} (expected ≈ ${expUy.toExponential(3)})`,
  );
  check(
    "loaded face is FREE in Uz and contracts under Poisson (not over-pinned)",
    d(disc, 2) < 0.5 * expUz,
    `uz=${d(disc, 2).toExponential(3)} (expected ≈ ${expUz.toExponential(3)})`,
  );
}

console.log("\nPrescribed-displacement test (engine.cpp prescribed_dofs)\n");
let failed = 0;
for (const c of checks) {
  console.log(
    `  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? "  — " + c.detail : ""}`,
  );
  if (!c.ok) failed++;
}

if (failed) {
  console.error(
    `\n${failed} check(s) FAILED. If this is the committed WASM, rebuild it with` +
      `\n  scripts/build-wasm.sh` +
      `\nso engine.cpp's prescribed_dofs (non-zero Dirichlet) support is compiled in.\n`,
  );
  process.exit(1);
}
console.log("\nPASS — non-zero prescribed displacements are honored.\n");
