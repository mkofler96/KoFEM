// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Release gate A of v0.7.0 (KOF-355): every published example, built as a
// user builds it in the GUI (lib/pipeline.mjs) and solved on the path the app
// takes for it — the Rust module — against the C++ engine's solver for the
// same model, which was the app's path up to v0.6.0:
//
//   all-solid, no constraint tie   Rust AMG CG       vs  MFEM solve_linear_elastic
//   all-shell                      Rust DKT shell    vs  solve_shell
//   topology optimization (solid)  Rust SIMP / level set  vs  optimize_topology
//
// A model with a constraint (MPC) tie has no C++ counterpart: MPC ties exist
// only in the Rust solver (KOF-318), so those cases are checked against their
// closed-form reference by run.mjs alone, and are listed here as such.
//
// Run from web/ after `bun run wasm:prepare`:
//
//   bun ../examples/validation/oracle.mjs            # compare, print the table
//   bun ../examples/validation/oracle.mjs --record   # also write oracle-reference.json
//
// oracle-reference.json keeps what the C++ engine computed for each example,
// so the comparison outlives the engine's solvers (KOF-309): `--check`
// compares the Rust path against the stored values instead of the engine.
//
//   bun ../examples/validation/oracle.mjs --check
//
// Exits non-zero when a difference is above its tolerance.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cases from "./cases/index.mjs";
import galleryRecipes from "../gallery/recipes/index.mjs";
import {
  buildFromRecipe,
  cxxExceptionText,
  evaluateProbe,
  freshEngine,
} from "./lib/pipeline.mjs";
import { engineId, femModuleId } from "./lib/provenance.mjs";
import { routeSolve } from "../../web/src/lib/solve/route.ts";
import {
  buildSolidEngineInputs,
  expandTiedDisplacements,
  weldTies,
} from "../../web/src/lib/solve/solid.ts";
import { buildShellEngineInputs } from "../../web/src/lib/solve/shell.ts";
import { constraintTieCount } from "../../web/src/lib/tie.ts";
import { buildVertexIndexer } from "../../web/src/lib/solveMeshPacking.ts";
import { optimizeSolidInRust } from "../../web/src/lib/solve/topOptRust.ts";
import { loadFem } from "../../web/tests/support/wasm.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REFERENCE = join(here, "oracle-reference.json");

// Both solvers iterate to a relative residual of 1e-8 (MFEM order 2: 1e-6),
// so their fields agree far closer than this; a real difference in the
// assembly or the boundary conditions shows up orders of magnitude above it.
const FIELD_TOLERANCE = 1e-3;
// A topology optimization amplifies round-off over its iterations: the final
// compliance must agree to this, and no more than this share of the
// elements may differ in density by more than 0.1.
const COMPLIANCE_TOLERANCE = 1e-3;
const DESIGN_SHARE_TOLERANCE = 0.01;

const record = process.argv.includes("--record");
const check = process.argv.includes("--check");
if (record && check)
  throw new Error("--record writes the reference, --check reads it: pick one");

const fem = await loadFem();
const stored = check ? JSON.parse(readFileSync(REFERENCE, "utf8")) : null;

// ── Differences ──────────────────────────────────────────────────────────────

// Largest nodal displacement difference over the largest oracle displacement.
function displacementDifference(rust, oracle) {
  let largest = 0;
  let difference = 0;
  for (let i = 0; i < oracle.length; i += 3) {
    const norm = Math.hypot(oracle[i], oracle[i + 1], oracle[i + 2]);
    const delta = Math.hypot(
      rust[i] - oracle[i],
      rust[i + 1] - oracle[i + 1],
      rust[i + 2] - oracle[i + 2],
    );
    largest = Math.max(largest, norm);
    difference = Math.max(difference, delta);
  }
  return difference / largest;
}

