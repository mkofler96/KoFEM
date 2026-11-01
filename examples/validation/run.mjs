// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Validation runner: solves every case through the real WASM engine, with the
// loads built as the app builds them, and checks the finite-element result
// against its closed-form / published reference.
//
//   node examples/validation/run.mjs              # run + print table + check pages
//   node examples/validation/run.mjs --case <id>  # run one case (no page check)
//   node examples/validation/run.mjs --report     # also regenerate REPORT.md,
//                                                 # each case's analysis file and
//                                                 # figure, and the pages
//                                                 # /examples/ and /examples/<id>/
//
// Exits non-zero if any case falls outside its tolerance band, so CI fails on a
// solver regression — or if the numbers published on /examples/ no longer
// match a fresh run, or a page or analysis file no longer matches its sources,
// so the public pages and the models the app opens cannot drift from the
// engine. See README.md for what each case validates.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import {
  analysisFile,
  analysisSetup,
  appReadout,
  readAnalysisSetup,
  resultSurface,
  solveModel,
} from "./lib/app-model.mjs";
import { resultFigure } from "./lib/render.mjs";
import { renderExamplePage, renderIndexPage } from "./lib/page.mjs";
import { ORDER, SITE_DIR, catalog } from "./catalog.mjs";
import cases from "./cases/index.mjs";
import textbook from "./textbook/index.mjs";
import studies from "./convergence.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
const PAGES = join(repo, "web/examples");
const INDEX = join(PAGES, "index.html");
const SITEMAP = join(repo, "web/public/sitemap.xml");
const SITE = "https://kofem.org";
const DATA = join(repo, "web/public/examples/results.json");
const REPORT = join(here, "REPORT.md");
const ENGINE_STAMP = join(repo, "web/src/wasm/pkg/.engine-id");

// A published FE value counts as current when a fresh run reproduces it to
// this relative tolerance — tighter than the page's five significant digits.
const PUBLISHED_RTOL = 1e-4;

const report = process.argv.includes("--report");
const caseFlag = process.argv.indexOf("--case");
const only = caseFlag >= 0 ? process.argv[caseFlag + 1] : null;
if (caseFlag >= 0 && !only)
  throw new Error("--case needs a case id, e.g. --case axial-bar");
if (only && report)
  throw new Error("--report regenerates every page; run it without --case");
const selected = only ? cases.filter((c) => c.id === only) : cases;
if (!selected.length)
  throw new Error(
    `unknown case "${only}"; cases: ${cases.map((c) => c.id).join(", ")}`,
  );
const solve = await loadSolver();

const runs = selected.map((c) => {
  const model = c.model();
  const result = solveModel(solve, model);
  const fe = c.measure(model, result);
  const errPct = relErrPct(fe, c.reference);
  const row = {
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
    mesh: meshStats(model.mesh, model.order),
    inputs: c.page.inputs.map(([symbol, value, unit]) => ({
      symbol,
      value,
      unit,
    })),
    // What the app's Result summary shows after a fresh solve of the file.
    readout: {
      field: c.readout.field,
      stat: c.readout.stat,
      value: appReadout(result, c.readout.field, c.readout.stat),
    },
  };
  return { c, model, result, row };
});
const rows = runs.map((r) => r.row);
const failed = rows.filter((r) => !r.pass).length;

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
const vtuPath = (id) => join(SITE_DIR, `${id}.vtu`);
const pngPath = (id) => join(SITE_DIR, `${id}.png`);

if (only) process.exit(failed ? 1 : 0);

