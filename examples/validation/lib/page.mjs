// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Renders the public example pages (run.mjs --report, and re-rendered by every
// plain run to check the committed HTML):
//
//   web/examples/index.html          /examples/       every example, results
//   web/examples/<id>/index.html     /examples/<id>/  one page per example
//
// An entry (../catalog.mjs) is a validation case with its published row from
// web/public/examples/results.json, or a showcase with the record its own
// generator wrote. Every number comes from those; every text from the case's
// `page` block and ../textbook/. Static and crawlable (the only script is the
// light/dark theme switch); equations are MathML (./tex.mjs), the result
// figure a PNG (./render.mjs). Header,
// footer and palette are the public site's (web/site-layout.mjs,
// web/public/site.css); article typography is web/public/case-page.css.

import { consoleHeader, consoleRow, fmt } from "./format.mjs";
import { tex, texBlock } from "./tex.mjs";
import { siteFooter, siteHeader } from "../../../web/site-layout.mjs";

import { renderDocsPage as layout } from "../../../web/docs-layout.mjs";

const SITE = "https://kofem.org";
const REPO = "https://github.com/mkofler96/KoFEM";
const MINUS = "−";

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const minus = (s) => s.replace(/^-/, MINUS);

/** Five significant digits as HTML — the digits run.mjs prints, typeset. */
function num(x) {
  const s = fmt(x);
  const m = /^(-?[\d.]+)e([+-]\d+)$/.exec(s);
  if (!m) return minus(s);
  return `${minus(m[1])}&thinsp;×&thinsp;10<sup>${minus(String(Number(m[2])))}</sup>`;
}

/**
 * The same five digits as TeX, for numbers inside equations; trailing zeros
 * of plain numbers are dropped (0.01, not 0.010000).
 */
function numTex(x) {
  const s = fmt(x);
  const m = /^(-?[\d.]+)e([+-]\d+)$/.exec(s);
  return m ? `${m[1]} \\times 10^{${Number(m[2])}}` : String(Number(s));
}

const withUnit = (html, unit) => (unit ? `${html}&nbsp;${esc(unit)}` : html);

const trim = (x) => minus(String(Number(x.toPrecision(6))));

// Larger units an input reads better in: 210 000 MPa is 210 GPa.
const PREFIXED = {
  MPa: [[1e3, "GPa"]],
  N: [
    [1e6, "MN"],
    [1e3, "kN"],
  ],
  "N·mm": [
    [1e6, "kN·m"],
    [1e3, "N·m"],
  ],
};

/** An input value in the unit that reads best (210 GPa, 10 kN, 1 kN·m). */
function inputValue(value, unit) {
  if (typeof value === "string") return withUnit(esc(value), unit);
  for (const [f, u] of PREFIXED[unit] ?? [])
    if (Math.abs(value) >= f) return `${trim(value / f)}&nbsp;${esc(u)}`;
  return withUnit(trim(value), unit);
}

const errHtml = (e) =>
  `${e > 0 ? "+" : e < 0 ? MINUS : ""}${Math.abs(e).toFixed(2)}&nbsp;%`;

const int = (n) => n.toLocaleString("en-US");

const pageUrl = (id) => `/examples/${id}/`;

const bandText = (r) =>
  `<span class="band ${r.pass ? "pass" : "fail"}">${r.pass ? "within" : "outside"} ±${r.tolPct}&nbsp;%</span>`;

const openButton = (id) =>
  `<a class="button" href="/app/?example=${encodeURIComponent(id)}" data-testid="open-in-app">Open in KoFEM</a>`;

// ── Page chrome ───────────────────────────────────────────────────────────────

// ── Sections and navigation ───────────────────────────────────────────────────

// Validation: a known answer to compare with. Examples: no known solution.
const SECTIONS = [
  { id: "validation", name: "Validation" },
  { id: "examples", name: "Examples" },
];

const sectionOf = (e) =>
  e.reference !== undefined ? "validation" : "examples";

/** The entries in contents order: every validation page, then the examples. */
export function contentsOrder(entries) {
  return SECTIONS.flatMap((sec) =>
    entries.filter((e) => sectionOf(e) === sec.id),
  );
}

const current = (yes) => (yes ? ' aria-current="page"' : "");

/**
 * The contents: the overview, then one collapsible group per section. Only
 * the section of the current page starts open; the others show their heading,
 * and open with a click (no script needed).
 */
