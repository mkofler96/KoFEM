// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Validation runner: solves every case through the real WASM engine and checks
// the finite-element result against its closed-form / published reference.
//
//   node examples/validation/run.mjs            # run + print table + check page
//   node examples/validation/run.mjs --report   # also regenerate REPORT.md and
//                                               # the public page /validation/
//
// Exits non-zero if any case falls outside its tolerance band, so CI fails on a
// solver regression — or if the numbers published on /validation/ no longer
// match a fresh run, so the public page cannot drift from the engine. See
// README.md for what each case validates.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { loadSolver } from "./lib/solver.mjs";
import { meshStats } from "./lib/mesh.mjs";
import {
  CONSOLE_RULE,
  consoleHeader,
  consoleRow,
  fmt,
  fmtErr,
  relErrPct,
} from "./lib/format.mjs";
import { renderValidationPage } from "./lib/page.mjs";
import cases from "./cases/index.mjs";
import studies from "./convergence.mjs";
import reproduce from "./reproduce.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
const PAGE = join(repo, "web/validation/index.html");
const DATA = join(repo, "web/public/validation/results.json");
const REPORT = join(here, "REPORT.md");
const ENGINE_STAMP = join(repo, "web/src/wasm/pkg/.engine-id");

// A published FE value counts as current when a fresh run reproduces it to
// this relative tolerance — tighter than the page's five significant digits.
const PUBLISHED_RTOL = 1e-4;

const report = process.argv.includes("--report");
const solve = await loadSolver();

// Run `fn` with a solve() that records the mesh it is handed, so the page
// states the size of the mesh actually solved rather than a hand-kept count.
function solveOnce(fn) {
  const meshes = [];
  const value = fn((mesh, material, bcs, order = 1) => {
    meshes.push(meshStats(mesh, order));
    return solve(mesh, material, bcs, order);
  });
  if (meshes.length !== 1)
    throw new Error(
      `expected exactly one solve per run, got ${meshes.length} — the page reports one mesh per value`,
    );
  return { value, mesh: meshes[0] };
}

const rows = cases.map((c) => {
  const { value: fe, mesh } = solveOnce((s) => c.run(s));
  const errPct = relErrPct(fe, c.reference);
  return {
    id: c.id,
    name: c.name,
    quantity: c.quantity,
    unit: c.unit,
    reference: c.reference,
    referenceLabel: c.referenceLabel,
    tolPct: c.tolPct,
    fe,
    errPct,
    pass: Math.abs(errPct) <= c.tolPct,
    mesh,
    inputs: c.page.inputs.map(([symbol, value, unit]) => ({
      symbol,
      value,
      unit,
    })),
  };
});
const failed = rows.filter((r) => !r.pass).length;

// The in-app reproduction: what the app's Result summary shows for the gallery
// cantilever. Cheap (one small solve), so it is checked on every run.
const app = (() => {
  const { value } = solveOnce((s) => reproduce.run(s));
  return {
    caseId: reproduce.caseId,
    galleryId: reproduce.galleryId,
    field: reproduce.field,
    stat: reproduce.stat,
    unit: reproduce.unit,
    reference: reproduce.reference,
    appValue: value.appValue,
    // Exactly as ResultsPanel prints it: toExponential(3) and the unit.
    appReadout: `${value.appValue.toExponential(3)} ${reproduce.unit}`,
    faceMean: value.faceMean,
    errPct: relErrPct(value.faceMean, reproduce.reference),
  };
})();

// ── Console table ─────────────────────────────────────────────────────────────
console.log("\nKoFEM validation suite — FE result vs. analytical reference\n");
console.log(consoleHeader());
console.log(CONSOLE_RULE);
for (const r of rows) console.log(consoleRow(r));
console.log(CONSOLE_RULE);
console.log(
  `${rows.length - failed}/${rows.length} passed` +
    (failed ? `  —  ${failed} FAILED` : "  —  all within tolerance"),
);

const rel = (p) => relative(repo, p);