// Largest element von Mises difference over the largest oracle von Mises.
function fieldDifference(rust, oracle) {
  if (rust.length !== oracle.length)
    throw new Error(
      `the Rust field has ${rust.length} values, the oracle's ${oracle.length}`,
    );
  let largest = 0;
  let difference = 0;
  for (let i = 0; i < oracle.length; i++) {
    largest = Math.max(largest, Math.abs(oracle[i]));
    difference = Math.max(difference, Math.abs(rust[i] - oracle[i]));
  }
  return difference / largest;
}

const relative = (value, reference) =>
  Math.abs(value - reference) / Math.abs(reference);

const maxNorm = (u) => {
  let largest = 0;
  for (let i = 0; i < u.length; i += 3)
    largest = Math.max(largest, Math.hypot(u[i], u[i + 1], u[i + 2]));
  return largest;
};
const maxOf = (values) => values.reduce((a, b) => Math.max(a, b), 0);

// ── The C++ solvers ──────────────────────────────────────────────────────────

function engineCall(engine, what, call) {
  try {
    const result = call();
    if (result && typeof result === "object" && "error" in result)
      throw new Error(`${what}: ${result.error}`);
    return result;
  } catch (err) {
    if (typeof err !== "number") throw err;
    throw new Error(`${what}: ${cxxExceptionText(engine, err)}`);
  }
}

// The worker's solid path before KOF-307: node-merge ties welded, then MFEM.
async function solveSolidInEngine(payload) {
  const tied = weldTies(
    payload.nodes,
    payload.elements,
    payload.tieGroups,
    () => {},
    null,
  );
  const { mesh, matJson, bcsJson } = buildSolidEngineInputs(
    { ...payload, nodes: tied.solveNodes, elements: tied.tiedElements },
    tied.vid,
    tied.vidTied,
  );
  const engine = await freshEngine();
  const result = engineCall(engine, "solve_linear_elastic", () =>
    engine.solve_linear_elastic(mesh, matJson, bcsJson, payload.elementOrder),
  );
  return {
    displacements: expandTiedDisplacements(
      payload.nodes,
      tied,
      result.displacements,
    ),
    vonMises: result.von_mises,
  };
}

// The worker's pure-shell path before KOF-306.
async function solveShellInEngine(payload) {
  const { mesh, matJson, bcsJson } = buildShellEngineInputs(payload);
  const engine = await freshEngine();
  const result = engineCall(engine, "solve_shell", () =>
    engine.solve_shell(mesh, matJson, bcsJson),
  );
  return { displacements: result.displacements, vonMises: result.von_mises };
}

// ── Static examples ──────────────────────────────────────────────────────────

async function staticRow(id, recipe) {
  const build = await buildFromRecipe(id, recipe);
  const payload = build.solvePayload;
  const route = routeSolve(payload);
  const base = {
    id,
    nodes: build.nodes.length,
    elements: build.elements.length,
    order: payload.elementOrder,
  };
  const rust = {
    fe: build.fe,
    maxDisplacement: maxNorm(build.result.displacements),
    maxVonMises: maxOf(build.result.vonMises),
  };
  if (route.path === "solid" && constraintTieCount(payload.tieGroups) > 0)
    return {
      ...base,
      path: "Rust AMG CG, MPC tie",
      oracle: "none — MPC ties are Rust-only (KOF-318); closed form in run.mjs",
      rust,
    };
  const [path, oracleName, solve] =
    route.path === "solid"
      ? ["Rust AMG CG", "MFEM solve_linear_elastic", solveSolidInEngine]
      : route.path === "shell"
        ? ["Rust DKT shell", "C++ solve_shell", solveShellInEngine]
        : [null, null, null];
  if (!solve)
    throw new Error(`${id}: no oracle for the "${route.path}" solve path`);
  const reference = storedOracle(id) ?? (await oracleOf(solve, build));
  const fields = check
    ? null
    : {
        displacement: displacementDifference(
          build.result.displacements,
          reference.displacements,
        ),
        vonMises: fieldDifference(build.result.vonMises, reference.vonMises),
      };
  const differences = {
    ...(fields ?? {}),
    fe: relative(rust.fe, reference.summary.fe),
    maxDisplacement: relative(
      rust.maxDisplacement,
      reference.summary.maxDisplacement,
    ),
    maxVonMises: relative(rust.maxVonMises, reference.summary.maxVonMises),
  };
  return {
    ...base,
    path,
    oracle: oracleName,
    rust,
    reference: reference.summary,
    differences,
    tolerance: FIELD_TOLERANCE,
    pass: Object.values(differences).every((d) => d <= FIELD_TOLERANCE),
  };
}