function contentsList(entries, currentId) {
  const currentSection = currentId
    ? sectionOf(entries.find((e) => e.id === currentId))
    : null;
  return `<ul>
          <li><a href="/examples/"${current(currentId === null)}>Overview</a></li>
        </ul>${SECTIONS.map(
          (sec) => `
        <details class="docs-group" data-section="${sec.id}"${sec.id === currentSection ? " open" : ""}>
          <summary>${sec.name}</summary>
          <ul>${entries
            .filter((e) => sectionOf(e) === sec.id)
            .map(
              (e) => `
            <li><a href="${pageUrl(e.id)}"${current(e.id === currentId)}>${esc(e.name)}</a></li>`,
            )
            .join("")}
          </ul>
        </details>`,
        ).join("")}`;
}

/**
 * The page's frame: the site header, the contents (a sidebar, or a menu on
 * small screens), the page and its own sections, the site footer.
 */
function docsBody({ entries, currentId, sections, body }) {
  const list = contentsList(entries, currentId);
  const toc = sections.length
    ? `
      <nav class="docs-toc" aria-label="On this page">
        <p>On this page</p>
        <ul>${sections.map(([id, name]) => `\n          <li><a href="#${id}">${esc(name)}</a></li>`).join("")}
        </ul>
      </nav>`
    : "";
  return `${siteHeader("examples", { themeSwitch: true })}
    <div class="docs">
      <nav class="docs-nav" aria-label="Examples and validation">
        ${list}
      </nav>
      <main>
      <details class="docs-menu">
        <summary>Contents</summary>
        <div>
        ${list}
        <button type="button" class="theme-toggle" hidden>Dark theme</button>
        </div>
      </details>${body}
      </main>${toc}
    </div>
    ${siteFooter()}`;
}

const breadcrumbs = (items) => ({
  "@type": "BreadcrumbList",
  itemListElement: items.map(([name, path], i) => ({
    "@type": "ListItem",
    position: i + 1,
    name,
    item: `${SITE}${path}`,
  })),
});

const DISCLAIMER = `<p class="note" data-testid="disclaimer">
        KoFEM is research software and is not certified for safety-critical
        design. It solves linear-static, linear-elastic problems. Check results
        that matter against your own references.
      </p>`;

// ── The result figure ─────────────────────────────────────────────────────────

const FIELD_NAMES = {
  displacement: "Displacement magnitude |U|",
  vonMises: "Von Mises stress",
  density: "Element density",
};

const imagePath = (id) => `/examples/${id}.png`;

function fieldRange(fig) {
  const v = (x) => withUnit(minus(x.toPrecision(3)), fig.unit);
  return `<span>${v(fig.min)}</span><span class="bar" aria-hidden="true"></span><span>${v(fig.max)}</span>`;
}

function resultFigure(e) {
  const fig = e.figure;
  const name = FIELD_NAMES[fig.field];
  if (!name)
    throw new Error(`${e.id}: no name for figure field "${fig.field}"`);
  const shape =
    fig.deform > 0
      ? `deformed shape, displacements drawn ${int(fig.deform)} times enlarged`
      : "undeformed shape";
  return `
      <figure class="result">
        <img src="${imagePath(e.id)}" width="${fig.width}" height="${fig.height}" alt="${esc(`${e.name}: ${name.toLowerCase()} on the ${shape}`)}" />
        <div class="colorbar">${fieldRange(fig)}</div>
        <figcaption>${esc(name)}, ${esc(shape)}. The result of running the model that Open in KoFEM loads.</figcaption>
      </figure>`;
}

// ── Results ───────────────────────────────────────────────────────────────────

const hasReference = (e) => e.reference !== undefined;

/** The one-row table under the figure: reference, KoFEM, difference. */
function keyResult(e) {
  if (!hasReference(e)) return "";
  return `
      <div class="table-wrap">
        <table class="key-result" data-entry="${e.id}">
          <caption>${esc(capitalise(e.quantity))}; reference ${esc(e.referenceLabel)}</caption>
          <thead>
            <tr>
              <th scope="col" class="num">Reference</th>
              <th scope="col" class="num">KoFEM</th>
              <th scope="col" class="num">Difference</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="num">${withUnit(num(e.reference), e.unit)}</td>
              <td class="num"><strong data-testid="fe-value">${withUnit(num(e.fe), e.unit)}</strong></td>
              <td class="num">${errHtml(e.errPct)}${e.tolPct === undefined ? "" : `<br />${bandText(e)}`}</td>
            </tr>
          </tbody>
        </table>
      </div>`;
}

