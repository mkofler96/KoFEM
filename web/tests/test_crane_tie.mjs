#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The coupled crane assembly must not leave a solid body untied (KOF-214).
//
// THE BUG THIS GUARDS: #417 replaced auto-detected solid-solid ties with ties
// declared by the caller, and examples/shell-coupling/crane-holder-shell.mjs was
// not updated — it called buildCoupledModel without `ties`, so nothing joined the
// hook to the pin.
//
// Netgen meshes the hook as its own body across the pin/eye clearance, and the
// raw mesh happens to share exactly TWO nodes between it and the rest. Two shared
// nodes is a hinge, not a joint: the hook rotates freely about the line through
// them, and the crane's load has a moment about exactly that axis. K is then
// singular with a right-hand side outside its range, so CG descends to a relative
// residual of ~9e-2, floors, and diverges until pAp goes negative through
// cancellation — reported as a "CG breakdown ... not positive definite" 2205
// iterations in, which reads like a coupling-formulation fault and is not one.
//
// Two levels of check, cheapest first:
//   1. STRUCTURAL. Without the tie the retained solid is two face-connected
//      pieces sharing a couple of nodes, and the loaded piece is one of them.
//      With the tie, couplings bridge the two. This is the invariant that broke,
//      and it is a property of the model — no solve needed.
//   2. SOLVE. The tied model converges to a plausible displacement and stress;
//      the untied one does not converge at all.
//
// Usage:  bun tests/test_crane_tie.mjs   (from the web/ directory)

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  loadEngine,
  meshStep,
  extractThinWallShells,
  shellWallTets,
  buildCoupledModel,
  dropCouplingsOnFixedNodes,
  surfaceVertices,
} from "../../examples/shell-coupling/lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const STEP = join(here, "../../test_files/full-crane-hook.step");
const STEEL = { young_modulus: 210000, poisson_ratio: 0.3 }; // MPa

// Mirrors examples/shell-coupling/crane-holder-shell.mjs. Face 7 is the holder
// mounting face; 66/67 are the loaded hook faces; face 65 is the hook eye and
// body 2 is the pin, the surfaces the tie joins.
const BC_FIXED_FACE = 7;
const LOAD_FACES = [66, 67];
const TIE_HOOK_FACE = 65;
const TIE_PIN_BODY = 2;
const TIE_CLEARANCE = 3.0; // mm

let passed = 0;
let failed = 0;
function check(label, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const Module = await loadEngine();

// ── Mesh once; both models are built from it ──────────────────────────────────
const mesh = meshStep(Module, STEP, { maxElementSize: 6 });
const shells = extractThinWallShells(mesh);
const wallTets = shellWallTets(mesh, shells);

const { byBody, byFace } = surfaceVertices(mesh);
const pinVerts = byBody.get(TIE_PIN_BODY);
const hookVerts = byFace.get(TIE_HOOK_FACE);
check(
  "the tie names real surfaces",
  pinVerts?.size > 0 && hookVerts?.size > 0,
  `pin body ${TIE_PIN_BODY}: ${pinVerts?.size ?? 0} verts, hook face ${TIE_HOOK_FACE}: ${hookVerts?.size ?? 0} verts`,
);
const ties = [
  {
    verticesA: [...pinVerts],
    verticesB: [...hookVerts],
    maxSeparation: TIE_CLEARANCE,
  },
];

const untied = buildCoupledModel(mesh, shells, wallTets);
const tied = buildCoupledModel(mesh, shells, wallTets, { ties });

// ── Face-connected pieces of a tet mesh ───────────────────────────────────────
// NODE connectivity hides this failure: two pieces meeting at a single node look
// like one component while carrying three rigid-body modes between them. Only
// shared FACES make a structural connection.
const TET_FACES = [
  [0, 1, 2],
  [0, 1, 3],
  [0, 2, 3],
  [1, 2, 3],
];
function facePieces(tets) {
  const nT = tets.length / 4;
  const byFaceKey = new Map();
  for (let e = 0; e < nT; e++)
    for (const f of TET_FACES) {
      const k = [tets[4 * e + f[0]], tets[4 * e + f[1]], tets[4 * e + f[2]]]
        .sort((a, b) => a - b)
        .join(",");
      (byFaceKey.get(k) ?? byFaceKey.set(k, []).get(k)).push(e);
    }
  const parent = [...Array(nT).keys()];
  const find = (a) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[a] = b;
  };
  for (const [, es] of byFaceKey)
    for (let i = 1; i < es.length; i++) union(es[0], es[i]);
  const pieces = new Map();
  for (let e = 0; e < nT; e++) {
    const root = find(e);
    const piece =
      pieces.get(root) ??
      pieces.set(root, { nodes: new Set(), tets: 0 }).get(root);
    piece.tets++;
    for (let k = 0; k < 4; k++) piece.nodes.add(tets[4 * e + k]);
  }
  return [...pieces.values()].sort((a, b) => b.tets - a.tets);
}

// ── 1. Structural: without a tie the hook is a hinge ──────────────────────────
console.log("\nstructure (no solve):");
const pieces = facePieces(untied.tets);
check(
  "the retained solid is more than one face-connected piece",
  pieces.length === 2,
  `${pieces.map((p) => `${p.tets} tets`).join(" + ")}`,
);
const [bigPiece, smallPiece] = pieces;
const shared = [...smallPiece.nodes].filter((n) => bigPiece.nodes.has(n));
check(
  "the pieces meet at only a couple of coincidental nodes — a hinge",
  pieces.length === 2 && shared.length > 0 && shared.length <= 4,
  `${shared.length} shared node(s)`,
);