if (report) {
  // ── Convergence studies (slow: ~half a minute) ──────────────────────────────
  const byId = new Map(rows.map((r) => [r.id, r]));
  const caseRow = (id) => {
    const r = byId.get(id);
    if (!r) throw new Error(`convergence study refers to unknown case "${id}"`);
    return r;
  };
  console.log("\nConvergence studies");
  const convergence = studies.map((study) => ({
    id: study.id,
    caseId: study.caseId,
    title: study.title,
    series: study.series.map((s) => {
      const ref = caseRow(s.caseId);
      return {
        label: s.label,
        caseId: s.caseId,
        order: s.order,
        points: s.levels.map((level) => {
          const { value: fe, mesh } = solveOnce((sv) =>
            study.solve(sv, level, s.order),
          );
          const errPct = relErrPct(fe, ref.reference);
          const ci =
            mesh.order === ref.mesh.order &&
            mesh.elements === ref.mesh.elements &&
            mesh.vertices === ref.mesh.vertices;
          const label = study.meshLabel(level);
          console.log(
            `  ${study.id.padEnd(16)} ${s.label.padEnd(15)} ${label.padEnd(12)} ` +
              `${String(mesh.dofs).padStart(7)} DOFs  ${fmt(fe).padStart(11)}  ${fmtErr(errPct).padStart(7)}%` +
              (ci ? "  (case mesh)" : ""),
          );
          return { mesh: label, ...mesh, fe, errPct, ci };
        }),
      };
    }),
  }));
  for (const s of convergence)
    if (!s.series.some((series) => series.points.some((p) => p.ci)))
      throw new Error(
        `convergence study "${s.id}": no level matches the mesh its case is gated on — include it so the study connects to the published result`,
      );

  if (!existsSync(ENGINE_STAMP))
    throw new Error(
      `${rel(ENGINE_STAMP)} is missing, so the engine build behind these numbers is unknown. Install the engine with scripts/fetch-wasm-engine.sh (or build it) before --report.`,
    );
  const data = {
    generated: new Date().toISOString().slice(0, 10),
    engine: readFileSync(ENGINE_STAMP, "utf8").trim(),
    cases: rows,
    convergence,
    reproduce: app,
  };

  mkdirSync(dirname(DATA), { recursive: true });
  writeFileSync(DATA, JSON.stringify(data, null, 2) + "\n");
  mkdirSync(dirname(PAGE), { recursive: true });
  writeFileSync(PAGE, renderValidationPage(data, { cases, studies }));
  writeFileSync(REPORT, markdownReport(rows));
  console.log(`\nWrote ${rel(DATA)}, ${rel(PAGE)} and ${rel(REPORT)}`);
} else {
  const stale = checkPublished();
  if (stale.length) {
    console.error(
      `\n${rel(DATA)} is stale — the public page /validation/ shows numbers a fresh run no longer reproduces:\n` +
        stale.map((s) => `  • ${s}`).join("\n") +
        `\nRegenerate the page and commit the result:\n` +
        `  cd web && bun run validate:report\n` +
        `  git add web/validation/index.html web/public/validation/results.json examples/validation/REPORT.md`,
    );
    process.exit(1);
  }
  console.log(`\n${rel(DATA)} matches this run (/validation/ is current).`);
}

process.exit(failed ? 1 : 0);

// Differences between the committed page data and this run, as messages.
function checkPublished() {
  if (!existsSync(DATA)) return [`${rel(DATA)} does not exist`];
  const published = JSON.parse(readFileSync(DATA, "utf8"));
  const out = [];
  const ids = rows.map((r) => r.id).join(", ");
  const pubIds = published.cases.map((c) => c.id).join(", ");
  if (ids !== pubIds) return [`cases are [${ids}], the page lists [${pubIds}]`];
  const close = (a, b) =>
    Math.abs(a - b) <= PUBLISHED_RTOL * Math.max(Math.abs(a), Math.abs(b));
  rows.forEach((r, i) => {
    const p = published.cases[i];
    if (!close(r.fe, p.fe))
      out.push(`${r.name}: published ${fmt(p.fe)}, this run ${fmt(r.fe)}`);
    if (!close(r.reference, p.reference) || r.tolPct !== p.tolPct)
      out.push(
        `${r.name}: reference/tolerance changed (published ${fmt(p.reference)} ±${p.tolPct}%, now ${fmt(r.reference)} ±${r.tolPct}%)`,
      );
    if (JSON.stringify(r.mesh) !== JSON.stringify(p.mesh))
      out.push(
        `${r.name}: mesh changed (published ${JSON.stringify(p.mesh)}, now ${JSON.stringify(r.mesh)})`,
      );
  });
  if (app.appReadout !== published.reproduce.appReadout)
    out.push(
      `in-app reproduction: published "${published.reproduce.appReadout}", this run "${app.appReadout}"`,
    );
  return out;
}

function markdownReport(rs) {
  return [
    "# KoFEM validation results",
    "",
    "Each case is solved by the real MFEM WASM engine and compared against its",
    "closed-form or published reference. The same numbers, with the models,",
    "mesh-convergence studies and steps to reproduce them, are published at",
    "<https://kofem.org/validation/>. Regenerate both with:",
    "",
    "```bash",
    "node examples/validation/run.mjs --report",
    "```",
    "",
    "| Case | Quantity | FE result | Reference | Error | Tol | Status |",
    "| --- | --- | ---: | ---: | ---: | ---: | :---: |",
    ...rs.map(
      (r) =>
        `| ${r.name} | ${r.quantity} | ${fmt(r.fe)}${r.unit ? " " + r.unit : ""} | ${r.referenceLabel} | ${fmtErr(r.errPct)}% | ${r.tolPct}% | ${r.pass ? "✅" : "❌"} |`,
    ),
    "",
  ].join("\n");
}