const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function resultsTable(entries) {
  const body = entries
    .filter(hasReference)
    .map(
      (e) => `
            <tr>
              <th scope="row"><a href="${pageUrl(e.id)}">${esc(e.name)}</a></th>
              <td class="wide">${esc(e.quantity)}</td>
              <td class="num" data-label="Reference">${withUnit(num(e.reference), e.unit)}</td>
              <td class="num" data-label="KoFEM">${withUnit(num(e.fe), e.unit)}</td>
              <td class="num" data-label="Difference">${errHtml(e.errPct)}</td>
            </tr>`,
    )
    .join("");
  return `
      <div class="table-wrap">
        <table class="results">
          <thead>
            <tr>
              <th scope="col">Example</th>
              <th scope="col" class="wide">Quantity</th>
              <th scope="col" class="num">Reference</th>
              <th scope="col" class="num">KoFEM</th>
              <th scope="col" class="num">Difference</th>
            </tr>
          </thead>
          <tbody>${body}
          </tbody>
        </table>
      </div>`;
}

// ── Convergence chart (inline SVG, log–log) ──────────────────────────────────

const W = 440,
  H = 250,
  PAD = { l: 44, r: 16, t: 24, b: 38 };

function decadeRange(values) {
  const lo = Math.floor(Math.log10(Math.min(...values)));
  const hi = Math.ceil(Math.log10(Math.max(...values)));
  return [lo, hi === lo ? hi + 1 : hi];
}

const kTick = (e) =>
  e >= 6 ? `${10 ** (e - 6)}M` : e >= 3 ? `${10 ** (e - 3)}k` : `${10 ** e}`;
const pctTick = (e) => (e < 0 ? (10 ** e).toFixed(-e) : String(10 ** e));

function chart(study, tolPct) {
  const points = study.series.flatMap((s) => s.points);
  for (const p of points)
    if (Math.abs(p.errPct) < 1e-9)
      throw new Error(
        `study "${study.id}": an exact result (0 % error) cannot be placed on the log error axis`,
      );
  const [x0, x1] = decadeRange(points.map((p) => p.dofs));
  const [y0, y1] = decadeRange([
    ...points.map((p) => Math.abs(p.errPct)),
    tolPct,
  ]);
  const pw = W - PAD.l - PAD.r,
    ph = H - PAD.t - PAD.b;
  const X = (v) => PAD.l + ((Math.log10(v) - x0) / (x1 - x0)) * pw;
  const Y = (v) => PAD.t + ((y1 - Math.log10(v)) / (y1 - y0)) * ph;
  const f = (v) => v.toFixed(1);

  const grid = [];
  for (let e = x0; e <= x1; e++)
    grid.push(
      `<line class="grid" x1="${f(X(10 ** e))}" x2="${f(X(10 ** e))}" y1="${PAD.t}" y2="${PAD.t + ph}"/>`,
      `<text class="tick" x="${f(X(10 ** e))}" y="${PAD.t + ph + 15}" text-anchor="middle">${kTick(e)}</text>`,
    );
  for (let e = y0; e <= y1; e++)
    grid.push(
      `<line class="grid" x1="${PAD.l}" x2="${PAD.l + pw}" y1="${f(Y(10 ** e))}" y2="${f(Y(10 ** e))}"/>`,
      `<text class="tick" x="${PAD.l - 6}" y="${f(Y(10 ** e) + 3.5)}" text-anchor="end">${pctTick(e)}</text>`,
    );

  const tolY = f(Y(tolPct));
  const tol = `<line class="tol" x1="${PAD.l}" x2="${PAD.l + pw}" y1="${tolY}" y2="${tolY}"/><text class="tol-label" x="${PAD.l + pw - 4}" y="${f(Y(tolPct) - 5)}" text-anchor="end">tolerance ±${tolPct} %</text>`;

  const series = study.series
    .map((s, i) => {
      const path = s.points
        .map(
          (p, k) =>
            `${k ? "L" : "M"}${f(X(p.dofs))} ${f(Y(Math.abs(p.errPct)))}`,
        )
        .join(" ");
      const marks = s.points
        .map((p) => {
          const under = p.errPct < 0;
          const tip = `${s.label}, ${p.mesh}: ${int(p.dofs)} DOFs, difference ${p.errPct > 0 ? "+" : MINUS}${Math.abs(p.errPct).toFixed(2)} %${p.ci ? " (the example's mesh)" : ""}`;
          const cx = f(X(p.dofs)),
            cy = f(Y(Math.abs(p.errPct)));
          const ci = p.ci
            ? `<circle class="ci-ring" cx="${cx}" cy="${cy}" r="9"/>`
            : "";
          return `<g><title>${esc(tip)}</title><circle class="hit" cx="${cx}" cy="${cy}" r="10"/><circle class="mark s${i + 1}${under ? " under" : " over"}" cx="${cx}" cy="${cy}" r="4.5"/>${ci}</g>`;
        })
        .join("");
      return `<path class="line s${i + 1}" d="${path}"/>${marks}`;
    })
    .join("");

  return `<svg class="conv" viewBox="0 0 ${W} ${H}" data-name="mesh-convergence" role="img" aria-label="${esc(`${study.title}: difference from the reference against degrees of freedom, logarithmic axes`)}">
            <text class="axis-title" x="${PAD.l}" y="${PAD.t - 11}">|difference| %</text>
            ${grid.join("\n            ")}
            <line class="axis" x1="${PAD.l}" x2="${PAD.l + pw}" y1="${PAD.t + ph}" y2="${PAD.t + ph}"/>
            <line class="axis" x1="${PAD.l}" x2="${PAD.l}" y1="${PAD.t}" y2="${PAD.t + ph}"/>
            ${tol}
            ${series}
            <text class="axis-title" x="${PAD.l + pw}" y="${H - 5}" text-anchor="end">degrees of freedom</text>
          </svg>`;
}