async function oracleOf(solve, build) {
  const result = await solve(build.solvePayload);
  const fe = evaluateProbe(build.probe, {
    nodes: build.nodes,
    elements: build.elements,
    surfaceTriangles: build.surfaceTriangles,
    surfaceFaceIds: build.surfaceFaceIds,
    result,
  });
  return {
    displacements: result.displacements,
    vonMises: result.vonMises,
    summary: {
      fe,
      maxDisplacement: maxNorm(result.displacements),
      maxVonMises: maxOf(result.vonMises),
    },
  };
}

function storedOracle(id) {
  if (!stored) return null;
  const row = stored.examples.find((r) => r.id === id);
  if (!row?.reference)
    throw new Error(`${REFERENCE} has no C++ reference for "${id}"`);
  return { summary: row.reference };
}

// The stored reference holds for the mesh it was computed on only: a mesher
// change that moves the node or element count makes it stale.
function checkSameMesh(row) {
  if (!stored) return;
  const was = stored.examples.find((r) => r.id === row.id);
  if (!was) throw new Error(`${REFERENCE} has no entry for "${row.id}"`);
  if (was.nodes !== row.nodes || was.elements !== row.elements)
    throw new Error(
      `${row.id}: the mesh has ${row.nodes} nodes and ${row.elements} elements, the C++ reference was computed on ${was.nodes} and ${was.elements} — the stored comparison no longer applies`,
    );
}

// ── Topology optimization ────────────────────────────────────────────────────

// The Optimize panel's settings for a recipe's study, with `method`.
function topOptSettings(optimize, method) {
  const common = {
    method,
    objective: optimize.objective,
    constraints: { volumeFraction: optimize.volumeFraction },
    filterRadius: method === "simp" ? optimize.filterRadius : 0,
    maxIterations: optimize.maxIterations,
    tolerance: optimize.tolerance,
  };
  return method === "simp"
    ? { ...common, penalty: optimize.penalty, moveLimit: optimize.moveLimit }
    : common;
}

