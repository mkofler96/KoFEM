// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The shell idealisation on real meshed models (crates/kofem-shellize through
// src/lib/shellize.ts, KOF-297).
//
// Each case meshes a STEP file with the engine and builds the mesh-time shell
// model exactly as the solver worker does. The expected values are the ones the
// TypeScript pipeline produced before it was replaced by the Rust port: the
// port was checked against it array by array (identical pools, tets, facets,
// surface meshes and couplings; coordinates within 2e-14) before the switch.
// A change here means the idealisation itself changed — re-validate the shell
// examples before updating a number.

import { beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  loadEngine,
  meshStep,
  surfaceVertices,
} from "../../../examples/shell-coupling/lib.mjs";
import {
  buildCoupledModel,
  buildExplicitCoupledModel,
  buildShellTransitionModel,
  couplingMpcCodes,
  extractThinWallShells,
  shellWallTets,
} from "../../src/lib/shellize.ts";
import { loadFem } from "../support/wasm.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const testFiles = join(here, "../../../test_files");

const kindCounts = (coupling) => {
  const counts = [0, 0, 0, 0];
  for (const kind of couplingMpcCodes(coupling)) counts[kind]++;
  return counts.join("/");
};

// Mesh-time result per model, as the TS pipeline produced it. `refuses` holds
// the start of the refusal for a Shell body the walls do not cover.
const CASES = [
  {
    step: "crane_holder_only.step",
    size: 6,
    shellBody: 1,
    walls: 5,
    shellNodes: 2933,
    facets: 5358,
    solidTets: 0,
    couplings: "0/0/0/0",
    surfaceTriangles: 11620,
  },
  {
    step: "fin_two_parts.step",
    size: 6,
    shellBody: 2,
    walls: 1,
    shellNodes: 199,
    facets: 324,
    solidTets: 4925,
    couplings: "0/0/0/71",
    surfaceTriangles: 1623,
  },
  {
    step: "single_fin.step",
    size: 4,
    shellBody: 1,
    refuses:
      'Body 1 is marked "Shell", but 13278 of its 15305 elements (94.1 %',
  },
  {
    step: "full-crane-hook.step",
    size: 6,
    shellBody: 1,
    refuses: 'Body 1 is marked "Shell", but 1101 of its 15626 elements (35.0 %',
  },
  {
    step: "Wall Bracket.stp",
    size: 6,
    shellBody: 1,
    refuses: 'Body 1 is marked "Shell", but 8047 of its 38206 elements (17.8 %',
  },
  // The web and both flanges, welded along the two web/flange T-junctions
  // (KOF-205). Before, the 15 mm web just missed maxWall = 15 and the split
  // flange faces never paired, so no wall was found at all.
  {
    step: "I_beam.step",
    size: 10,
    shellBody: 1,
    walls: 3,
    shellNodes: 884,
    facets: 1652,
    solidTets: 0,
    couplings: "0/0/0/0",
    surfaceTriangles: 3286,
  },
];

let Module = null;
const meshes = new Map();

// Meshes a STEP file once per file run; the explicit-tie tests reuse the
// crane hook's mesh.
function meshOf(step, size) {
  let mesh = meshes.get(step);
  if (!mesh) {
    const meshed = meshStep(Module, join(testFiles, step), {
      maxElementSize: size,
    });
    // Plain arrays, as the app's buildShellizeMesh passes them.
    mesh = {
      ...meshed,
      surfTri: Array.from(meshed.surfTri),
      surfFace: Array.from(meshed.surfFace),
    };
    meshes.set(step, mesh);
  }
  return mesh;
}

beforeAll(async () => {
  await loadFem();
  Module = await loadEngine();
});

