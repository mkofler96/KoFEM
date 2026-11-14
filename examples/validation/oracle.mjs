// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Every published example, built as a user builds it in the GUI
// (lib/pipeline.mjs) and solved on the app's Rust path, against what the C++
// engine's solver computed for the same model (release gate A of v0.7.0,
// KOF-355). The C++ solvers left the engine (KOF-309); what they computed is
// kept in oracle-reference.json, recorded with engine-3397ae8ea1eb:
//
//   all-solid, no constraint tie   Rust AMG CG       vs  MFEM solve_linear_elastic
//   all-shell                      Rust DKT shell    vs  solve_shell
//   topology optimization (solid)  Rust SIMP / level set  vs  optimize_topology
//
// A model with a constraint (MPC) tie had no C++ counterpart: MPC ties exist
// only in the Rust solver (KOF-318), so those cases are checked against their
// closed-form reference by run.mjs alone, and are listed here as such.
//
// Run from web/ after `bun run wasm:prepare`:
//
//   bun run validate:oracle
//
// Exits non-zero when a difference is above its tolerance, or when an
// example's mesh no longer matches the one the reference was computed on.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cases from "./cases/index.mjs";
import galleryRecipes from "../gallery/recipes/index.mjs";
import { buildFromRecipe } from "./lib/pipeline.mjs";
import { routeSolve } from "../../web/src/lib/solve/route.ts";
import { constraintTieCount } from "../../web/src/lib/tie.ts";
import { optimizeSolidInRust } from "../../web/src/lib/solve/topOptRust.ts";
import { loadFem } from "../../web/tests/support/wasm.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REFERENCE = join(here, "oracle-reference.json");
const stored = JSON.parse(readFileSync(REFERENCE, "utf8"));

// Both solvers iterated to a relative residual of 1e-8 (MFEM order 2: 1e-6),
// so their results agree far closer than this; a real difference in the
// assembly or the boundary conditions shows up orders of magnitude above it.
// A topology optimization amplifies round-off over its iterations: the
// compliance after the same number of steps must agree to this.
const { field: FIELD_TOLERANCE, compliance: COMPLIANCE_TOLERANCE } =
  stored.tolerances;

const fem = await loadFem();

const relative = (value, reference) =>
  Math.abs(value - reference) / Math.abs(reference);

const maxNorm = (u) => {
  let largest = 0;
  for (let i = 0; i < u.length; i += 3)
    largest = Math.max(largest, Math.hypot(u[i], u[i + 1], u[i + 2]));
  return largest;
};
const maxOf = (values) => values.reduce((a, b) => Math.max(a, b), 0);

// The stored entry of an example, for the mesh it was computed on only: a
// mesher change that moves the node or element count makes it stale.
function storedEntry(row) {
  const was = stored.examples.find((r) => r.id === row.id);
  if (!was) throw new Error(`${REFERENCE} has no entry for "${row.id}"`);
  if (was.nodes !== row.nodes || was.elements !== row.elements)
    throw new Error(
      `${row.id}: the mesh has ${row.nodes} nodes and ${row.elements} elements, the C++ reference was computed on ${was.nodes} and ${was.elements} — the stored comparison no longer applies`,
    );
  return was;
}

// ── Static examples ──────────────────────────────────────────────────────────

async function staticRow(id, recipe) {
  const build = await buildFromRecipe(id, recipe);
  const payload = build.solvePayload;
  const route = routeSolve(payload);
  const row = {
    id,
    nodes: build.nodes.length,
    elements: build.elements.length,
    order: payload.elementOrder,
  };
  const was = storedEntry(row);
  if (route.path === "solid" && constraintTieCount(payload.tieGroups) > 0)
    return { ...row, path: "Rust AMG CG, MPC tie", oracle: was.oracle };
  if (!was.reference)
    throw new Error(`${REFERENCE} has no C++ reference for "${id}"`);
  const rust = {
    fe: build.fe,
    maxDisplacement: maxNorm(build.result.displacements),
    maxVonMises: maxOf(build.result.vonMises),
  };
  const differences = {
    fe: relative(rust.fe, was.reference.fe),
    maxDisplacement: relative(
      rust.maxDisplacement,
      was.reference.maxDisplacement,
    ),
    maxVonMises: relative(rust.maxVonMises, was.reference.maxVonMises),
  };
  return {
    ...row,
    path: was.path,
    oracle: was.oracle,
    differences,
    pass: Object.values(differences).every((d) => d <= FIELD_TOLERANCE),
  };
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
  const build = await buildFromRecipe(id, recipe, { skipOptimization: true });
  const rows = [];
  for (const method of ["simp", "level_set"]) {
    const settings = topOptSettings(recipe.optimize, method);
    const rust = optimizeSolidInRust(
      fem,
      { ...build.solvePayload, settings },
      () => {},
      () => {},
    );
    const row = {
      id: `${id} (${method === "simp" ? "SIMP" : "level set"})`,
      nodes: build.nodes.length,
      elements: build.elements.length,
      order: 1,
    };
    const was = storedEntry(row);
    if (!was.reference)
      throw new Error(`${REFERENCE} has no C++ reference for "${row.id}"`);
    // The stored reference is the engine's last step. A run whose design does
    // not come to rest (the MBB beam's SIMP run, KOF-360) meets its tolerance
    // at an iteration that round-off moves, so the two can stop apart: compare
    // the Rust run at the engine's last step when it got there, else end to
    // end.
    const steps = Math.min(rust.history.length, was.reference.iterations);
    const there =
      steps === was.reference.iterations
        ? rust.history[steps - 1]
        : rust.history.at(-1);
    const differences = {
      compliance: relative(there.compliance, was.reference.compliance),
      volume: Math.abs(there.volume - was.reference.volume),
    };
    rows.push({
      ...row,
      path: was.path,
      oracle: was.oracle,
      differences,
      pass:
        differences.compliance <= COMPLIANCE_TOLERANCE &&
        differences.volume <= COMPLIANCE_TOLERANCE,
    });
  }
  return rows;
}

// ── Run ──────────────────────────────────────────────────────────────────────

const rows = [];
for (const c of cases) {
  process.stderr.write(`▶ ${c.id}\n`);
  rows.push(await staticRow(c.id, c.recipe));
}
for (const [id, recipe] of Object.entries(galleryRecipes)) {
  process.stderr.write(`▶ ${id}\n`);
  if (!recipe.optimize)
    throw new Error(`${id}: a gallery recipe without an optimization`);
  rows.push(...(await topOptRows(id, recipe)));
}

const sci = (x) => (x === undefined ? "—" : x.toExponential(1));
console.log("| Example | Mesh | Path | C++ reference | Δ probe / Δc | Pass |");
console.log("|---|---|---|---|---|---|");
for (const r of rows) {
  const d = r.differences ?? {};
  console.log(
    `| ${r.id} | ${r.nodes} nodes, ${r.elements} el., order ${r.order} | ${r.path} | ${r.oracle} | ` +
      `${sci(d.fe ?? d.compliance)} | ` +
      `${r.pass === undefined ? "n/a" : r.pass ? "pass" : "FAIL"} |`,
  );
}

const failed = rows.filter((r) => r.pass === false);
if (failed.length > 0) {
  console.error(
    `${failed.length} example(s) above tolerance: ${failed.map((r) => r.id).join(", ")}`,
  );
  process.exit(1);
}