function convergenceSection(study, def, row) {
  const legend = study.series
    .map(
      (s, i) =>
        `<span class="key"><span class="swatch s${i + 1}"></span>${esc(s.label)}</span>`,
    )
    .join("");
  const rows = study.series
    .flatMap((s) =>
      s.points.map(
        (p) => `
                <tr>
                  <td>${esc(s.label)}</td>
                  <td>${esc(p.mesh)}${p.ci ? " (this example)" : ""}</td>
                  <td class="num">${int(p.dofs)}</td>
                  <td class="num">${withUnit(num(p.fe), row.unit)}</td>
                  <td class="num">${errHtml(p.errPct)}</td>
                </tr>`,
      ),
    )
    .join("");
  return `
      <section class="study" id="convergence" data-study="${study.id}">
        <h3>Mesh convergence: ${esc(study.title)}</h3>
        <figure class="chart">
          <div class="legend">${legend}<span class="key"><span class="dot under"></span>below the reference</span><span class="key"><span class="dot over"></span>above</span></div>
          ${chart(study, row.tolPct)}
          <figcaption>Difference from the reference on refined meshes, logarithmic axes. The ringed point is this example's mesh.</figcaption>
        </figure>
        <p>${esc(def.note)}</p>
        <details>
          <summary>Data</summary>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Order</th>
                  <th scope="col">Mesh</th>
                  <th scope="col" class="num">DOFs</th>
                  <th scope="col" class="num">KoFEM</th>
                  <th scope="col" class="num">Difference</th>
                </tr>
              </thead>
              <tbody>${rows}
              </tbody>
            </table>
          </div>
        </details>
      </section>`;
}

// ── Reproduction ──────────────────────────────────────────────────────────────

const cloneSteps = (
  command,
) => `<pre><code>git clone ${REPO}.git &amp;&amp; cd KoFEM
bash scripts/fetch-wasm-engine.sh
${command}</code></pre>`;

/** Open in KoFEM, solve, read the Result summary: what the app shows. */
function inApp(e) {
  if (!e.readout)
    return `<p>In the app: <a href="/app/?example=${encodeURIComponent(e.id)}" data-testid="reproduce-open">open the model</a>, with its supports, loads and settings.</p>`;
  const { field, stat, value } = e.readout;
  const plotField = field === "|U|" ? "Displacement (magnitude)" : field;
  return `<p>
        In the app: <a href="/app/?example=${encodeURIComponent(e.id)}" data-testid="reproduce-open">open the model</a>,
        then Studies → Static 1 → Run static solve, select the result plot and set Field to
        ${esc(plotField)}. The Result summary shows
        <span class="readout" data-testid="app-readout" data-field="${esc(plotField)}" data-stat="${esc(`${stat} ${field}`)}" data-value="${esc(value)}">${esc(`${stat} ${field}`)} ${esc(value)}</span>.
      </p>`;
}

const DOF_NAMES = ["Ux", "Uy", "Uz", "Rx", "Ry", "Rz"];
const AXES = ["x", "y", "z"];

/** A recipe's optimization study, as the Optimize panel asks for it. */
function optimizeStep(o) {
  return `Add an optimization study and run it: minimum compliance, volume fraction ${trim(o.volumeFraction)}, penalty p = ${trim(o.penalty)}, filter r<sub>min</sub> = ${trim(o.filterRadius)} mm; under Advanced, move limit ${trim(o.moveLimit)}, at most ${trim(o.maxIterations)} iterations, tolerance ${trim(o.tolerance)}.`;
}

