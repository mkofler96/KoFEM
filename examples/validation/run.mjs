// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Validation runner: builds every case from its recipe as a user builds it in
// the GUI — STEP import, splits, Netgen mesh, supports and loads on whole CAD
// faces, the app's own solve (lib/pipeline.mjs) — and checks the
// finite-element result against its closed-form / published reference.
//
// Run with bun from web/ (it imports the app's TypeScript), after
// `bun run wasm:prepare` (engine + Rust module):
//
//   bun run validate                  # run + print table + check pages
//   bun run validate --case <id>      # run one case (no page check)
//   bun run validate:report           # also regenerate REPORT.md, each case's
//                                     # analysis file, .step, .model.step and
//                                     # figure, and the pages /examples/ and
//                                     # /examples/<id>/
//   bun run validate:pages            # only re-render the pages and their
//                                     # diagram/chart files from the published
//                                     # results (no solve)
//
// Exits non-zero if any case falls outside its tolerance band, so CI fails on a
// solver regression — or if the numbers published on /examples/ no longer
// match a fresh run, or a page, analysis file or STEP file no longer matches
// its sources, so the public pages and the models the app opens cannot drift
// from the engine. See README.md for what each case validates.

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
import {
  CONSOLE_RULE,
  consoleHeader,
  consoleRow,
  fmt,
  fmtErr,
  relErrPct,
} from "./lib/format.mjs";
import {
  appReadout,
  buildAnalysisFile,
  buildMeshStats,
  buildResultSurface,
} from "./lib/app-model.mjs";
import { buildFromRecipe, nodalVonMises, withMesh } from "./lib/pipeline.mjs";
import {
  modelStepPath,
  sameModelStep,
  writeModelStep,
} from "./lib/model-step.mjs";
import { engineId, femModuleId } from "./lib/provenance.mjs";
import { resultFigure } from "./lib/render.mjs";
import { renderExamplePage, renderIndexPage } from "./lib/page.mjs";
import { ORDER, SITE_DIR, catalog } from "./catalog.mjs";
import {
  figureAssets,
  imageEntries,
  sameFile,
  withImageNamespace,
} from "../../web/figure-assets.mjs";
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
// Solved surfaces of the cases, for the Theory Guide's 3D viewers.
const SURFACE_DIR = join(here, "surfaces");

// A published FE value counts as current when a fresh run reproduces it to
// this relative tolerance — tighter than the page's five significant digits.
const PUBLISHED_RTOL = 1e-4;

const report = process.argv.includes("--report");

// Page text or figure changes need no new solve: render from the published
// results.json and stop.
if (process.argv.includes("--pages")) {
  if (report || process.argv.includes("--case"))
    throw new Error("--pages renders from published data; use it alone");
  const published = JSON.parse(readFileSync(DATA, "utf8"));
  const written = await publishPages(published);
  console.log(
    `Rendered ${written.pages} pages and ${written.figures} diagram/chart files from ${relative(repo, DATA)} (no solve).`,
  );
  process.exit(0);
}

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
const started = performance.now();
const runs = [];
for (const c of selected) runs.push(await runCase(c));
const rows = runs.map((r) => r.row);
const seconds = (performance.now() - started) / 1000;

// The published row of a case, from its FE value, solved mesh and result.
function caseRow(c, fe, mesh, result) {
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
    // What the app's Result summary shows after a fresh solve of the file.
    ...(c.readout
      ? {
          readout: {
            field: c.readout.field,
            stat: c.readout.stat,
            value: appReadout(result, c.readout.field, c.readout.stat),
          },
        }
      : {}),
  };
}

async function runCase(c) {
  const build = await buildFromRecipe(c.id, c.recipe);
  const row = caseRow(c, build.fe, buildMeshStats(build), build.result);
  return { c, build, row };
}

// One level of a convergence study: the case's recipe with only the mesher
// settings changed (`level` is the max element size, mm).
async function studyLevel(caseId, level, order) {
  const c = cases.find((x) => x.id === caseId);
  if (!c) throw new Error(`convergence study: unknown case "${caseId}"`);
  const build = await buildFromRecipe(
    caseId,
    withMesh(c.recipe, { maxElementSize: level, order }),
  );
  return { fe: build.fe, mesh: buildMeshStats(build) };
}

