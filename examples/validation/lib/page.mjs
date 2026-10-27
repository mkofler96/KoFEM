// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Renders the public validation page, web/validation/index.html (served at
// /validation/), from one engine run (run.mjs --report).
//
// Every number on the page comes from `data` — the object also written to
// web/public/validation/results.json — and every model description from the
// case files. Static, crawlable, script-free apart from the theme toggle; same
// look as the gallery (examples/gallery/site/index.html).

import { consoleHeader, consoleRow, fmt } from "./format.mjs";

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

const withUnit = (html, unit) => (unit ? `${html}&nbsp;${esc(unit)}` : html);

const trim = (x) => minus(String(Number(x.toPrecision(6))));

/** An input value with an SI prefix where it reads better (210 GPa, 10 kN). */
function inputValue(value, unit) {
  if (typeof value === "string") return withUnit(esc(value), unit);
  if (["Pa", "N", "N·m"].includes(unit))
    for (const [f, p] of [
      [1e9, "G"],
      [1e6, "M"],
      [1e3, "k"],
    ])
      if (Math.abs(value) >= f)
        return `${trim(value / f)}&nbsp;${p}${esc(unit)}`;
  return withUnit(trim(value), unit);
}

const errHtml = (e) =>
  `${e > 0 ? "+" : e < 0 ? MINUS : ""}${Math.abs(e).toFixed(2)}&nbsp;%`;

const int = (n) => n.toLocaleString("en-US");

function elementName(order) {
  if (order === 1) return "linear hexahedra (P1)";
  if (order === 2) return "quadratic 27-node hexahedra (P2)";
  throw new Error(`no element name for order ${order}`);
}