/** The GUI steps that rebuild a recipe example from its STEP file (lib/recipe.mjs). */
function byHand(e) {
  const r = e.recipe;
  if (!r)
    throw new Error(
      `${e.id}: no recipe; every example is built from its STEP file in the GUI's steps`,
    );
  const point = (p) => `(${p.map(trim).join(", ")})`;
  // On a shell the faces through the wall collapse to the shell's edges, and
  // the user picks those edges (Edge mode).
  const what = r.discretization.kind === "shell" ? "edge" : "face";
  const faces = (refs) =>
    refs.length === 1
      ? `the ${what} through ${point(refs[0].at)}`
      : `the ${what}s through ${refs.map((f) => point(f.at)).join(", ")}`;
  const plane = (s) => {
    const axis = s.normal.findIndex((v) => v === 1);
    return `the plane ${AXES[axis]} = ${trim(s.origin[axis])} mm`;
  };
  const load = (l) => {
    if (l.kind === "force")
      return `force (${l.components.map(trim).join(", ")}) N`;
    if (l.kind === "pressure") return `pressure ${trim(l.value)} MPa`;
    return `moment M${AXES[l.axis]} = ${trim(l.value)} N·mm`;
  };
  const m = r.material;
  const d = r.discretization;
  const steps = [
    `Import <a href="/examples/${encodeURIComponent(e.id)}.step" download>${esc(e.id)}.step</a>.`,
    ...r.splits.map((s) =>
      s.mode === "faces"
        ? `Split ${faces(s.faces)} with ${plane(s)}.`
        : `Split the bodies with ${plane(s)}.`,
    ),
    ...(d.kind === "shell"
      ? [
          `Set the body to Shell. Meshing measures the ${trim(d.thickness)} mm wall and replaces it by its mid-surface; the faces through the wall become the shell's edges, which you pick as Edges.`,
        ]
      : []),
    `Mesh with a ${trim(r.mesh.maxElementSize)} mm maximum element size${r.mesh.minElementSize === undefined ? "" : ` and a ${trim(r.mesh.minElementSize)} mm minimum`}, ${r.mesh.order === 2 ? "quadratic" : "linear"} elements.`,
    `Material ${esc(m.name)}: E = ${trim(m.young)} MPa, ν = ${trim(m.poisson)}.`,
    ...r.supports.map(
      (s) =>
        `Support “${esc(s.name)}”: ${s.dofs.map((d) => DOF_NAMES[d]).join(", ")} = ${trim(s.value)}${s.value === 0 ? "" : " mm"} on ${faces(s.faces)}.`,
    ),
    ...r.loads.map(
      (l) => `Load “${esc(l.name)}”: ${load(l)} on ${faces(l.faces)}.`,
    ),
    r.optimize
      ? `${optimizeStep(r.optimize)} The Results panel's run summary shows the ${esc(r.readout.quantity.toLowerCase())}.`
      : `Run the static study. The Results panel compares ${esc(r.readout.quantity.toLowerCase())} with ${esc(r.readout.formula)}.`,
  ];
  return `
      <p>Or build it yourself, as this page's number was built:</p>
      <ol class="steps">${steps.map((s) => `\n        <li>${s}</li>`).join("")}
      </ol>`;
}

// ── /examples/ ────────────────────────────────────────────────────────────────