// The solved boundary of a case for the Theory Guide's 3D viewer
// (web/theory/viewers): its analysis file opens unsolved, so the viewer reads
// the solve from here: the surface vertices only, rounded as the viewer
// rounds them.
function solvedSurfaceJson(id, field, surface) {
  const round = (v, digits) => Number(v.toPrecision(digits));
  const index = new Map();
  const out = { id, field, positions: [], displacements: [], values: [] };
  const triangles = surface.triangles.map((v) => {
    if (!index.has(v)) {
      index.set(v, index.size);
      for (let k = 0; k < 3; k++) {
        out.positions.push(round(surface.positions[3 * v + k], 7));
        out.displacements.push(round(surface.displacements[3 * v + k], 5));
      }
      out.values.push(round(surface.scalars[v], 5));
    }
    return index.get(v);
  });
  return JSON.stringify({ ...out, triangles }) + "\n";
}
const failed = rows.filter((r) => !r.pass).length;

// ── Console table ─────────────────────────────────────────────────────────────
console.log("\nKoFEM validation suite — FE result vs. analytical reference\n");
console.log(consoleHeader());
console.log(CONSOLE_RULE);
for (const r of rows) console.log(consoleRow(r));
console.log(CONSOLE_RULE);
console.log(
  `${rows.length - failed}/${rows.length} passed` +
    (failed ? `  —  ${failed} FAILED` : "  —  all within tolerance") +
    `  (${seconds.toFixed(1)} s)`,
);

const rel = (p) => relative(repo, p);
const vtuPath = (id) => join(SITE_DIR, `${id}.vtu`);
const pngPath = (id) => join(SITE_DIR, `${id}.png`);
const stepPath = (id) => join(SITE_DIR, `${id}.step`);
const surfacePath = (id) => join(SURFACE_DIR, `${id}.json`);

if (only) process.exit(failed ? 1 : 0);