if (report) {
  // ── Analysis files and figures ──────────────────────────────────────────────
  for (const { c, model, result, row } of runs) {
    writeFileSync(vtuPath(c.id), analysisFile(model, result));
    const fig = c.figure ?? {};
    const field = fig.field ?? "displacement";
    const { png, meta } = resultFigure(resultSurface(model, result, field), {
      field,
      unit: fig.unit ?? (field === "vonMises" ? "MPa" : "mm"),
      view: fig.view,
      deform: fig.deform,
      focus: fig.focus,
    });
    writeFileSync(pngPath(c.id), png);
    row.figure = meta;
  }

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
          // Record the mesh the study solves, so the page states its size.
          let mesh = null;
          const fe = study.solve(
            (m, mat, bcs, order) => {
              if (mesh) throw new Error("a study level must solve once");
              mesh = meshStats(m, order);
              return solve(m, mat, bcs, order);
            },
            level,
            s.order,
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
  };

  mkdirSync(dirname(DATA), { recursive: true });
  writeFileSync(DATA, JSON.stringify(data, null, 2) + "\n");
  const pages = renderPages(data);
  // One page per example; an example that no longer exists loses its page.
  mkdirSync(PAGES, { recursive: true });
  for (const entry of readdirSync(PAGES, { withFileTypes: true }))
    if (entry.isDirectory() && !ORDER.includes(entry.name))
      rmSync(join(PAGES, entry.name), { recursive: true });
  for (const [file, html] of pages) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, html);
  }
  writeFileSync(SITEMAP, sitemapWithExamples(readFileSync(SITEMAP, "utf8")));
  writeFileSync(REPORT, markdownReport(rows));
  console.log(
    `\nWrote ${rel(DATA)}, ${pages.length} pages in ${rel(PAGES)}, ${rows.length} analysis files and figures in ${rel(SITE_DIR)}, ${rel(SITEMAP)} and ${rel(REPORT)}`,
  );
} else {
  const stale = checkPublished();
  if (stale.length) {
    console.error(
      `\nThe example pages /examples/ are out of date with this run or their sources:\n` +
        stale.map((s) => `  • ${s}`).join("\n") +
        `\nRegenerate the pages and commit the result:\n` +
        `  cd web && bun run validate:report\n` +
        `  git add web/examples web/public/examples/results.json web/public/sitemap.xml examples/gallery/site examples/gallery/showcase examples/validation/REPORT.md`,
    );
    process.exit(1);
  }
  console.log(
    `\n${rel(DATA)} matches this run, and the pages and analysis files match their sources (/examples/ is current).`,
  );
}

process.exit(failed ? 1 : 0);

/** Every page, as [file, html], rendered from published data. */
function renderPages(data) {
  const entries = catalog(data.cases);
  return [
    [INDEX, renderIndexPage(data, entries)],
    ...entries.map((e) => [
      join(PAGES, e.id, "index.html"),
      renderExamplePage(data, entries, { studies, textbook }, e.id),
    ]),
  ];
}

// Differences between the committed data, pages and analysis files and this
// run, as messages.
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
    if (JSON.stringify(r.inputs) !== JSON.stringify(p.inputs))
      out.push(`${r.name}: inputs changed`);
    if (r.readout.value !== p.readout.value)
      out.push(
        `${r.name}: the app shows ${r.readout.stat} ${r.readout.field} ${r.readout.value}, the page says ${p.readout.value}`,
      );
  });
  // The model the app opens must be the model this run solved.
  for (const { c, model } of runs) {
    const file = vtuPath(c.id);
    if (!existsSync(file)) {
      out.push(`${rel(file)} does not exist`);
      continue;
    }
    if (
      JSON.stringify(readAnalysisSetup(readFileSync(file, "utf8"))) !==
      JSON.stringify(analysisSetup(model))
    )
      out.push(`${rel(file)}: its model differs from case "${c.id}"`);
  }
  for (const id of ORDER)
    if (!existsSync(pngPath(id)))
      out.push(`${rel(pngPath(id))} does not exist`);
  // The committed HTML must be what the current sources render from the
  // committed data, so a text or layout change cannot ship without the pages.
  for (const [file, html] of renderPages(published))
    if (!existsSync(file) || readFileSync(file, "utf8") !== html)
      out.push(`${rel(file)} differs from what the page sources render`);
  return out;
}

// The sitemap's examples block (between the examples markers) lists the index
// and every example page.
function sitemapWithExamples(xml) {
  const start = "<!-- examples:start -->",
    end = "<!-- examples:end -->";
  const i = xml.indexOf(start),
    j = xml.indexOf(end);
  if (i < 0 || j < i)
    throw new Error(`${rel(SITEMAP)} has no ${start} … ${end} block`);
  const url = (path, priority) =>
    `  <url>\n    <loc>${SITE}${path}</loc>\n    <priority>${priority}</priority>\n  </url>`;
  const block = [
    start,
    url("/examples/", "0.8"),
    ...ORDER.map((id) => url(`/examples/${id}/`, "0.6")),
    `  ${end}`,
  ].join("\n");
  return xml.slice(0, i) + block + xml.slice(j + end.length);
}

function markdownReport(rs) {
  return [
    "# KoFEM validation results",
    "",
    "Each case is solved by the real MFEM WASM engine, with its loads applied as",
    "the app applies them, and compared against its closed-form or published",
    "reference. The same numbers are published at <https://kofem.org/examples/>,",
    "with one page per example (derivation, model, mesh convergence, discussion,",
    "how to reproduce). Regenerate them with:",
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