for (const expected of CASES) {
  const { step, size } = expected;
  describe(`${step} (max element size ${size} mm)`, () => {
    let shells = null;
    let transition = null;
    let buildError = null;

    beforeAll(() => {
      const mesh = meshOf(step, size);
      shells = extractThinWallShells(mesh);
      if (shells.shellBody < 0) return;
      try {
        transition = buildShellTransitionModel(
          mesh,
          extractThinWallShells(mesh, {
            shellBodyIds: new Set([shells.shellBody]),
          }),
        );
      } catch (error) {
        buildError = error instanceof Error ? error : new Error(String(error));
      }
    });

    test("shell body", () => {
      expect(shells.shellBody).toBe(expected.shellBody);
    });

    if (expected.refuses !== undefined) {
      test("refused as the TS pipeline refused it", () => {
        expect(buildError, "the model was built, not refused").toBeInstanceOf(
          Error,
        );
        expect(buildError.message).toStartWith(expected.refuses);
      });
      return;
    }

    test("built (the TS pipeline built it too)", () => {
      expect(buildError?.message).toBeUndefined();
      expect(transition).toEqual(expect.any(Object));
    });

    test("walls", () => {
      expect(transition.shells.walls.length).toBe(expected.walls);
    });

    test("shell nodes", () => {
      expect(transition.model.shellPool.length).toBe(expected.shellNodes);
    });

    test("shell facets", () => {
      expect(transition.model.triangles.length / 3).toBe(expected.facets);
    });

    test("solid tets", () => {
      expect(transition.model.tets.length / 4).toBe(expected.solidTets);
    });

    test("couplings by kind (RBE3/MPC/RBE2/footprint)", () => {
      expect(kindCounts(transition.model.coupling)).toBe(expected.couplings);
    });

    test("surface triangles", () => {
      expect(transition.mesh.surfFace.length).toBe(expected.surfaceTriangles);
    });
  });
}

// ── Explicit mixed model with a declared tie (the crane hook's pin/eye) ──────
// The mixed mesh of the crane showcase (examples/shell-coupling): the holder's
// wall tets become shells and its base stays solid. Rebuild the couplings from
// the explicit elements with the showcase's pin/eye tie, plus a tie whose
// surface B has no node in the pool.
describe("full-crane-hook.step — explicit mixed model with the pin/eye tie", () => {
  let explicit = null;

  beforeAll(() => {
    const mesh = meshOf("full-crane-hook.step", 6);
    const shells = extractThinWallShells(mesh);
    const model = buildCoupledModel(mesh, shells, shellWallTets(mesh, shells));
    const { byBody, byFace } = surfaceVertices(mesh);
    const toPool = (vertices) =>
      [...vertices].flatMap((vertex) => {
        const index = model.solidPool.get(vertex);
        return index === undefined ? [] : [index];
      });
    explicit = buildExplicitCoupledModel(
      model.pool,
      model.tets,
      model.triangles,
      model.thicknesses,
      {
        ties: [
          {
            name: "pin/eye",
            verticesA: toPool(byBody.get(2)),
            verticesB: toPool(byFace.get(65)),
            maxSeparation: 3.0,
          },
          {
            name: "empty side",
            verticesA: toPool(byBody.get(2)),
            verticesB: [],
            maxSeparation: 3.0,
          },
        ],
      },
    );
  });

  test("explicit couplings", () => {
    expect(explicit.coupling.ref.length).toBe(112);
  });

  test("explicit partner slots", () => {
    expect(explicit.coupling.solid.length).toBe(1296);
  });

  test("tie reports", () => {
    expect(explicit.tieReports.length).toBe(2);
  });

  test("the pin/eye tie connects", () => {
    expect(explicit.tieReports[0].problem).toBeUndefined();
  });

  test("the empty tie says why it coupled nothing", () => {
    const report = explicit.tieReports[1];
    const diagnostic = JSON.stringify(report);
    expect(report.drop?.kind, diagnostic).toBe("no-pool-nodes");
    expect(report.drop?.side, diagnostic).toBe("B");
    expect(report.problem ?? "", diagnostic).toContain(
      "picked surface B has no node",
    );
  });
});