if (report) {
  // ── Analysis files, STEP files, figures, solved surfaces ───────────────────
  mkdirSync(SURFACE_DIR, { recursive: true });
  for (const run of runs) {
    const { c, row } = run;
    const fig = c.figure ?? {};
    const field = fig.field ?? "displacement";
    writeFileSync(vtuPath(c.id), buildAnalysisFile(run.build, c.name));
    writeFileSync(stepPath(c.id), run.build.stepText);
    writeModelStep(modelStepPath(SITE_DIR, c.id), run.build.stepBytes);
    const surface = buildResultSurface(
      run.build,
      field,
      field === "vonMises" ? nodalVonMises(run.build) : null,
    );
    writeFileSync(surfacePath(c.id), solvedSurfaceJson(c.id, field, surface));
    const { png, meta } = resultFigure(surface, {
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
  const rowOf = (id) => {
    const r = byId.get(id);
    if (!r) throw new Error(`convergence study refers to unknown case "${id}"`);
    return r;
  };
  console.log("\nConvergence studies");
  const convergence = [];
  for (const study of studies) {
    const series = [];
    for (const s of study.series) {
      const ref = rowOf(s.caseId);
      const points = [];
      for (const level of s.levels) {
        const { fe, mesh } = await studyLevel(s.caseId, level, s.order);
        const errPct = relErrPct(fe, ref.reference);
        const ci =
          mesh.order === ref.mesh.order &&
          mesh.elements === ref.mesh.elements &&
          mesh.vertices === ref.mesh.vertices;
        const label = `${level} mm`;
        console.log(
          `  ${study.id.padEnd(16)} ${s.label.padEnd(15)} ${label.padEnd(12)} ` +
            `${String(mesh.dofs).padStart(7)} DOFs  ${fmt(fe).padStart(11)}  ${fmtErr(errPct).padStart(7)}%` +
            (ci ? "  (case mesh)" : ""),
        );
        points.push({ mesh: label, ...mesh, fe, errPct, ci });
      }
      series.push({ label: s.label, caseId: s.caseId, order: s.order, points });
    }
    convergence.push({
      id: study.id,
      caseId: study.caseId,
      title: study.title,
      series,
    });
  }
  for (const s of convergence)
    if (!s.series.some((series) => series.points.some((p) => p.ci)))
      throw new Error(
        `convergence study "${s.id}": no level matches the mesh its case is gated on — include it so the study connects to the published result`,
      );

  // The builds behind these numbers (lib/provenance.mjs): the C++ engine
  // meshes every case; the Rust module solves it. Like the engine id, the module id is a record, not part of
  // the staleness check (the pages render it from this file): a rebuilt
  // module that reproduces the published numbers leaves the pages current.
  const data = {
    generated: new Date().toISOString().slice(0, 10),
    engine: engineId(),
    fem: femModuleId(),
    cases: rows,
    convergence,
  };

  mkdirSync(dirname(DATA), { recursive: true });
  writeFileSync(DATA, JSON.stringify(data, null, 2) + "\n");
  const written = await publishPages(data);
  writeFileSync(REPORT, markdownReport(rows));
  console.log(
    `\nWrote ${rel(DATA)}, ${written.pages} pages in ${rel(PAGES)}, ${rows.length} analysis files and figures and ${written.figures} diagram/chart files in ${rel(SITE_DIR)}, ${rel(SITEMAP)} and ${rel(REPORT)}`,
  );
} else {
  const stale = await checkPublished();
  if (stale.length) {
    console.error(
      `\nThe example pages /examples/ are out of date with this run or their sources:\n` +
        stale.map((s) => `  • ${s}`).join("\n") +
        `\nRegenerate the pages and commit the result:\n` +
        `  cd web && bun run validate:report   (validate:pages if only page text or figures changed)\n` +
        `  git add web/examples web/public/examples/results.json web/public/sitemap.xml examples/gallery/site examples/gallery/showcase examples/validation/surfaces examples/validation/REPORT.md`,
    );
    process.exit(1);
  }
  console.log(
    `\n${rel(DATA)} matches this run, and the pages and analysis files match their sources (/examples/ is current).`,
  );
}

process.exit(failed ? 1 : 0);

/**
 * Every page, as [file, html], rendered from published data, and the figure
 * assets the pages show (web/figure-assets.mjs).
 */
function renderPages(data) {
  const entries = catalog(data.cases);
  const assets = figureAssets({ dir: SITE_DIR, url: "/examples/" });
  const pages = [
    [INDEX, renderIndexPage(data, entries)],
    ...entries.map((e) => [
      join(PAGES, e.id, "index.html"),
      renderExamplePage(data, entries, { studies, textbook, assets }, e.id),
    ]),
  ];
  return { pages, assets };
}

/**
 * Write the pages, their diagram/chart files (site/<id>/, which holds nothing
 * else, so a renamed figure leaves no stale file) and the sitemap block.
 */
async function publishPages(data) {
  const { pages, assets } = renderPages(data);
  for (const id of ORDER)
    rmSync(join(SITE_DIR, id), { recursive: true, force: true });
  const figureFiles = await assets.files();
  for (const [file, content] of figureFiles) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  // One page per example; an example that no longer exists loses its page.
  mkdirSync(PAGES, { recursive: true });
  for (const entry of readdirSync(PAGES, { withFileTypes: true }))
    if (entry.isDirectory() && !ORDER.includes(entry.name))
      rmSync(join(PAGES, entry.name), { recursive: true });
  for (const [file, html] of pages) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, html);
  }
  writeFileSync(
    SITEMAP,
    sitemapWithExamples(readFileSync(SITEMAP, "utf8"), assets),
  );
  return { pages: pages.length, figures: figureFiles.length };
}

// Differences between the committed data, pages and analysis files and this
// run, as messages.
async function checkPublished() {
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
    if (JSON.stringify(r.readout) !== JSON.stringify(p.readout))
      out.push(
        r.readout
          ? `${r.name}: the app shows ${r.readout.stat} ${r.readout.field} ${r.readout.value}, the page says ${p.readout?.value}`
          : `${r.name}: the page states a Result-summary line the case no longer has`,
      );
  });
  // The model the app opens must be the model this run solved.
  for (const run of runs) {
    const { c } = run;
    const file = vtuPath(c.id);
    if (!existsSync(file)) {
      out.push(`${rel(file)} does not exist`);
      continue;
    }
    // Netgen is deterministic within one engine build, so the file this run
    // would write is byte for byte the committed one.
    const same = (path, text) =>
      existsSync(path) && readFileSync(path, "utf8") === text;
    if (!same(file, buildAnalysisFile(run.build, c.name)))
      out.push(`${rel(file)}: its model differs from case "${c.id}"`);
    if (!same(stepPath(c.id), run.build.stepText))
      out.push(`${rel(stepPath(c.id))} differs from case "${c.id}"'s STEP`);
    // The geometry the app re-meshes from must be the one the .vtu's CAD
    // face ids refer to: the import after the splits (lib/model-step.mjs).
    const model = modelStepPath(SITE_DIR, c.id);
    if (!sameModelStep(model, run.build.stepBytes))
      out.push(
        `${rel(model)} differs from case "${c.id}"'s geometry after its splits`,
      );
    const fig = c.figure ?? {};
    const field = fig.field ?? "displacement";
    const surface = buildResultSurface(
      run.build,
      field,
      field === "vonMises" ? nodalVonMises(run.build) : null,
    );
    if (!same(surfacePath(c.id), solvedSurfaceJson(c.id, field, surface)))
      out.push(`${rel(surfacePath(c.id))} differs from this run's solve`);
  }
  // A solved surface no case writes is left over from one.
  if (existsSync(SURFACE_DIR))
    for (const name of readdirSync(SURFACE_DIR))
      if (!runs.some((run) => `${run.c.id}.json` === name))
        out.push(`${rel(join(SURFACE_DIR, name))} belongs to no case`);
  for (const id of ORDER)
    if (!existsSync(pngPath(id)))
      out.push(`${rel(pngPath(id))} does not exist`);
  // The committed HTML must be what the current sources render from the
  // committed data, so a text or layout change cannot ship without the pages.
  const { pages, assets } = renderPages(published);
  for (const [file, html] of pages)
    if (!existsSync(file) || readFileSync(file, "utf8") !== html)
      out.push(`${rel(file)} differs from what the page sources render`);
  // The diagram and chart files must be what the figure sources render, and
  // nothing else may sit beside them.
  const expected = new Set();
  for (const [file, content] of await assets.files()) {
    expected.add(file);
    if (!sameFile(file, content))
      out.push(`${rel(file)} differs from what the figure sources render`);
  }
  for (const id of ORDER) {
    const folder = join(SITE_DIR, id);
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder))
      if (!expected.has(join(folder, name)))
        out.push(`${rel(join(folder, name))} is no longer a figure of a page`);
  }
  if (
    readFileSync(SITEMAP, "utf8") !==
    sitemapWithExamples(readFileSync(SITEMAP, "utf8"), assets)
  )
    out.push(`${rel(SITEMAP)} does not list the current pages and images`);
  return out;
}