async function topOptRows(id, recipe) {
  const build = await buildFromRecipe(id, recipe, {
    // The comparison runs both optimizers below; the pipeline's own C++
    // run would be redundant, and --check must not need the C++ optimizer.
    skipOptimization: true,
  });
  const rows = [];
  for (const method of ["simp", "level_set"]) {
    const settings = topOptSettings(recipe.optimize, method);
    const payload = { ...build.solvePayload, settings };
    const rust = optimizeSolidInRust(
      fem,
      payload,
      () => {},
      () => {},
    );
    const rowId = `${id} (${method === "simp" ? "SIMP" : "level set"})`;
    const summary = (run) => ({
      compliance: run.history.at(-1).compliance,
      volume: run.history.at(-1).volume,
      iterations: run.history.length,
    });
    const reference = stored
      ? stored.examples.find((r) => r.id === rowId)?.reference
      : null;
    let oracle = null;
    if (!stored) {
      const { mesh, matJson, bcsJson } = buildSolidEngineInputs(
        payload,
        buildVertexIndexer(payload.nodes),
      );
      const engine = await freshEngine();
      oracle = engineCall(engine, "optimize_topology", () =>
        engine.optimize_topology(
          mesh,
          matJson,
          bcsJson,
          JSON.stringify(settings),
          null,
        ),
      );
    } else if (!reference)
      throw new Error(`${REFERENCE} has no C++ reference for "${rowId}"`);
    const oracleSummary = oracle ? summary(oracle) : reference;
    const differences = {
      compliance: relative(summary(rust).compliance, oracleSummary.compliance),
      volume: Math.abs(summary(rust).volume - oracleSummary.volume),
    };
    if (oracle) {
      const differing = Array.from(rust.density).filter(
        (rho, e) => Math.abs(rho - oracle.density[e]) > 0.1,
      ).length;
      differences.designShare = differing / oracle.density.length;
    }
    rows.push({
      id: rowId,
      nodes: build.nodes.length,
      elements: build.elements.length,
      order: 1,
      path: `Rust ${method === "simp" ? "SIMP" : "level set"}`,
      oracle: "C++ optimize_topology",
      rust: summary(rust),
      reference: oracleSummary,
      differences,
      tolerance: COMPLIANCE_TOLERANCE,
      pass:
        differences.compliance <= COMPLIANCE_TOLERANCE &&
        differences.volume <= COMPLIANCE_TOLERANCE &&
        (differences.designShare ?? 0) <= DESIGN_SHARE_TOLERANCE,
    });
  }
  return rows;
}

// ── Run ──────────────────────────────────────────────────────────────────────

const rows = [];
for (const c of cases) {
  process.stderr.write(`▶ ${c.id}\n`);
  const row = await staticRow(c.id, c.recipe);
  checkSameMesh(row);
  rows.push(row);
}
for (const [id, recipe] of Object.entries(galleryRecipes)) {
  process.stderr.write(`▶ ${id}\n`);
  if (!recipe.optimize)
    throw new Error(`${id}: a gallery recipe without an optimization`);
  const topOpt = await topOptRows(id, recipe);
  topOpt.forEach(checkSameMesh);
  rows.push(...topOpt);
}

const sci = (x) => (x === undefined ? "—" : x.toExponential(1));
console.log(
  "| Example | Mesh | Path | Oracle | Δu | Δσ_vM | Δ probe / Δc | Δ design | Pass |",
);
console.log("|---|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  const d = r.differences ?? {};
  console.log(
    `| ${r.id} | ${r.nodes} nodes, ${r.elements} el., order ${r.order} | ${r.path} | ${r.oracle} | ` +
      `${sci(d.displacement)} | ${sci(d.vonMises)} | ${sci(d.fe ?? d.compliance)} | ` +
      `${d.designShare === undefined ? "—" : `${(100 * d.designShare).toFixed(2)} %`} | ` +
      `${r.pass === undefined ? "n/a" : r.pass ? "pass" : "FAIL"} |`,
  );
}

if (record) {
  const reference = {
    note: "What the C++ engine computed for each published example, on the model the app builds (examples/validation/oracle.mjs). Kept so the Rust path stays checked against it after the engine's solvers are removed (KOF-309).",
    engine: engineId(),
    femModule: femModuleId(),
    tolerances: {
      field: FIELD_TOLERANCE,
      compliance: COMPLIANCE_TOLERANCE,
      designShare: DESIGN_SHARE_TOLERANCE,
    },
    examples: rows.map(
      ({ id, nodes, elements, order, path, oracle, reference: ref }) => ({
        id,
        nodes,
        elements,
        order,
        path,
        oracle,
        ...(ref ? { reference: ref } : {}),
      }),
    ),
  };
  writeFileSync(REFERENCE, JSON.stringify(reference, null, 2) + "\n");
  console.error(`Wrote ${REFERENCE}`);
}

const failed = rows.filter((r) => r.pass === false);
if (failed.length > 0) {
  console.error(
    `${failed.length} example(s) above tolerance: ${failed.map((r) => r.id).join(", ")}`,
  );
  process.exit(1);
}