// The small piece is the hook: it carries the load and nothing else grounds it.
const loadPool = new Set();
for (let t = 0; t < mesh.surfFace.length; t++) {
  if (!LOAD_FACES.includes(mesh.surfFace[t])) continue;
  for (const oi of [
    mesh.surfTri[3 * t],
    mesh.surfTri[3 * t + 1],
    mesh.surfTri[3 * t + 2],
  ]) {
    const pi = untied.solidPool.get(oi);
    if (pi !== undefined) loadPool.add(pi);
  }
}
check(
  "the loaded faces sit on the detached piece",
  loadPool.size > 0 && [...loadPool].every((pi) => smallPiece.nodes.has(pi)),
  `${loadPool.size} loaded nodes`,
);

// ── 2. Structural: the declared tie bridges the two pieces ────────────────────
const bridging = (() => {
  const coupling = tied.coupling;
  let count = 0;
  for (let k = 0; k < coupling.ref.length; k++) {
    const refSide = smallPiece.nodes.has(coupling.ref[k]);
    for (let i = coupling.offsets[k]; i < coupling.offsets[k + 1]; i++)
      if (smallPiece.nodes.has(coupling.solid[i]) !== refSide) {
        count++;
        break;
      }
  }
  return count;
})();
check(
  "the declared tie couples the hook to the rest",
  bridging > 0,
  `${bridging} of ${tied.coupling.ref.length} couplings bridge the clearance`,
);

// ── Solve helper ──────────────────────────────────────────────────────────────
function solve(model) {
  const fixedLocal = new Set();
  for (let t = 0; t < shells.shellTris.length / 3; t++)
    if (shells.shellTriSrc[t] === BC_FIXED_FACE)
      for (let k = 0; k < 3; k++) fixedLocal.add(shells.shellTris[3 * t + k]);
  const fixed = [];
  for (const s of fixedLocal)
    for (let c = 0; c < 6; c++) fixed.push(6 * model.shellPool[s] + c);

  const perFace = new Map(LOAD_FACES.map((f) => [f, new Set()]));
  for (let t = 0; t < mesh.surfFace.length; t++) {
    const faceId = mesh.surfFace[t];
    if (!perFace.has(faceId)) continue;
    for (const oi of [
      mesh.surfTri[3 * t],
      mesh.surfTri[3 * t + 1],
      mesh.surfTri[3 * t + 2],
    ]) {
      const pi = model.solidPool.get(oi);
      if (pi !== undefined) perFace.get(faceId).add(pi);
    }
  }
  const load_dofs = [],
    load_vals = [];
  for (const [, s] of perFace) {
    const ns = [...s];
    for (const pi of ns) {
      load_dofs.push(6 * pi + 1); // −1000 N in Y, spread over the face
      load_vals.push(-1000 / ns.length);
    }
  }

  const coupling = dropCouplingsOnFixedNodes(model.coupling, fixed);
  const result = Module.solve_coupled(
    {
      vertices: Float64Array.from(model.pool),
      tets: Int32Array.from(model.tets),
      triangles: Int32Array.from(model.triangles),
      thicknesses: Float64Array.from(model.thicknesses),
    },
    {
      ref: Int32Array.from(coupling.ref),
      offsets: Int32Array.from(coupling.offsets),
      solid: Int32Array.from(coupling.solid),
      mpc: Int32Array.from(coupling.mpc),
    },
    {
      fixed_dofs: Int32Array.from(fixed),
      load_dofs: Int32Array.from(load_dofs),
      load_vals: Float64Array.from(load_vals),
    },
    JSON.stringify({ solid: STEEL, shell: STEEL }),
  );
  if ("error" in result) return { ok: false, error: result.error };
  let maxU = 0;
  const disp = result.displacements;
  for (let i = 0; i < model.pool.length / 3; i++)
    maxU = Math.max(
      maxU,
      Math.hypot(disp[3 * i], disp[3 * i + 1], disp[3 * i + 2]),
    );
  return {
    ok: true,
    iterations: result.iterations,
    maxU,
    vmSolid: Math.max(0, ...result.von_mises_tets),
    vmShell: Math.max(0, ...result.von_mises_tris),
  };
}

// ── 3. Solve: tied converges, untied does not ─────────────────────────────────
console.log("\nsolve:");
const tiedResult = solve(tied);
check(
  "the tied assembly converges",
  tiedResult.ok,
  tiedResult.ok
    ? `${tiedResult.iterations} iterations, max |u| = ${tiedResult.maxU.toExponential(3)} mm`
    : tiedResult.error,
);
// 2 kN on a steel crane hook: sub-millimetre and well under yield. Loose bounds —
// this catches a diverged or garbage result, not a change in the formulation.
check(
  "the tied result is physically plausible",
  tiedResult.ok &&
    tiedResult.maxU > 1e-2 &&
    tiedResult.maxU < 5 &&
    tiedResult.vmSolid > 0 &&
    tiedResult.vmSolid < 500 &&
    tiedResult.vmShell < 500,
  tiedResult.ok
    ? `max |u| = ${tiedResult.maxU.toExponential(3)} mm, von Mises ${tiedResult.vmSolid.toFixed(1)} MPa solid / ${tiedResult.vmShell.toFixed(1)} MPa shell`
    : "no result",
);

const untiedResult = solve(untied);
check(
  "the untied assembly does NOT converge",
  !untiedResult.ok,
  untiedResult.ok
    ? `converged in ${untiedResult.iterations} iterations — a mechanism must not solve`
    : untiedResult.error.slice(0, 100),
);

console.log(
  `\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`,
);
if (failed > 0) process.exit(1);
