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

import { beforeAll, describe, expect, test } from "bun:test";
import {
  buildCoupledModel,
  buildExplicitCoupledModel,
  dropCouplingsOnFixedNodes,
  extractThinWallShells,
  shellWallTets,
  tieCouplingProblem,
} from "../../src/lib/shellize.ts";
import { loadFem } from "../support/wasm.mjs";

const KUHN = [
  [0, 1, 3, 7],
  [0, 3, 2, 7],
  [0, 2, 6, 7],
  [0, 6, 4, 7],
  [0, 4, 5, 7],
  [0, 5, 1, 7],
];

// A vertex array that hands out one index per distinct point.
function vertexPool() {
  const verts = [];
  const index = new Map();
  const add = (px, py, pz) => {
    const key = `${px},${py},${pz}`;
    let found = index.get(key);
    if (found === undefined) {
      found = verts.length / 3;
      index.set(key, found);
      verts.push(px, py, pz);
    }
    return found;
  };
  return { verts, add };
}

// ── Fixture: a solid base block with a shell panel floating above it ──────────
// The shell nodes are a separate node set (as the wall collapse produces), so
// buildCoupledModel must tie them to the solid with a shell<->solid coupling.
function baseAndPanel() {
  const { verts, add: addV } = vertexPool();
  const tet = [];
  const body = [];
  const nx = 6,
    ny = 3,
    nz = 1,
    dx = 5,
    dy = 5,
    dz = 5;
  const gid = (ix, iy, iz) => addV(ix * dx, iy * dy, -5 + iz * dz);
  for (let ix = 0; ix < nx; ix++)
    for (let iy = 0; iy < ny; iy++)
      for (let iz = 0; iz < nz; iz++) {
        const cell = [
          gid(ix, iy, iz),
          gid(ix + 1, iy, iz),
          gid(ix, iy + 1, iz),
          gid(ix + 1, iy + 1, iz),
          gid(ix, iy, iz + 1),
          gid(ix + 1, iy, iz + 1),
          gid(ix, iy + 1, iz + 1),
          gid(ix + 1, iy + 1, iz + 1),
        ];
        for (const corners of KUHN) {
          tet.push(
            cell[corners[0]],
            cell[corners[1]],
            cell[corners[2]],
            cell[corners[3]],
          );
          body.push(0);
        }
      }
  const mesh = { V: verts, tet, body, surfTri: [], surfFace: [] };

  // Shell panel just above the block (its own nodes).
  const { verts: shellVerts, add: addS } = vertexPool();
  const shellTris = [],
    shellThk = [],
    shellTriSrc = [];
  for (let ix = 0; ix < nx; ix++)
    for (let iy = 0; iy < ny; iy++) {
      const qa = addS(ix * dx, iy * dy, 1),
        qb = addS((ix + 1) * dx, iy * dy, 1),
        qc = addS((ix + 1) * dx, (iy + 1) * dy, 1),
        qd = addS(ix * dx, (iy + 1) * dy, 1);
      shellTris.push(qa, qb, qc, qa, qc, qd);
      // Two SECTIONS: the first half of the panel is 2 mm, the rest 4 mm.
      const thk = ix < nx / 2 ? 2 : 4;
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

// The shell idealisation runs in the Rust module (crates/kofem-shellize).
beforeAll(async () => {
  await loadFem();
});

describe("shellize coupling plumbing", () => {
  let model = null;
  let nSolidPool = null;
  beforeAll(() => {
    const { mesh, shells } = baseAndPanel();
    model = buildCoupledModel(mesh, shells, new Set());
    nSolidPool = model.solidPool.size;
  });

  test("buildCoupledModel emits an mpc flag per coupling reference", () => {
    expect(Array.isArray(model.coupling.mpc)).toBe(true);
    expect(model.coupling.mpc).toHaveLength(model.coupling.ref.length);
  });

  // Every reference here is a SHELL node (pool index >= number of solid nodes),
  // so every coupling must be tagged MPC.
  test("shell<->solid references are tagged MPC (mpc = 1)", () => {
    expect(model.coupling.ref.length).toBeGreaterThan(0);
    model.coupling.ref.forEach((poolIndex, slot) => {
      if (poolIndex >= nSolidPool)
        expect(model.coupling.mpc[slot], `reference ${slot}`).toBe(1);
    });
  });

  // ── dropCouplingsOnFixedNodes keeps ref[] and mpc[] in step ─────────────────
  describe("dropCouplingsOnFixedNodes", () => {
    let dropped = null;
    beforeAll(() => {
      dropped = dropCouplingsOnFixedNodes(model.coupling, [
        6 * model.coupling.ref[0],
      ]);
    });

    test("drops exactly the fixed reference", () => {
      expect(dropped.ref).toHaveLength(model.coupling.ref.length - 1);
      expect(dropped.ref).not.toContain(model.coupling.ref[0]);
    });

    test("keeps mpc[] aligned with ref[]", () => {
      expect(dropped.mpc).toHaveLength(dropped.ref.length);
    });

    test("surviving references keep their MPC tag", () => {
      for (const flag of dropped.mpc) expect(flag).toBe(1);
    });
  });

  // ── Per-SECTION thickness survives into the coupled model ───────────────────
  test("a two-section panel carries both wall thicknesses per facet", () => {
    const distinct = [...new Set(model.thicknesses)].sort(
      (first, second) => first - second,
    );
    expect(distinct).toHaveLength(2);
    expect(distinct[0]).toBe(2);
    expect(distinct[1]).toBe(4);
  });

  test("the per-facet thickness field has one entry per shell facet", () => {
    expect(model.thicknesses).toHaveLength(model.triangles.length / 3);
  });
});

// ── Explicit (loaded mixed model) path tags the seam the same way ─────────────
describe("explicit mixed model", () => {
  let explicitModel = null;
  beforeAll(() => {
    const { verts, add: addV } = vertexPool();
    // one solid tet cluster + a detached shell triangle set nearby
    const solidTets = [];
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
    for (const corners of KUHN)
      solidTets.push(
        corner[corners[0]],
        corner[corners[1]],
        corner[corners[2]],
        corner[corners[3]],
      );
    const s0 = addV(2, 2, 14),
      s1 = addV(8, 2, 14),
      s2 = addV(8, 8, 14),
      s3 = addV(2, 8, 14);
    const shellTris = [s0, s1, s2, s0, s2, s3];
    explicitModel = buildExplicitCoupledModel(
      verts,
      solidTets,
      shellTris,
      [3, 3],
    );
  });

  test("the explicit mixed path also emits aligned mpc flags", () => {
    expect(Array.isArray(explicitModel.coupling.mpc)).toBe(true);
    expect(explicitModel.coupling.mpc).toHaveLength(
      explicitModel.coupling.ref.length,
    );
  });

  test("the explicit mixed path tags its shell references MPC", () => {
    const distributing = explicitModel.coupling.ref.filter(
      (_poolIndex, slot) => explicitModel.coupling.mpc[slot] === 0,
    ).length;
    if (explicitModel.coupling.ref.length > 0)
      expect(
        distributing,
        `all ${explicitModel.coupling.ref.length} references were tagged distributing`,
      ).toBeLessThan(explicitModel.coupling.ref.length);
  });
});

// ── A tie connection, and only a tie connection, joins two solid bodies ───────
//
// Two detached solid cubes 1 mm apart. Nothing about the geometry says whether
// they are connected — that used to be guessed (the bigger body was declared
// "master" and the other's interface band slaved to it, autoDetectSolidCouplings).
// Now it is stated: no connection, no coupling; a connection between the two
// facing faces produces the distributing tie across the clearance.
describe("tie connections between solid bodies", () => {
  const GAP = 1;
  let verts = null;
  let solidTets = null;
  let faceAt = null;
  let surfaceA = null;
  let surfaceB = null;
  let cube = null;

  // A named tie between two vertex lists.
  const tieOf = (name, verticesA, verticesB, maxSeparation) => ({
    ties: [{ name, verticesA, verticesB, maxSeparation }],
  });

  beforeAll(() => {
    const pool = vertexPool();
    verts = pool.verts;
    // A unit-grid cube of Kuhn tets at (x0, 0, 0), 10 mm on a side, 2 cells wide
    // so the facing surface has a 3x3 node grid to distribute onto.
    cube = (x0) => {
      const tets = [];
      const step = 5;
      const at = (ix, iy, iz) => pool.add(x0 + ix * step, iy * step, iz * step);
      for (let ix = 0; ix < 2; ix++)
        for (let iy = 0; iy < 2; iy++)
          for (let iz = 0; iz < 2; iz++) {
            const corner = [
              at(ix, iy, iz),
              at(ix + 1, iy, iz),
              at(ix, iy + 1, iz),
              at(ix + 1, iy + 1, iz),
              at(ix, iy, iz + 1),
              at(ix + 1, iy, iz + 1),
              at(ix, iy + 1, iz + 1),
              at(ix + 1, iy + 1, iz + 1),
            ];
            for (const corners of KUHN)
              tets.push(
                corner[corners[0]],
                corner[corners[1]],
                corner[corners[2]],
                corner[corners[3]],
              );
          }
      return tets;
    };
    solidTets = [...cube(0), ...cube(10 + GAP)];
    faceAt = (planeX) => {
      const out = [];
      for (let vertex = 0; vertex < verts.length / 3; vertex++)
        if (Math.abs(verts[3 * vertex] - planeX) < 1e-9) out.push(vertex);
      return out;
    };
    surfaceA = faceAt(10);
    surfaceB = faceAt(10 + GAP);
  });

  test("the two facing faces each have a 3x3 node grid", () => {
    expect(surfaceA).toHaveLength(9);
    expect(surfaceB).toHaveLength(9);
  });

  test("with no tie connection the two bodies get no coupling at all", () => {
    const untied = buildExplicitCoupledModel(verts, solidTets, [], []);
    expect(untied.coupling.ref).toHaveLength(0);
  });

  describe("a tie across the clearance", () => {
    let tied = null;
    beforeAll(() => {
      tied = buildExplicitCoupledModel(
        verts,
        solidTets,
        [],
        [],
        tieOf("Tie1", surfaceA, surfaceB, Infinity),
      );
    });

    // Whether a node of the coupled model's pool is a vertex of `surface`.
    const onSurface = (surface, poolIndex) =>
      surface.some((vertex) => tied.poolOfVertex.get(vertex) === poolIndex);

    test("couples the picked surface across the clearance", () => {
      expect(tied.coupling.ref).toHaveLength(surfaceB.length);
    });

    test("every reference is a node of the picked surface B", () => {
      for (const poolIndex of tied.coupling.ref)
        expect(onSurface(surfaceB, poolIndex), `reference ${poolIndex}`).toBe(
          true,
        );
    });

    test("every partner is a node of the picked surface A", () => {
      for (const poolIndex of tied.coupling.solid)
        expect(onSurface(surfaceA, poolIndex), `partner ${poolIndex}`).toBe(
          true,
        );
    });

    test("a solid tie is distributing, not the relaxed shell MPC", () => {
      for (const flag of tied.coupling.mpc) expect(flag).toBe(0);
    });

    test("a tie that coupled reports what it contributed", () => {
      expect(tied.tieReports).toHaveLength(1);
      const report = tied.tieReports[0];
      expect(report.name).toBe("Tie1");
      expect(report.nCoupled).toBe(surfaceB.length);
      expect(report.nPartners).toBeGreaterThan(0);
      expect(Math.abs(report.gap - GAP)).toBeLessThan(1e-9);
      expect(report.drop).toBeUndefined();
    });

    test("a tie that coupled is not a problem", () => {
      expect(tieCouplingProblem(tied.tieReports[0])).toBeUndefined();
    });
  });

  // ── A declared tie that couples nothing is reported, never dropped silently ──
  //
  // Every way tieCouplings can fail to produce a coupling must name the tie and
  // say which way it failed (KOF-203). The builders stay pure — they report; the
  // worker turns a report into the refusal, exactly as the all-solid weld path
  // does. Solving on regardless leaves the assembly split and returns a
  // plausible-looking but structurally wrong shape.
  describe("a declared tie that couples nothing is reported", () => {
    // A "within distance" connection shorter than the clearance reaches nothing.
    describe("search distance below the clearance", () => {
      let tooShort = null;
      beforeAll(() => {
        tooShort = buildExplicitCoupledModel(
          verts,
          solidTets,
          [],
          [],
          tieOf("Tie1", surfaceA, surfaceB, 0.5 * GAP),
        );
      });

      test("couples nothing", () => {
        expect(tooShort.coupling.ref).toHaveLength(0);
      });

      test("says the surfaces are beyond the search distance", () => {
        expect(tooShort.tieReports).toHaveLength(1);
        const { drop } = tooShort.tieReports[0];
        expect(drop?.kind).toBe("beyond-search-distance");
        expect(Math.abs(drop.gap - GAP)).toBeLessThan(1e-9);
        expect(drop.reach).toBe(0.5 * GAP);
      });

      test("is a problem naming the tie and both distances", () => {
        const problem = tieCouplingProblem(tooShort.tieReports[0]);
        expect(problem).toContain('Tie "Tie1"');
        expect(problem).toContain("search distance");
      });
    });

    // The outward-facing faces of the two bodies: a whole body apart, so they come
    // into nominal range but no reference finds the three partners an RBE3 needs
    // (only the one node directly opposite is within the radius).
    test("surfaces too sparse to distribute onto are reported, not dropped", () => {
      const backToBack = buildExplicitCoupledModel(
        verts,
        solidTets,
        [],
        [],
        tieOf("Wrong faces", faceAt(0), faceAt(10 + GAP + 10), Infinity),
      );
      expect(backToBack.coupling.ref).toHaveLength(0);
      expect(backToBack.tieReports).toHaveLength(1);
      expect(backToBack.tieReports[0].drop?.kind).toBe("too-few-partners");
      expect(tieCouplingProblem(backToBack.tieReports[0])).toContain(
        'Tie "Wrong faces"',
      );
    });

    // A surface whose nodes are in no element of the solved model — the auto-shell
    // case where the picked wall was idealised away, and the re-pick-after-remesh
    // case — leaves that side with no pool node at all.
    test("a surface with no node in the solved model is reported, not skipped", () => {
      const orphan = buildExplicitCoupledModel(
        verts,
        solidTets,
        [],
        [],
        tieOf("Stale pick", surfaceA, [verts.length / 3 + 5], Infinity),
      );
      expect(orphan.coupling.ref).toHaveLength(0);
      expect(orphan.tieReports).toHaveLength(1);
      const report = orphan.tieReports[0];
      expect(report.drop?.kind).toBe("no-pool-nodes");
      expect(report.drop.side).toBe("B");
      const problem = tieCouplingProblem(report);
      expect(problem).toContain('Tie "Stale pick"');
      // The side that has nothing is the side the sentence must say is empty —
      // "surface B has a node in the solved model" would send the user to the
      // one surface that is fine.
      expect(problem).toContain(
        "picked surface B has no node in the solved model",
      );
    });

    // Two surfaces that are the SAME nodes are already rigidly joined through the
    // shared pool DOFs. That is a connected tie, so it must NOT be reported as a
    // problem even though it produces no coupling.
    test("a tie whose surfaces share their nodes is joined, not a problem", () => {
      const shared = buildExplicitCoupledModel(
        verts,
        solidTets,
        [],
        [],
        tieOf("Coincident", surfaceA, surfaceA, Infinity),
      );
      expect(shared.tieReports).toHaveLength(1);
      expect(shared.tieReports[0].nShared).toBe(surfaceA.length);
      expect(shared.tieReports[0].nCoupled).toBe(0);
      expect(tieCouplingProblem(shared.tieReports[0])).toBeUndefined();
    });

    // Surfaces that never see each other at all: a third body far enough away that
    // the search gives up before reaching it. `cube` appends to the shared vertex
    // array, so this test builds its own tets from the models' vertices.
    test("surfaces the search never reaches are reported out of reach", () => {
      const farTets = [...solidTets, ...cube(2000)];
      const farApart = buildExplicitCoupledModel(
        verts,
        farTets,
        [],
        [],
        tieOf("Distant body", faceAt(0), faceAt(2010), Infinity),
      );
      expect(farApart.coupling.ref).toHaveLength(0);
      expect(farApart.tieReports).toHaveLength(1);
      expect(farApart.tieReports[0].drop?.kind).toBe("out-of-reach");
      expect(farApart.tieReports[0].drop.searched).toBeGreaterThan(0);
      expect(tieCouplingProblem(farApart.tieReports[0])).toContain(
        'Tie "Distant body"',
      );
    });
  });
});

// ── extractThinWallShells / wall split is thickness-driven, not body-driven ───
describe("thin walls within one body", () => {
  let verts = null;
  let tet = null;
  let oneBody = null;
  let wallTets = null;
  beforeAll(() => {
    const pool = vertexPool();
    verts = pool.verts;
    tet = [];
    const body = [];
    const addGrid = (z0, nz, dz) => {
      const gid = (ix, iy, iz) => pool.add(ix * 5, iy * 5, z0 + iz * dz);
      for (let ix = 0; ix < 6; ix++)
        for (let iy = 0; iy < 3; iy++)
          for (let iz = 0; iz < nz; iz++) {
            const cell = [
              gid(ix, iy, iz),
              gid(ix + 1, iy, iz),
              gid(ix, iy + 1, iz),
              gid(ix + 1, iy + 1, iz),
              gid(ix, iy, iz + 1),
              gid(ix + 1, iy, iz + 1),
              gid(ix, iy + 1, iz + 1),
              gid(ix + 1, iy + 1, iz + 1),
            ];
            for (const corners of KUHN) {
              tet.push(
                cell[corners[0]],
                cell[corners[1]],
                cell[corners[2]],
                cell[corners[3]],
              );
              body.push(1); // ONE body
            }
          }
    };
    addGrid(-12, 3, 4); // thick base
    addGrid(10, 1, 0.5); // 0.5 mm wall — sliver
    oneBody = { V: verts, tet, body, surfTri: [], surfFace: [] };
    // Mid-surface of the 0.5 mm wall (z = 10 .. 10.5), one facet pair per grid
    // cell, standing in for what collapseWallsToMidSurface produces.
    const shellVerts = [],
      shellTris = [],
      shellThk = [];
    const sidx = new Map();
    const addS = (px, py) => {
      const key = `${px},${py}`;
      let found = sidx.get(key);
      if (found === undefined) {
        found = shellVerts.length / 3;
        sidx.set(key, found);
        shellVerts.push(px, py, 10.25);
      }
      return found;
    };
    for (let ix = 0; ix < 6; ix++)
      for (let iy = 0; iy < 3; iy++) {
        const c00 = addS(ix * 5, iy * 5),
          c10 = addS((ix + 1) * 5, iy * 5),
          c01 = addS(ix * 5, (iy + 1) * 5),
          c11 = addS((ix + 1) * 5, (iy + 1) * 5);
        shellTris.push(c00, c10, c11, c00, c11, c01);
        shellThk.push(0.5, 0.5);
      }
    wallTets = shellWallTets(oneBody, {
      walls: [],
      shellBody: 1,
      shellVerts,
      shellTris,
      shellThk,
      shellSrc: new Array(shellVerts.length / 3).fill(1),
      shellTriSrc: new Array(shellThk.length).fill(1),
    });
  });

  test("wall-tet detection separates thin from thick WITHIN one body", () => {
    let wallHigh = 0,
      wallLow = 0;
    for (const element of wallTets) {
      let meanZ = 0;
      for (let corner = 0; corner < 4; corner++)
        meanZ += verts[3 * tet[4 * element + corner] + 2];
      meanZ /= 4;
      if (meanZ > 9) wallHigh++;
      else wallLow++;
    }
    // Every tet of the thin layer must be claimed — a wall represented by shells
    // AND by leftover solid tets is counted twice.
    let thinTets = 0;
    for (let element = 0; element < tet.length / 4; element++) {
      let meanZ = 0;
      for (let corner = 0; corner < 4; corner++)
        meanZ += verts[3 * tet[4 * element + corner] + 2];
      if (meanZ / 4 > 9) thinTets++;
    }
    expect(wallHigh, `thin=${wallHigh}/${thinTets}`).toBe(thinTets);
    expect(wallLow, `thick=${wallLow}`).toBe(0);
  });

  // No surface mesh here, so wall-pair detection has nothing to work with and
  // must report "no shell body" rather than inventing one.
  test("extractThinWallShells reports no shell body when no wall pair is found", () => {
    const noWalls = extractThinWallShells(oneBody, {
      shellBodyIds: new Set([1]),
    });
    expect(noWalls.shellBody).toBe(-1);
    expect(noWalls.shellTris).toHaveLength(0);
  });
});