const ICON_OPEN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>`;

const band = (r) =>
  `<span class="band ${r.pass ? "pass" : "fail"}">${r.pass ? "✓ within" : "✗ outside"} ±${r.tolPct}&nbsp;%</span>`;

const openLink = (id, text, testid) =>
  `<a class="open-link" href="/app/?example=${encodeURIComponent(id)}"${testid ? ` data-testid="${testid}"` : ""}>${esc(text)}${ICON_OPEN}</a>`;

// ── Results table ─────────────────────────────────────────────────────────────

function resultsTable(rows) {
  const body = rows
    .map(
      (r) => `
            <tr>
              <th scope="row"><a href="#case-${r.id}">${esc(r.name)}</a></th>
              <td class="num" data-label="Reference">${withUnit(num(r.reference), r.unit)}</td>
              <td class="num" data-label="KoFEM">${withUnit(num(r.fe), r.unit)}</td>
              <td class="num" data-label="Error">${errHtml(r.errPct)}</td>
            </tr>`,
    )
    .join("");
  return `
      <div class="table-wrap">
        <table class="data results">
          <thead>
            <tr>
              <th scope="col">Case</th>
              <th scope="col" class="num">Reference</th>
              <th scope="col" class="num">KoFEM</th>
              <th scope="col" class="num">Error</th>
            </tr>
          </thead>
          <tbody>${body}
          </tbody>
        </table>
      </div>`;
}

// ── One case ──────────────────────────────────────────────────────────────────

function caseSection(row, page) {
  const m = row.mesh;
  // A literal reference ("Kt = 3 …") already states its value; a formula does not.
  const literal = row.referenceLabel.includes(String(row.reference));
  const inputs = row.inputs
    .map(
      (i) =>
        `<i>${esc(i.symbol)}</i>&nbsp;=&nbsp;${inputValue(i.value, i.unit)}`,
    )
    .join(", ");
  return `
      <section class="case" id="case-${row.id}" data-case="${row.id}">
        <div class="case-head">
          <h3>${esc(row.name)}</h3>
          ${page.gallery ? openLink(page.gallery, "Open in KoFEM") : ""}
        </div>
        <p>${esc(page.summary)}</p>
        <table class="spec">
          <tr><th scope="row">Model</th><td>${esc(page.model)} ${inputs}.</td></tr>
          <tr><th scope="row">Supports</th><td>${esc(page.supports)}</td></tr>
          <tr><th scope="row">Load</th><td>${esc(page.loads)}</td></tr>
          <tr><th scope="row">Mesh</th><td>${esc(page.mesh)}: ${int(m.elements)} ${elementName(m.order)}, ${int(m.dofs)} DOFs.</td></tr>
          <tr><th scope="row">Measured</th><td>${esc(page.measured)}</td></tr>
          <tr><th scope="row">Reference</th><td>${esc(row.referenceLabel)}${literal ? "" : ` = ${withUnit(num(row.reference), row.unit)}`} <span class="src">(${esc(page.source)})</span></td></tr>
          <tr class="result"><th scope="row">KoFEM</th><td><span data-testid="fe-value">${withUnit(num(row.fe), row.unit)}</span>, error ${errHtml(row.errPct)} ${band(row)}</td></tr>
        </table>${page.note ? `\n        <p class="note">${esc(page.note)}</p>` : ""}
      </section>`;
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
  const tol = `<line class="tol" x1="${PAD.l}" x2="${PAD.l + pw}" y1="${tolY}" y2="${tolY}"/><text class="tol-label" x="${PAD.l + pw - 4}" y="${f(Y(tolPct) - 5)}" text-anchor="end">CI band ±${tolPct} %</text>`;

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
          const tip = `${s.label}, ${p.mesh}: ${int(p.dofs)} DOFs, error ${p.errPct > 0 ? "+" : MINUS}${Math.abs(p.errPct).toFixed(2)} %${p.ci ? " (CI mesh)" : ""}`;
          const cx = f(X(p.dofs)),
            cy = f(Y(Math.abs(p.errPct)));
          const ci = p.ci
            ? `<text class="ci-label" x="${cx}" y="${f(Y(Math.abs(p.errPct)) - 9)}" text-anchor="middle">CI</text>`
            : "";
          return `<g><title>${esc(tip)}</title><circle class="hit" cx="${cx}" cy="${cy}" r="10"/><circle class="mark s${i + 1}${under ? " under" : " over"}" cx="${cx}" cy="${cy}" r="4.5"/>${ci}</g>`;
        })
        .join("");
      return `<path class="line s${i + 1}" d="${path}"/>${marks}`;
    })
    .join("");

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${study.title}: relative error against degrees of freedom, logarithmic axes`)}">
            <text class="axis-title" x="${PAD.l}" y="${PAD.t - 11}">|error| %</text>
            ${grid.join("\n            ")}
            <line class="axis" x1="${PAD.l}" x2="${PAD.l + pw}" y1="${PAD.t + ph}" y2="${PAD.t + ph}"/>
            <line class="axis" x1="${PAD.l}" x2="${PAD.l}" y1="${PAD.t}" y2="${PAD.t + ph}"/>
            ${tol}
            ${series}
            <text class="axis-title" x="${PAD.l + pw}" y="${H - 5}" text-anchor="end">degrees of freedom</text>
          </svg>`;
}

function convergenceSection(study, def, rowsById) {
  const caseRow = rowsById.get(study.caseId);
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
              <tr${p.ci ? ' class="ci"' : ""}>
                <td>${esc(s.label)}</td>
                <td>${esc(p.mesh)}${p.ci ? " (CI)" : ""}</td>
                <td class="num">${int(p.dofs)}</td>
                <td class="num">${withUnit(num(p.fe), caseRow.unit)}</td>
                <td class="num">${errHtml(p.errPct)}</td>
              </tr>`,
      ),
    )
    .join("");
  return `
      <section class="study" id="convergence-${study.id}" data-study="${study.id}">
        <h3>${esc(study.title)}</h3>
        <figure class="chart">
          <div class="legend">${legend}<span class="key"><span class="dot under"></span>below reference</span><span class="key"><span class="dot over"></span>above</span></div>
          ${chart(study, caseRow.tolPct)}
        </figure>
        <p>${esc(def.note)}</p>
        <details>
          <summary>Data</summary>
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th scope="col">Order</th>
                  <th scope="col">Mesh</th>
                  <th scope="col" class="num">DOFs</th>
                  <th scope="col" class="num">KoFEM</th>
                  <th scope="col" class="num">Error</th>
                </tr>
              </thead>
              <tbody>${rows}
              </tbody>
            </table>
          </div>
        </details>
      </section>`;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function renderValidationPage(data, { cases, studies }) {
  const pageById = new Map(cases.map((c) => [c.id, c.page]));
  const rowsById = new Map(data.cases.map((r) => [r.id, r]));
  const defById = new Map(studies.map((s) => [s.id, s]));
  const passed = data.cases.filter((r) => r.pass).length;
  const app = data.reproduce;
  const appCase = rowsById.get(app.caseId);
  if (!appCase)
    throw new Error(`reproduction refers to unknown case "${app.caseId}"`);
  const description = `KoFEM's finite-element solver against ${data.cases.length} closed-form and published benchmarks: reference, KoFEM result, error, mesh convergence and how to reproduce them.`;

  return `<!doctype html>
<!--
  Generated by examples/validation/run.mjs --report from one run of the KoFEM
  engine (${esc(data.engine)}). Do not edit by hand: change the case files or
  examples/validation/lib/page.mjs and regenerate (cd web && bun run validate:report).
-->
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />

    <link rel="icon" href="/favicon.ico" sizes="any" />
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
    <link rel="icon" type="image/svg+xml" href="/kofem_logo.svg" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />

    <title>Validation benchmarks — KoFEM Online Finite Element Solver</title>
    <meta name="description" content="${esc(description)}" />
    <link rel="canonical" href="${SITE}/validation/" />
    <meta name="robots" content="index, follow" />

    <meta property="og:type" content="website" />
    <meta property="og:title" content="Validation benchmarks — KoFEM" />
    <meta property="og:description" content="${esc(description)}" />
    <meta property="og:url" content="${SITE}/validation/" />
    <meta property="og:image" content="${SITE}/kofem_logo.svg" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="Validation benchmarks — KoFEM" />
    <meta name="twitter:description" content="${esc(description)}" />
    <meta name="twitter:image" content="${SITE}/kofem_logo.svg" />

    <!-- Self-hosted fonts (SIL OFL) — see public/fonts/README.md -->
    <link href="/fonts/geist.css" rel="stylesheet" />

    <!-- Apply the saved theme before first paint to avoid a flash. -->
    <script>
      try {
        if (localStorage.getItem("kofem_theme") === "light")
          document.documentElement.setAttribute("data-theme", "light");
      } catch (e) {}
    </script>

    <style>
      :root {
        --bg: #0a0b0f;
        --bg2: #0c0e13;
        --panel: #13151c;
        --panel2: #171a22;
        --border: #23262f;
        --border2: #2d313b;
        --text: #eceef3;
        --muted: #9aa0ad;
        --faint: #6b7280;
        --accent: #5b7cff;
        --pass: #34d399;
        --fail: #f87171;
        --caution: #fbbf24;
        --s1: #3987e5;
        --s2: #d95926;
        --mono: "Geist Mono", ui-monospace, SFMono-Regular, monospace;
      }
      :root[data-theme="light"] {
        --bg: #ffffff;
        --bg2: #f7f8fa;
        --panel: #ffffff;
        --panel2: #f5f6f8;
        --border: #e7e9ee;
        --border2: #d8dbe2;
        --text: #0d1117;
        --muted: #5b616e;
        --faint: #868d99;
        --accent: #2f54eb;
        --pass: #0f8a5f;
        --fail: #c53030;
        --caution: #a15c00;
        --s1: #2a78d6;
        --s2: #eb6834;
      }
      *,
      *::before,
      *::after {
        box-sizing: border-box;
      }
      html {
        scroll-behavior: smooth;
      }
      body {
        margin: 0;
        font-family:
          "Geist",
          -apple-system,
          BlinkMacSystemFont,
          "Segoe UI",
          sans-serif;
        background: var(--bg);
        color: var(--text);
        line-height: 1.55;
        min-height: 100vh;
        -webkit-font-smoothing: antialiased;
      }
      a {
        color: var(--accent);
        text-decoration: none;
      }
      a:hover {
        text-decoration: underline;
      }

      /* ===================== NAV (as the gallery) ===================== */
      .site-header {
        position: sticky;
        top: 0;
        z-index: 50;
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        background: color-mix(in srgb, var(--bg) 76%, transparent);
        border-bottom: 1px solid var(--border);
      }
      .header-inner {
        max-width: 1200px;
        margin: 0 auto;
        padding: 13px 32px;
        display: flex;
        align-items: center;
        gap: 30px;
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 10px;
        color: var(--text);
      }
      .brand:hover {
        text-decoration: none;
      }
      .brand-mark {
        width: 29px;
        height: 29px;
        border-radius: 8px;
        display: block;
        box-shadow: 0 4px 14px -4px var(--accent);
      }
      .brand-name {
        font-weight: 600;
        font-size: 17px;
        letter-spacing: -0.015em;
      }
      .nav-links {
        display: flex;
        gap: 26px;
        font-size: 14px;
      }
      .nav-links a {
        color: var(--muted);
      }
      .nav-links a:hover,
      .nav-links a[aria-current="page"] {
        color: var(--text);
        text-decoration: none;
      }
      .header-actions {
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .icon-btn {
        width: 34px;
        height: 34px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 8px;
        border: 1px solid var(--border);
        background: var(--panel);
        color: var(--text);
        cursor: pointer;
      }
      .icon-moon {
        display: none;
      }
      :root[data-theme="light"] .icon-sun {
        display: none;
      }
      :root[data-theme="light"] .icon-moon {
        display: block;
      }
      .btn-primary {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        background: var(--accent);
        color: #fff;
        font-weight: 600;
        font-size: 14px;
        padding: 8px 15px;
        border-radius: 9px;
        box-shadow: 0 6px 18px -8px var(--accent);
      }
      .btn-primary:hover {
        text-decoration: none;
        filter: brightness(1.08);
      }

      /* ===================== CONTENT ===================== */
      main {
        max-width: 860px;
        margin: 0 auto;
        padding: 56px 32px 64px;
      }
      .eyebrow {
        font-family: var(--mono);
        font-size: 12.5px;
        letter-spacing: 0.16em;
        color: var(--accent);
        text-transform: uppercase;
        margin-bottom: 14px;
      }
      h1 {
        font-size: clamp(30px, 5vw, 42px);
        line-height: 1.1;
        letter-spacing: -0.028em;
        font-weight: 600;
        margin: 0 0 12px;
      }
      h2 {
        font-size: 23px;
        letter-spacing: -0.02em;
        font-weight: 600;
        margin: 52px 0 10px;
        scroll-margin-top: 72px;
      }
      h3 {
        font-size: 17px;
        letter-spacing: -0.01em;
        font-weight: 600;
        margin: 0;
      }
      p {
        color: var(--muted);
        margin: 0 0 12px;
      }
      code,
      pre {
        font-family: var(--mono);
      }
      p code {
        font-size: 0.88em;
        color: var(--text);
        background: var(--panel2);
        border: 1px solid var(--border);
        padding: 1px 5px;
        border-radius: 5px;
      }
      .meta {
        font-family: var(--mono);
        font-size: 12.5px;
        color: var(--faint);
      }
      .callout {
        border: 1px solid var(--border);
        border-left: 3px solid var(--caution);
        background: var(--panel);
        border-radius: 10px;
        padding: 12px 16px;
        margin: 18px 0 0;
        font-size: 14px;
        color: var(--muted);
      }
      .callout strong {
        color: var(--text);
      }

      .table-wrap {
        overflow-x: auto;
        border: 1px solid var(--border);
        border-radius: 10px;
        margin: 12px 0;
      }
      table.data {
        width: 100%;
        border-collapse: collapse;
        font-size: 14px;
      }
      table.data th,
      table.data td {
        padding: 8px 12px;
        text-align: left;
        border-bottom: 1px solid var(--border);
        white-space: nowrap;
      }
      table.data thead th {
        font-size: 11.5px;
        font-weight: 550;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: var(--muted);
        background: var(--panel2);
      }
      table.data tbody tr:last-child th,
      table.data tbody tr:last-child td {
        border-bottom: 0;
      }
      table.data tbody th {
        font-weight: 500;
      }
      table.results tbody th {
        white-space: normal;
      }
      table.data .num {
        text-align: right;
        font-family: var(--mono);
        font-size: 13px;
        font-variant-numeric: tabular-nums;
      }
      table.data tr.ci td {
        background: color-mix(in srgb, var(--accent) 7%, transparent);
      }

      .case,
      .study {
        border-top: 1px solid var(--border);
        padding: 22px 0 6px;
        scroll-margin-top: 64px;
      }
      .case-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 4px;
      }
      .case > p {
        font-size: 14.5px;
        margin-bottom: 8px;
      }
      table.spec {
        border-collapse: collapse;
        font-size: 14px;
        width: 100%;
      }
      table.spec th {
        text-align: left;
        vertical-align: top;
        font-weight: 550;
        color: var(--text);
        padding: 3px 16px 3px 0;
        width: 96px;
      }
      table.spec td {
        color: var(--muted);
        padding: 3px 0;
      }
      table.spec tr.result td {
        color: var(--text);
      }
      table.spec sup {
        line-height: 0;
      }
      .src {
        color: var(--faint);
      }
      .band {
        font-size: 13px;
        margin-left: 6px;
      }
      .band.pass {
        color: var(--pass);
      }
      .band.fail {
        color: var(--fail);
      }
      .note {
        font-size: 14px;
        border-left: 2px solid var(--caution);
        padding-left: 10px;
        margin-top: 8px;
      }
      .open-link {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: 13.5px;
        font-weight: 550;
        white-space: nowrap;
      }
      .open-link svg {
        width: 13px;
        height: 13px;
      }

      /* ===================== CHARTS ===================== */
      figure.chart {
        margin: 12px 0 10px;
        border: 1px solid var(--border);
        border-radius: 10px;
        background: var(--panel);
        padding: 12px 14px 8px;
      }
      figure.chart svg {
        display: block;
        width: 100%;
        max-width: 600px;
        height: auto;
        margin: 2px auto 0;
      }
      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 16px;
        font-size: 12.5px;
        color: var(--muted);
      }
      .key {
        display: inline-flex;
        align-items: center;
        gap: 7px;
      }
      .swatch {
        width: 16px;
        height: 2px;
        border-radius: 1px;
      }
      .swatch.s1 {
        background: var(--s1);
      }
      .swatch.s2 {
        background: var(--s2);
      }
      .dot {
        width: 9px;
        height: 9px;
        border-radius: 50%;
        border: 2px solid var(--muted);
      }
      .dot.under {
        background: var(--muted);
      }
      svg .grid {
        stroke: var(--border);
        stroke-width: 1;
      }
      svg .axis {
        stroke: var(--border2);
        stroke-width: 1;
      }
      svg .tick,
      svg .axis-title {
        fill: var(--muted);
        font-size: 11px;
        font-family: var(--mono);
      }
      svg .tol {
        stroke: var(--caution);
        stroke-width: 1;
        opacity: 0.8;
      }
      svg .tol-label {
        fill: var(--muted);
        font-size: 10.5px;
      }
      svg .ci-label {
        fill: var(--text);
        font-size: 9.5px;
        font-weight: 600;
        font-family: var(--mono);
      }
      svg .line {
        fill: none;
        stroke-width: 2;
        stroke-linejoin: round;
        stroke-linecap: round;
      }
      svg .line.s1 {
        stroke: var(--s1);
      }
      svg .line.s2 {
        stroke: var(--s2);
      }
      svg .mark {
        stroke-width: 2;
      }
      svg .mark.s1.under {
        fill: var(--s1);
        stroke: var(--panel);
      }
      svg .mark.s2.under {
        fill: var(--s2);
        stroke: var(--panel);
      }
      svg .mark.over {
        fill: var(--panel);
      }
      svg .mark.s1.over {
        stroke: var(--s1);
      }
      svg .mark.s2.over {
        stroke: var(--s2);
      }
      svg .hit {
        fill: transparent;
      }
      svg g:hover .mark {
        stroke-width: 3;
      }
      details {
        margin: 0 0 8px;
        font-size: 14px;
      }
      summary {
        cursor: pointer;
        color: var(--accent);
        font-size: 13.5px;
      }

      /* ===================== REPRODUCE ===================== */
      pre {
        font-size: 12.5px;
        line-height: 1.55;
        color: var(--text);
        background: var(--panel2);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 10px 14px;
        overflow-x: auto;
        margin: 8px 0 12px;
      }
      pre.console {
        font-size: 11px;
      }
      .readout {
        font-family: var(--mono);
        font-size: 13.5px;
        color: var(--text);
        background: var(--panel2);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 1px 7px;
        white-space: nowrap;
      }

      /* ===================== FOOTER ===================== */
      .site-footer {
        border-top: 1px solid var(--border);
        background: var(--bg2);
      }
      .footer-bottom-inner {
        max-width: 1200px;
        margin: 0 auto;
        padding: 22px 32px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        flex-wrap: wrap;
        font-size: 13px;
        color: var(--faint);
      }
      .footer-bottom-inner .legal {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 20px;
      }
      .footer-bottom-inner a {
        color: var(--faint);
      }
      .footer-bottom-inner a:hover {
        color: var(--text);
      }

      @media (max-width: 760px) {
        .nav-links {
          display: none;
        }
        .header-inner,
        .footer-bottom-inner {
          padding-left: 16px;
          padding-right: 16px;
        }
        main {
          padding: 36px 16px 48px;
        }
        table.spec th {
          width: 76px;
          padding-right: 10px;
        }
        figure.chart {
          padding: 10px 8px 6px;
        }
      }
      /* Narrow screens: each result row stacks — case name, then the numbers. */
      @media (max-width: 560px) {
        table.results thead {
          display: none;
        }
        table.results tr {
          display: grid;
          grid-template-columns: 1fr 1fr auto;
          column-gap: 10px;
          padding: 8px 12px;
          border-bottom: 1px solid var(--border);
        }
        table.results tbody tr:last-child {
          border-bottom: 0;
        }
        table.results th,
        table.results td {
          border: 0;
          padding: 0;
        }
        table.results th[scope="row"] {
          grid-column: 1 / -1;
          margin-bottom: 2px;
        }
        table.results td.num {
          text-align: left;
          font-size: 12px;
        }
        table.results td::before {
          content: attr(data-label);
          display: block;
          font-family: "Geist", sans-serif;
          font-size: 10.5px;
          letter-spacing: 0.05em;
          text-transform: uppercase;
          color: var(--faint);
        }
      }
    </style>
  </head>

  <body>
    <header class="site-header">
      <div class="header-inner">
        <a class="brand" href="/">
          <img class="brand-mark" src="/kofem_logo.svg" alt="KoFEM logo" width="29" height="29" />
          <span class="brand-name">KoFEM</span>
        </a>
        <nav class="nav-links" aria-label="Site">
          <a href="/#workflow">Workflow</a>
          <a href="/examples/">Examples</a>
          <a href="/validation/" aria-current="page">Validation</a>
          <a href="/#app">Solver</a>
        </nav>
        <div class="header-actions">
          <button class="icon-btn" id="theme-toggle" aria-label="Toggle theme">
            <svg class="icon-sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path></svg>
            <svg class="icon-moon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"></path></svg>
          </button>
          <a class="btn-primary" href="/app/">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"></path></svg>
            Start Solver
          </a>
        </div>
      </div>
    </header>

    <main>
      <div class="eyebrow">Validation</div>
      <h1>Validation benchmarks</h1>
      <p>
        Textbook problems with known answers, solved by the engine the app
        runs. Error is (KoFEM − reference) / reference.
      </p>
      <p class="meta">
        ${passed} of ${data.cases.length} within their CI band ·
        engine ${esc(data.engine)} · ${esc(data.generated)} ·
        <a href="/validation/results.json">results.json</a> ·
        <a href="${REPO}/blob/main/examples/validation/README.md">details</a>
      </p>
      ${resultsTable(data.cases)}
      <p class="callout" data-testid="disclaimer">
        <strong>Research software, not certified for safety-critical design.</strong>
        Linear-static, linear-elastic solids only. These cases use structured
        hex meshes, not the app's tetrahedral meshing. Check results that
        matter against your own references.
      </p>

      <h2 id="cases">Cases</h2>
      ${data.cases
        .map((r) => {
          const page = pageById.get(r.id);
          if (!page) throw new Error(`no page text for case "${r.id}"`);
          return caseSection(r, page);
        })
        .join("")}

      <h2 id="convergence">Convergence</h2>
      <p>
        Error against degrees of freedom on refined meshes. Filled marker:
        below the reference; ring: above; CI: the mesh the case is gated on.
      </p>
      ${data.convergence
        .map((s) => {
          const def = defById.get(s.id);
          if (!def) throw new Error(`no study text for "${s.id}"`);
          return convergenceSection(s, def, rowsById);
        })
        .join("")}

      <h2 id="reproduce">Reproduce</h2>
      <p>From a clone (Node.js 20+, bash, curl):</p>
      <pre><code>git clone ${REPO}.git &amp;&amp; cd KoFEM
bash scripts/fetch-wasm-engine.sh
node examples/validation/run.mjs</code></pre>
      <p>prints every case, for example:</p>
      <pre class="console" data-testid="console-line"><code>${esc(consoleHeader())}
${esc(consoleRow(appCase))}</code></pre>
      <p>
        In the app: ${openLink(app.galleryId, `open ${app.title}`, "reproduce-open")},
        run Studies → Static 1 → Run static solve, select the result plot and
        set Field to ${esc(app.field)}. The Result summary shows
        <span class="readout" data-testid="app-readout" data-stat="${esc(app.stat)}" data-value="${esc(app.appReadout)}">${esc(app.stat)} ${esc(app.appReadout)}</span>;
        the end-face mean, ${withUnit(num(app.faceMean), app.unit)}, is the
        ${esc(appCase.name)} row above in mm.
      </p>
    </main>

    <footer class="site-footer">
      <div class="footer-bottom-inner">
        <span>© 2026 KoFEM — Online Finite Element Solver</span>
        <div class="legal">
          <a href="/">Home</a>
          <a href="/examples/">Examples</a>
          <a href="/validation/">Validation</a>
          <a href="/app/">Launch</a>
          <a href="/privacy/">Privacy &amp; Cookies</a>
          <a href="#" id="kofem-cookie-settings">Cookie settings</a>
        </div>
      </div>
    </footer>

    <script>
      // Theme toggle — shared with the landing page and gallery via the
      // "kofem_theme" localStorage key.
      (function () {
        var btn = document.getElementById("theme-toggle");
        if (!btn) return;
        btn.addEventListener("click", function () {
          var root = document.documentElement;
          var light = root.getAttribute("data-theme") === "light";
          if (light) {
            root.removeAttribute("data-theme");
            try {
              localStorage.setItem("kofem_theme", "dark");
            } catch (e) {}
          } else {
            root.setAttribute("data-theme", "light");
            try {
              localStorage.setItem("kofem_theme", "light");
            } catch (e) {}
          }
        });
      })();
    </script>
  </body>
</html>
`;
}
