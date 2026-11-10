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
//
// Usage:  bash ../scripts/build-fem-wasm.sh && bun tests/test_shellize_models.mjs
//         (from web/; the engine comes from scripts/fetch-wasm-engine.sh)

import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  loadEngine,
  meshStep,
  surfaceVertices,
} from "../../examples/shell-coupling/lib.mjs";
import {
  buildCoupledModel,
  buildExplicitCoupledModel,
  buildShellTransitionModel,
  couplingMpcCodes,
  extractThinWallShells,
  shellWallTets,
} from "../src/lib/shellize.ts";
import { loadFemModule } from "../src/lib/femModule.ts";

await loadFemModule();

const here = dirname(fileURLToPath(import.meta.url));
const testFiles = join(here, "../../test_files");

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`  [PASS] ${name}`);
  else {
    failures++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function equal(name, actual, expected) {
  check(`${name} = ${expected}`, actual === expected, `got ${actual}`);
}

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

const meshes = new Map();
const Module = await loadEngine();

for (const expected of CASES) {
  const { step, size } = expected;
  console.log(`\n${step} (max element size ${size} mm)`);
  const meshed = meshStep(Module, join(testFiles, step), {
    maxElementSize: size,
  });
  // Plain arrays, as the app's buildShellizeMesh passes them.
  const mesh = {
    ...meshed,
    surfTri: Array.from(meshed.surfTri),
    surfFace: Array.from(meshed.surfFace),
  };
  meshes.set(step, mesh);
  const shells = extractThinWallShells(mesh);
  equal("shell body", shells.shellBody, expected.shellBody);
  if (shells.shellBody < 0) continue;

  const start = performance.now();
  let transition;
  try {
    transition = buildShellTransitionModel(
      mesh,
      extractThinWallShells(mesh, {
        shellBodyIds: new Set([shells.shellBody]),
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(
      "refused as the TS pipeline refused it",
      expected.refuses !== undefined && message.startsWith(expected.refuses),
      message,
    );
    continue;
  }
  console.log(
    `  built in ${((performance.now() - start) / 1000).toFixed(2)} s`,
  );
  check("built (the TS pipeline built it too)", expected.refuses === undefined);
  const { model } = transition;
  equal("walls", transition.shells.walls.length, expected.walls);
  equal("shell nodes", model.shellPool.length, expected.shellNodes);
  equal("shell facets", model.triangles.length / 3, expected.facets);
  equal("solid tets", model.tets.length / 4, expected.solidTets);
  equal(
    "couplings by kind (RBE3/MPC/RBE2/footprint)",
    kindCounts(model.coupling),
    expected.couplings,
  );
  equal(
    "surface triangles",
    transition.mesh.surfFace.length,
    expected.surfaceTriangles,
  );
}

// ── Explicit mixed model with a declared tie (the crane hook's pin/eye) ──────
// The mixed mesh of the crane showcase (examples/shell-coupling): the holder's
// wall tets become shells and its base stays solid. Rebuild the couplings from
// the explicit elements with the showcase's pin/eye tie, plus a tie whose
// surface B has no node in the pool.
{
  console.log(
    "\nfull-crane-hook.step — explicit mixed model with the pin/eye tie",
  );
  const mesh = meshes.get("full-crane-hook.step");
  const shells = extractThinWallShells(mesh);
  const model = buildCoupledModel(mesh, shells, shellWallTets(mesh, shells));
  const { byBody, byFace } = surfaceVertices(mesh);
  const toPool = (vertices) =>
    [...vertices].flatMap((vertex) => {
      const index = model.solidPool.get(vertex);
      return index === undefined ? [] : [index];
    });
  const explicit = buildExplicitCoupledModel(
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
  equal("explicit couplings", explicit.coupling.ref.length, 112);
  equal("explicit partner slots", explicit.coupling.solid.length, 1296);
  equal("tie reports", explicit.tieReports.length, 2);
  check(
    "the pin/eye tie connects",
    explicit.tieReports[0].problem === undefined,
    explicit.tieReports[0].problem,
  );
  check(
    "the empty tie says why it coupled nothing",
    explicit.tieReports[1].drop?.kind === "no-pool-nodes" &&
      explicit.tieReports[1].drop.side === "B" &&
      (explicit.tieReports[1].problem ?? "").includes(
        "picked surface B has no node",
      ),
    JSON.stringify(explicit.tieReports[1]),
  );
}

console.log(
  failures === 0
    ? "\nShell idealisation matches the recorded results."
    : `\n${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