export function renderIndexPage(data, allEntries) {
  const entries = contentsOrder(allEntries);
  const benchmarks = entries.filter((e) => e.kind === "case");
  const passed = benchmarks.filter((e) => e.pass).length;
  const description = `Finite element examples you can open in KoFEM, and validation cases compared with a known result: axial bar, a cantilever beam, torsion, a plate with a hole, Cook's membrane, topology optimization.`;

  const item = (e) => {
    const line = hasReference(e)
      ? `${esc(capitalise(e.quantity))}: ${withUnit(num(e.fe), e.unit)}, ${errHtml(e.errPct)} from the reference`
      : esc(e.headline);
    return `
        <li data-entry="${e.id}">
          <a href="${pageUrl(e.id)}" tabindex="-1" aria-hidden="true"><img src="${imagePath(e.id)}" width="${e.figure.width}" height="${e.figure.height}" alt="" loading="lazy" /></a>
          <h3><a href="${pageUrl(e.id)}">${esc(e.name)}</a></h3>
          <p>${esc(e.page.summary)}</p>
          <p class="meta">${line}</p>
        </li>`;
  };
  const list = (sec) =>
    `<ul class="examples">${entries
      .filter((e) => sectionOf(e) === sec)
      .map(item)
      .join("")}
      </ul>`;

  const body = `
      <h1>Examples and validation</h1>
      <p class="lede">
        Models you can open in KoFEM with their supports and loads already set
        up. Each page shows the problem, the model and KoFEM's result.
      </p>

      <h2 id="validation">Validation</h2>
      <p>Problems with a known answer, from theory or the literature. Each page
      derives the answer and compares KoFEM's result with it.</p>
      <p class="meta">
        ${passed} of ${benchmarks.length} benchmarks within their tolerance ·
        engine ${esc(data.engine)} · ${esc(data.generated)} ·
        <a href="/examples/results.json">results.json</a> ·
        <a href="${REPO}/tree/develop/examples">source</a>
      </p>
      ${list("validation")}

      <h2 id="examples">Examples</h2>
      <p>Models without a closed-form answer, which show what KoFEM can do.</p>
      ${list("examples")}

      <h2 id="results">Results</h2>
      <p>Difference = (KoFEM − reference) / reference.</p>
      ${resultsTable(entries)}
      ${DISCLAIMER}

      <h2 id="reproduce">Reproduce</h2>
      <p>The benchmarks run in CI on every change. To run them yourself
      (Bun, bash, curl and Rust):</p>
      ${cloneSteps("cd web &amp;&amp; bun install &amp;&amp; bun run validate")}
      <p>It prints one line per benchmark, for example:</p>
      <pre class="console" data-testid="console-line"><code>${esc(consoleHeader())}
${esc(consoleRow(benchmarks[0]))}</code></pre>`;

  return layout({
    title: "Examples and validation | KoFEM",
    description,
    path: "/examples/",
    image: imagePath(entries[0].id),
    jsonLd: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "CollectionPage",
          name: "KoFEM examples",
          description,
          url: `${SITE}/examples/`,
          dateModified: data.generated,
          hasPart: entries.map((e) => ({
            "@type": "TechArticle",
            headline: e.name,
            url: `${SITE}${pageUrl(e.id)}`,
          })),
        },
        breadcrumbs([
          ["KoFEM", "/"],
          ["Examples", "/examples/"],
        ]),
      ],
    },
    body: docsBody({
      entries,
      currentId: null,
      sections: [
        ["validation", "Validation"],
        ["examples", "Examples"],
        ["results", "Results"],
        ["reproduce", "Reproduce"],
      ],
      body,
    }),
  });
}

// ── One example: /examples/<id>/ ──────────────────────────────────────────────

/** Inputs by symbol: numbers, and "a × b" strings as [a, b]. */
function inputGetter(e) {
  const inputs = new Map(e.inputs.map((i) => [i.symbol, i.value]));
  return (symbol) => {
    if (!inputs.has(symbol))
      throw new Error(`example "${e.id}" has no input "${symbol}"`);
    const v = inputs.get(symbol);
    if (typeof v === "number") return v;
    const parts = String(v).split("×").map(Number);
    if (parts.length < 2 || parts.some((x) => !Number.isFinite(x)))
      throw new Error(
        `example "${e.id}": input "${symbol}" = "${v}" is not a number or a × b`,
      );
    return parts;
  };
}

/** What a textbook function gets: the example's data and formatting helpers. */
function textContext(e, entries, data, studies) {
  const byId = new Map(entries.map((x) => [x.id, x]));
  const rowOf = (id) => {
    const r = byId.get(id);
    if (!r) throw new Error(`page "${e.id}" refers to unknown example "${id}"`);
    return r;
  };
  const study =
    data.convergence.find((s) => s.series.some((x) => x.caseId === e.id)) ??
    null;
  const studyDef = study ? studies.find((s) => s.id === study.id) : null;
  if (study && !studyDef)
    throw new Error(`no study definition for "${study.id}"`);
  return {
    row: e,
    page: e.page,
    rowOf,
    url: pageUrl,
    inp: inputGetter(e),
    inpOf: (id, symbol) => inputGetter(rowOf(id))(symbol),
    study,
    studyDef,
    tex,
    texBlock,
    n: numTex,
    num,
    pct: errHtml,
    pctAbs: (x, digits = 2) => `${Math.abs(x).toFixed(digits)}&nbsp;%`,
  };
}

// Input symbols as TeX: "b × h" → b \times h, "rᵢ" → r_{\mathrm{i}}.
const SUBSCRIPTS = { ᵢ: "i", ₒ: "o" };
const symbolTex = (s) =>
  s
    .replace(/ × /g, " \\times ")
    .replace(/[ᵢₒ]/g, (c) => `_{\\mathrm{${SUBSCRIPTS[c]}}}`);

