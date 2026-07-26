// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for the coupling plumbing in src/lib/shellize.ts — the parts the
// end-to-end specs cannot pin down precisely:
//
//   1. Which coupling KIND each reference gets. The shell<->solid seam is
//      continuous material and must be tied with the relaxed MPC (mpc = 1); the
//      gapped pin<->hole interface must stay distributing (mpc = 0). Getting
//      this backwards is invisible in a converged solve but reintroduces the
//      seam separation of issue #398.
//   2. That the flags survive concatCouplings / dropCouplingsOnFixedNodes —
//      a set whose mpc array drifts out of step with ref[] silently retags
//      couplings.
//   3. Per-SECTION thickness: a body with two different wall thicknesses must
//      produce a per-facet thickness field carrying both, which is what lets the
//      mesh emit one PSHELL per section. The fin fixture has a single 2 mm wall,
//      so no e2e test exercises the multi-section case.
//
// Run:  bun tests/test_shellize_mpc.mjs

import {
  buildCoupledModel,
  buildExplicitCoupledModel,
  dropCouplingsOnFixedNodes,
  extractThinWallShells,
  shellWallTets,
} from "../src/lib/shellize.ts";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  [PASS] ${name}`);
  } else {
    failures++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── Fixture: a solid base block with a shell panel floating above it ──────────
// The shell nodes are a separate node set (as the wall collapse produces), so
// buildCoupledModel must tie them to the solid with a shell<->solid coupling.
function baseAndPanel() {
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
  const body = [];
  const nx = 6,
    ny = 3,
    nz = 1,
    dx = 5,
    dy = 5,
    dz = 5;
  const gid = (i, j, k) => addV(i * dx, j * dy, -5 + k * dz);
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      for (let k = 0; k < nz; k++) {
        const cell = [
          gid(i, j, k),
          gid(i + 1, j, k),
          gid(i, j + 1, k),
          gid(i + 1, j + 1, k),
          gid(i, j, k + 1),
          gid(i + 1, j, k + 1),
          gid(i, j + 1, k + 1),
          gid(i + 1, j + 1, k + 1),
        ];
        for (const t of KUHN) {
          tet.push(cell[t[0]], cell[t[1]], cell[t[2]], cell[t[3]]);
          body.push(0);
        }
      }
  const mesh = { V: verts, tet, body, surfTri: [], surfFace: [] };

  // Shell panel just above the block (its own nodes).
  const shellVerts = [];
  const sIndex = new Map();
  const addS = (x, y, z) => {
    const key = `${x},${y},${z}`;
    let i = sIndex.get(key);
    if (i === undefined) {
      i = shellVerts.length / 3;
      sIndex.set(key, i);
      shellVerts.push(x, y, z);
    }
    return i;
  };
  const shellTris = [],
    shellThk = [],
    shellTriSrc = [];
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++) {
      const qa = addS(i * dx, j * dy, 1),
        qb = addS((i + 1) * dx, j * dy, 1),
        qc = addS((i + 1) * dx, (j + 1) * dy, 1),
        qd = addS(i * dx, (j + 1) * dy, 1);
      shellTris.push(qa, qb, qc, qa, qc, qd);
      // Two SECTIONS: the first half of the panel is 2 mm, the rest 4 mm.
      const thk = i < nx / 2 ? 2 : 4;
      shellThk.push(thk, thk);
      shellTriSrc.push(1, 1);
    }
  const shellSrc = new Array(shellVerts.length / 3).fill(1);
  const shells = {
    walls: [],
    shellBody: 99,
    shellVerts,
    shellTris,
    shellThk,
    shellSrc,
    shellTriSrc,
  };
  return { mesh, shells };
}

console.log("shellize coupling plumbing:");

const { mesh, shells } = baseAndPanel();
const model = buildCoupledModel(mesh, shells, new Set());
const nSolidPool = model.solidPool.size;

check(
  "buildCoupledModel emits an mpc flag per coupling reference",
  Array.isArray(model.coupling.mpc) &&
    model.coupling.mpc.length === model.coupling.ref.length,
  `mpc=${model.coupling.mpc?.length} ref=${model.coupling.ref.length}`,
);

// Every reference here is a SHELL node (pool index >= number of solid nodes),
// so every coupling must be tagged MPC.
const shellRefsTagged = model.coupling.ref.every(
  (pi, k) => pi < nSolidPool || model.coupling.mpc[k] === 1,
);
check(
  "shell<->solid references are tagged MPC (mpc = 1)",
  model.coupling.ref.length > 0 && shellRefsTagged,
);

// ── dropCouplingsOnFixedNodes keeps ref[] and mpc[] in step ───────────────────
const dropped = dropCouplingsOnFixedNodes(model.coupling, [
  6 * model.coupling.ref[0],
]);
check(
  "dropCouplingsOnFixedNodes drops exactly the fixed reference",
  dropped.ref.length === model.coupling.ref.length - 1 &&
    !dropped.ref.includes(model.coupling.ref[0]),
);
check(
  "dropCouplingsOnFixedNodes keeps mpc[] aligned with ref[]",
  dropped.mpc.length === dropped.ref.length,
  `mpc=${dropped.mpc.length} ref=${dropped.ref.length}`,
);
check(
  "surviving references keep their MPC tag",
  dropped.mpc.every((flag) => flag === 1),
);

// ── Per-SECTION thickness survives into the coupled model ─────────────────────
const distinct = [...new Set(model.thicknesses)].sort((a, b) => a - b);
check(
  "a two-section panel carries both wall thicknesses per facet",
  distinct.length === 2 && distinct[0] === 2 && distinct[1] === 4,
  `distinct thicknesses: ${JSON.stringify(distinct)}`,
);
check(
  "the per-facet thickness field has one entry per shell facet",
  model.thicknesses.length === model.triangles.length / 3,
  `thk=${model.thicknesses.length} tris=${model.triangles.length / 3}`,
);

// ── Explicit (loaded mixed model) path tags the seam the same way ─────────────
{
  const verts = [];
  const idx = new Map();
  const addV = (x, y, z) => {
    const key = `${x},${y},${z}`;
    let i = idx.get(key);
    if (i === undefined) {
      i = verts.length / 3;
      idx.set(key, i);
      verts.push(x, y, z);
    }
    return i;
  };
  // one solid tet cluster + a detached shell triangle set nearby
  const solidTets = [];
  const solidBody = [];
  const corner = [
    addV(0, 0, 0),
    addV(10, 0, 0),
    addV(0, 10, 0),
    addV(10, 10, 0),
    addV(0, 0, 10),
    addV(10, 0, 10),
    addV(0, 10, 10),
    addV(10, 10, 10),
  ];
  const KUHN = [
    [0, 1, 3, 7],
    [0, 3, 2, 7],
    [0, 2, 6, 7],
    [0, 6, 4, 7],
    [0, 4, 5, 7],
    [0, 5, 1, 7],
  ];
  for (const t of KUHN) {
    solidTets.push(corner[t[0]], corner[t[1]], corner[t[2]], corner[t[3]]);
    solidBody.push(1);
  }
  const s0 = addV(2, 2, 14),
    s1 = addV(8, 2, 14),
    s2 = addV(8, 8, 14),
    s3 = addV(2, 8, 14);
  const shellTris = [s0, s1, s2, s0, s2, s3];
  const explicitModel = buildExplicitCoupledModel(
    verts,
    solidTets,
    solidBody,
    shellTris,
    [3, 3],
  );
  check(
    "explicit mixed path also emits aligned mpc flags",
    Array.isArray(explicitModel.coupling.mpc) &&
      explicitModel.coupling.mpc.length === explicitModel.coupling.ref.length,
  );
  const solidCount = explicitModel.coupling.ref.filter(
    (_pi, k) => explicitModel.coupling.mpc[k] === 0,
  ).length;
  check(
    "explicit mixed path tags its shell references MPC",
    explicitModel.coupling.ref.length === 0 ||
      solidCount < explicitModel.coupling.ref.length,
    `all ${explicitModel.coupling.ref.length} references were tagged distributing`,
  );
}

// ── extractThinWallShells / wall split is thickness-driven, not body-driven ───
{
  const verts = [];
  const idx = new Map();
  const addV = (x, y, z) => {
    const key = `${x},${y},${z}`;
    let i = idx.get(key);
    if (i === undefined) {
      i = verts.length / 3;
      idx.set(key, i);
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
  const tet = [],
    body = [];
  const addGrid = (z0, nz, dz) => {
    const gid = (i, j, k) => addV(i * 5, j * 5, z0 + k * dz);
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < 3; j++)
        for (let k = 0; k < nz; k++) {
          const cell = [
            gid(i, j, k),
            gid(i + 1, j, k),
            gid(i, j + 1, k),
            gid(i + 1, j + 1, k),
            gid(i, j, k + 1),
            gid(i + 1, j, k + 1),
            gid(i, j + 1, k + 1),
            gid(i + 1, j + 1, k + 1),
          ];
          for (const t of KUHN) {
            tet.push(cell[t[0]], cell[t[1]], cell[t[2]], cell[t[3]]);
            body.push(1); // ONE body
          }
        }
  };
  addGrid(-12, 3, 4); // thick base
  addGrid(10, 1, 0.5); // 0.5 mm wall — sliver
  const oneBody = { V: verts, tet, body, surfTri: [], surfFace: [] };
  // Mid-surface of the 0.5 mm wall (z = 10 .. 10.5), one facet pair per grid
  // cell, standing in for what collapseWallsToMidSurface produces.
  const shellVerts = [],
    shellTris = [],
    shellThk = [];
  const sidx = new Map();
  const addS = (x, y) => {
    const key = `${x},${y}`;
    let i = sidx.get(key);
    if (i === undefined) {
      i = shellVerts.length / 3;
      sidx.set(key, i);
      shellVerts.push(x, y, 10.25);
    }
    return i;
  };
  for (let i = 0; i < 6; i++)
    for (let j = 0; j < 3; j++) {
      const c00 = addS(i * 5, j * 5),
        c10 = addS((i + 1) * 5, j * 5),
        c01 = addS(i * 5, (j + 1) * 5),
        c11 = addS((i + 1) * 5, (j + 1) * 5);
      shellTris.push(c00, c10, c11, c00, c11, c01);
      shellThk.push(0.5, 0.5);
    }
  const wallTets = shellWallTets(oneBody, {
    walls: [],
    shellBody: 1,
    shellVerts,
    shellTris,
    shellThk,
    shellSrc: [],
    shellTriSrc: [],
  });
  let wallHigh = 0,
    wallLow = 0;
  for (const e of wallTets) {
    let mz = 0;
    for (let k = 0; k < 4; k++) mz += verts[3 * tet[4 * e + k] + 2];
    mz /= 4;
    if (mz > 9) wallHigh++;
    else wallLow++;
  }
  // Every tet of the thin layer must be claimed — a wall represented by shells
  // AND by leftover solid tets is counted twice.
  let thinTets = 0;
  for (let e = 0; e < tet.length / 4; e++) {
    let mz = 0;
    for (let k = 0; k < 4; k++) mz += verts[3 * tet[4 * e + k] + 2];
    if (mz / 4 > 9) thinTets++;
  }
  check(
    "wall-tet detection separates thin from thick WITHIN one body",
    wallHigh === thinTets && wallLow === 0,
    `thin=${wallHigh}/${thinTets} thick=${wallLow}`,
  );
  // No surface mesh here, so wall-pair detection has nothing to work with and
  // must report "no shell body" rather than inventing one.
  const noWalls = extractThinWallShells(oneBody, {
    shellBodyIds: new Set([1]),
  });
  check(
    "extractThinWallShells reports no shell body when no wall pair is found",
    noWalls.shellBody === -1 && noWalls.shellTris.length === 0,
  );
}

console.log(
  failures === 0
    ? "\nall shellize coupling checks passed"
    : `\n${failures} check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