// The sitemap's examples block (between the examples markers) lists the index
// and every example page, with the page's result figure and the PNGs of its
// diagrams and charts as images.
function sitemapWithExamples(sitemap, assets) {
  const xml = withImageNamespace(sitemap);
  const start = "<!-- examples:start -->",
    end = "<!-- examples:end -->";
  const i = xml.indexOf(start),
    j = xml.indexOf(end);
  if (i < 0 || j < i)
    throw new Error(`${rel(SITEMAP)} has no ${start} … ${end} block`);
  const url = (path, priority, images = []) =>
    `  <url>\n    <loc>${SITE}${path}</loc>\n    <priority>${priority}</priority>${images.length ? `\n    ${imageEntries(images.map((image) => `${SITE}${image}`))}` : ""}\n  </url>`;
  const block = [
    start,
    url("/examples/", "0.8"),
    ...ORDER.map((id) =>
      url(`/examples/${id}/`, "0.6", [
        `/examples/${id}.png`,
        ...assets.images(id),
      ]),
    ),
    `  ${end}`,
  ].join("\n");
  return xml.slice(0, i) + block + xml.slice(j + end.length);
}

function markdownReport(rs) {
  return [
    "# KoFEM validation results",
    "",
    "Each case is built as a user builds it in the app — a STEP file meshed by",
    "Netgen, supports and loads on whole CAD faces, solved by the app's own code",
    "and the real WASM engine — and compared against its closed-form or published",
    "reference. The same numbers are published at <https://kofem.org/examples/>,",
    "with one page per example (derivation, model, mesh convergence, discussion,",
    "how to reproduce). Regenerate them with:",
    "",
    "```bash",
    "cd web && bun run validate:report",
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