function inputsTable(e) {
  const body = e.inputs
    .map(
      (i) => `
            <tr><th scope="row">${tex(symbolTex(i.symbol))}</th><td>${inputValue(i.value, i.unit)}</td></tr>`,
    )
    .join("");
  return `
      <div class="table-wrap">
        <table class="spec inputs">${body}
        </table>
      </div>`;
}

const specTable = (rows) => `
      <div class="table-wrap">
        <table class="spec">${rows
          .map(
            ([k, v]) => `
          <tr><th scope="row">${esc(k)}</th><td>${v}</td></tr>`,
          )
          .join("")}
        </table>
      </div>`;

// Element names by solved element type and order.
const ELEMENTS = {
  CTETRA: {
    1: "linear 4-node tetrahedra (P1)",
    2: "quadratic 10-node tetrahedra (P2)",
  },
  CTRIA3: {
    1: "linear 3-node shell triangles (CST membrane, DKT bending)",
  },
};

/** "Mesh" and "Unknowns": from the solved mesh, or as the generator wrote them. */
function meshRows(e) {
  const m = e.mesh;
  let elements = esc(m.elements);
  if (e.kind === "case") {
    const name = ELEMENTS[m.elementType]?.[m.order];
    if (!name)
      throw new Error(
        `${e.id}: no element name for order-${m.order} ${m.elementType} (regenerate with bun run validate:report)`,
      );
    elements = `${int(m.elements)} ${name}`;
  }
  return [
    [
      "Mesh",
      `Netgen, ${trim(e.mesh.maxElementSize)} mm maximum element size: ${elements}`,
    ],
    ["Unknowns", `${int(m.nodes)} nodes, ${int(m.dofs)} degrees of freedom`],
  ];
}

// The solver line: every example is solved as the app solves it.
function solverText(e, data) {
  const engine = esc(e.engine ?? data.engine);
  if (e.recipe?.optimize)
    return `The app's topology optimizer (SIMP with MMA, KoFEM engine); geometry, mesh and optimizer in the WebAssembly build the app runs: ${engine}`;
  // The Rust module's build (lib/provenance.mjs): a case's comes with the
  // results, a showcase's with its record.
  const fem = e.kind === "case" ? (e.fem ?? data.fem) : e.fem;
  if (!fem)
    throw new Error(
      `${e.id}: solved by the Rust module, but the published data names no build of it (fem); regenerate with bun run validate:report`,
    );
  if (e.mesh.elementType === "CTRIA3")
    return `The app's shell solver (conjugate gradients, KoFEM's Rust module, build ${esc(fem)}); geometry and mesh by the KoFEM engine (OCCT, Netgen), the WebAssembly build the app runs: ${engine}`;
  return `The app's default solver (conjugate gradients with algebraic multigrid, KoFEM's Rust module, build ${esc(fem)}); geometry and mesh by the KoFEM engine (OCCT, Netgen), the WebAssembly build the app runs: ${engine}`;
}

function reproduceCommand(e) {
  if (e.kind === "case")
    return `cd web &amp;&amp; bun install &amp;&amp; bun run validate --case ${e.id}`;
  return `cd web &amp;&amp; bun install &amp;&amp; bun run ${esc(e.script)}`;
}

/**
 * One example page. `assets` (web/figure-assets.mjs) turns its diagrams and
 * charts into SVG and PNG files and records them for writing.
 */
export function renderExamplePage(
  data,
  allEntries,
  { studies, textbook, assets },
  id,
) {
  if (!assets)
    throw new Error("renderExamplePage needs a figure asset collector");
  const entries = contentsOrder(allEntries);
  const index = entries.findIndex((x) => x.id === id);
  if (index < 0) throw new Error(`no example "${id}"`);
  const e = entries[index];
  const text = textbook.get(id);
  if (!text)
    throw new Error(`no page text for "${id}" (examples/validation/textbook/)`);
  const ctx = textContext(e, entries, data, studies);
  const page = e.page;
  const literal =
    hasReference(e) && e.referenceLabel.includes(String(e.reference));
  const prev = entries[index - 1];
  const next = entries[index + 1];
  const section = SECTIONS.find((sec) => sec.id === sectionOf(e));
  const inSection = entries.filter((x) => sectionOf(x) === section.id);

  const sections = [];
  // The page's own sections, for "On this page".
  const toc = [
    ["problem", "The problem"],
    ...(text.theory
      ? [["theory", text.theoryTitle ?? "Analytical solution"]]
      : []),
    ["model", "Finite element model"],
    ["results", "Results"],
    ["discussion", "Discussion"],
    ["reproduce", "Reproduce"],
    ["references", "References"],
  ];
  sections.push(`
      <h2 id="problem">The problem</h2>
      <figure class="diagram">
        ${text.figure(ctx)}
        <figcaption>${esc(page.model)} Sketch, not to scale.</figcaption>
      </figure>
      ${inputsTable(e)}
      ${specTable([
        ["Supports", esc(page.supports)],
        ["Load", esc(page.loads)],
        ...(page.ties ? [["Tie", esc(page.ties)]] : []),
        ["Measured", esc(page.measured)],
      ])}`);
  if (text.theory)
    sections.push(`
      <h2 id="theory">${esc(text.theoryTitle ?? "Analytical solution")}</h2>${text.theory(ctx)}`);
  sections.push(`
      <h2 id="model">Finite element model</h2>
      ${specTable([
        ...meshRows(e),
        ["Material", esc(e.material ?? "Linear elastic, isotropic")],
        ["Solver", solverText(e, data)],
      ])}${text.model(ctx)}`);
  const results = text.results
    ? text.results(ctx)
    : `${specTable([
        ["Quantity", esc(e.quantity)],
        [
          "Reference",
          `${esc(e.referenceLabel)}${literal ? "" : ` = ${withUnit(num(e.reference), e.unit)}`} <span class="meta">(${esc(page.source)})</span>`,
        ],
        ["KoFEM", withUnit(num(e.fe), e.unit)],
        [
          "Difference",
          `${errHtml(e.errPct)}${e.tolPct === undefined ? "" : ` ${bandText(e)}`}`,
        ],
      ])}${page.note ? `\n      <p>${esc(page.note)}</p>` : ""}${ctx.study ? convergenceSection(ctx.study, ctx.studyDef, e) : ""}`;
  sections.push(`
      <h2 id="results">Results</h2>${results}`);
  sections.push(`
      <h2 id="discussion">Discussion</h2>${text.discussion(ctx)}`);
  sections.push(`
      <h2 id="reproduce">Reproduce</h2>
      ${inApp(e)}${byHand(e)}
      <p>From a clone (${e.kind === "case" ? "Bun, bash, curl and Rust), this builds and solves the model with the same engine and prints its line" : "Bun, bash, curl), this rebuilds the model and its figure"}:</p>
      ${cloneSteps(reproduceCommand(e))}${
        e.kind === "case"
          ? `
      <pre class="console"><code>${esc(consoleHeader())}
${esc(consoleRow(e))}</code></pre>`
          : ""
      }`);
  sections.push(`
      <h2 id="references">References</h2>
      <ol class="refs">${text.references.map((r) => `\n        <li>${r}</li>`).join("")}
      </ol>
      ${DISCLAIMER}`);

  const body = `
      <p class="crumbs"><a href="/examples/#${section.id}">${section.name}</a> / ${inSection.indexOf(e) + 1} of ${inSection.length}</p>
      <h1>${esc(e.name)}</h1>
      <div class="lede">${text.intro(ctx)}
      </div>
      ${resultFigure(e)}
      ${keyResult(e)}
      <p class="actions">${openButton(e.id)}<span class="meta">${esc(text.opens ?? "Opens the model in the app, ready to run.")}</span></p>
      ${sections.join("\n")}

      <nav class="pager" aria-label="Other examples">${prev ? `\n        <a class="prev" href="${pageUrl(prev.id)}"><small>Previous</small>${esc(prev.name)}</a>` : ""}${next ? `\n        <a class="next" href="${pageUrl(next.id)}"><small>Next</small>${esc(next.name)}</a>` : ""}
      </nav>`;

  // Diagrams and charts become image files the page shows with <picture>.
  const content = assets.extract(body, { page: e.id });

  return layout({
    title: `${e.name} | KoFEM examples`,
    description: text.description,
    path: pageUrl(e.id),
    image: imagePath(e.id),
    jsonLd: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "TechArticle",
          headline: e.name,
          description: text.description,
          url: `${SITE}${pageUrl(e.id)}`,
          image: [imagePath(e.id), ...assets.images(e.id)].map(
            (path) => `${SITE}${path}`,
          ),
          dateModified: e.generated ?? data.generated,
          isPartOf: { "@type": "CollectionPage", url: `${SITE}/examples/` },
          publisher: { "@type": "Organization", name: "KoFEM", url: SITE },
        },
        breadcrumbs([
          ["KoFEM", "/"],
          ["Examples", "/examples/"],
          [e.name, pageUrl(e.id)],
        ]),
      ],
    },
    body: docsBody({ entries, currentId: e.id, sections: toc, body: content }),
  });
}
