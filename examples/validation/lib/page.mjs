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

const STYLE = `
      /* Equations and figure symbols: a subset of New Computer Modern Math,
         the LaTeX look (web/public/fonts/README.md). */
      @font-face {
        font-family: "KoFEM Math";
        font-style: normal;
        font-weight: 400;
        font-display: swap;
        src: url(/fonts/kofem-math.woff2) format("woff2");
      }
      /* Light by default, under the site's variable names
         (web/public/site.css), so the shared header and footer follow it:
         --text for headings and numbers, --body for prose, --accent for
         links. The dark theme (data-theme="dark", the theme switch) is the
         site's own palette. */
      :root {
        --math: "KoFEM Math", math;
      }
      :root:not([data-theme="dark"]) {
        color-scheme: light;
        --bg: #ffffff;
        --bg2: #f7f8fa;
        --panel: #f4f5f7;
        --panel2: #eef1f5;
        --line: #e3e5e9;
        --line2: #cfd3da;
        --border: var(--line);
        --border2: var(--line2);
        --text: #16181d;
        --body: #2b2f36;
        --muted: #6a717c;
        --faint: #8a919c;
        --accent: #1d5bbf;
        --pass: #1d7a3a;
        --fail: #b3261e;
        --caution: #b7791f;
        --s1: #2563c9;
        --s2: #c4561f;
      }
      :root[data-theme="dark"] {
        --pass: #6fcf97;
        --fail: #f28b82;
        --caution: #e5c07b;
        --s1: #4a90e2;
        --s2: #cf6d2c;
      }
      :root[data-theme="dark"] svg.fig .body,
      :root[data-theme="dark"] svg.fig .hole,
      :root[data-theme="dark"] svg.fig .wall {
        stroke: #8fa3b5;
      }
      :root[data-theme="dark"] svg.fig .body.top {
        fill: #1b2733;
      }
      :root[data-theme="dark"] svg.fig .body.end {
        fill: #1f2d3b;
      }
      :root[data-theme="dark"] svg.fig .mesh {
        stroke: #2c3b4a;
      }
      :root[data-theme="dark"] svg.fig .hatch {
        stroke: #5f6d7a;
      }
      :root[data-theme="dark"] svg.fig .ext {
        stroke: #3d4a57;
      }
      :root[data-theme="dark"] svg.fig .axis {
        stroke: #4a5866;
      }
      .theme-toggle {
        margin: 14px 10px 0;
        font: inherit;
        font-size: 13.5px;
        color: var(--muted);
        background: none;
        border: 1px solid var(--line2);
        border-radius: 5px;
        padding: 4px 10px;
        cursor: pointer;
      }
      .theme-toggle:hover {
        color: var(--text);
        background: var(--panel);
      }
      .site-navigation {
        border-bottom: 1px solid var(--line);
      }
      *,
      *::before,
      *::after {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        font-family: var(--sans);
        font-size: 16px;
        line-height: 1.65;
        background: var(--bg);
        color: var(--body);
        -webkit-font-smoothing: antialiased;
      }
      a {
        color: var(--accent);
        text-decoration: none;
      }
      main a:not(.button):not(.pager a) {
        text-decoration: underline;
        text-decoration-color: color-mix(in srgb, var(--accent) 30%, transparent);
        text-underline-offset: 3px;
      }
      main a:hover {
        text-decoration-color: var(--accent);
      }
      a:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 3px;
        border-radius: 3px;
      }

      /* Documentation layout: contents on the left, the page, and the
         page's sections on the right. */
      .docs {
        max-width: 1360px;
        margin: 0 auto;
        padding: 0 28px;
        display: grid;
        grid-template-columns: 240px minmax(0, 1fr) 190px;
        gap: 48px;
      }
      .docs-nav,
      .docs-toc {
        position: sticky;
        top: 96px;
        align-self: start;
        max-height: calc(100vh - 110px);
        overflow-y: auto;
        padding: 36px 0 40px;
        font-size: 14.5px;
        line-height: 1.45;
      }
      .docs-nav {
        border-right: 1px solid var(--line);
        padding-right: 20px;
      }
      .docs-nav a,
      .docs-toc a,
      .docs-menu a {
        display: block;
        color: var(--body);
        padding: 4px 10px;
        border-radius: 5px;
      }
      .docs-nav a:hover,
      .docs-toc a:hover,
      .docs-menu a:hover {
        color: var(--text);
        background: var(--panel);
      }
      .docs-nav a[aria-current],
      .docs-menu a[aria-current] {
        color: var(--accent);
        background: var(--panel);
        font-weight: 500;
      }
      .docs-nav ul,
      .docs-toc ul,
      .docs-menu ul {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .docs-group {
        margin: 14px 0 0;
      }
      .docs-group summary {
        position: relative;
        list-style: none;
        cursor: pointer;
        padding: 6px 10px 6px 26px;
        border-radius: 5px;
        font-weight: 600;
        color: var(--text);
      }
      .docs-group summary::-webkit-details-marker {
        display: none;
      }
      .docs-group summary::before {
        content: "";
        position: absolute;
        left: 10px;
        top: 13px;
        width: 6px;
        height: 6px;
        border-right: 1.5px solid var(--muted);
        border-bottom: 1.5px solid var(--muted);
        transform: rotate(-45deg);
        transition: transform 0.15s;
      }
      .docs-group[open] summary::before {
        transform: rotate(45deg);
        top: 11px;
      }
      .docs-group summary:hover {
        background: var(--panel);
      }
      .docs-group ul {
        margin: 2px 0 6px 16px;
      }
      .docs-toc {
        font-size: 13.5px;
      }
      .docs-toc p {
        margin: 0 0 6px;
        padding: 0 10px;
        font-weight: 600;
        color: var(--text);
      }
      .docs-toc a {
        padding: 3px 10px;
        color: var(--muted);
      }
      .docs-menu {
        display: none;
        border: 1px solid var(--line);
        border-radius: 8px;
        margin: 0 0 24px;
        font-size: 15px;
      }
      .docs-menu summary {
        padding: 9px 14px;
        color: var(--text);
        font-weight: 500;
      }
      .docs-menu > div {
        padding: 0 8px 10px;
      }
      main {
        min-width: 0;
        max-width: 800px;
        padding: 36px 0 80px;
      }
      @media (max-width: 1240px) {
        .docs {
          grid-template-columns: 230px minmax(0, 1fr);
          gap: 40px;
        }
        .docs-toc {
          display: none;
        }
      }
      @media (max-width: 900px) {
        .docs {
          display: block;
          padding: 0 16px;
        }
        .docs-nav {
          display: none;
        }
        .docs-menu {
          display: block;
        }
      }
      .crumbs {
        font-size: 14px;
        color: var(--muted);
        margin: 0 0 10px;
      }
      .crumbs a {
        color: var(--muted);
      }
      h1 {
        color: var(--text);
        font-size: 32px;
        font-weight: 600;
        line-height: 1.25;
        letter-spacing: -0.01em;
        margin: 0 0 18px;
      }
      h2 {
        color: var(--text);
        font-size: 22px;
        font-weight: 600;
        line-height: 1.3;
        margin: 52px 0 14px;
        scroll-margin-top: 110px;
      }
      h3 {
        color: var(--text);
        font-size: 17px;
        font-weight: 600;
        margin: 32px 0 10px;
      }
      p {
        margin: 0 0 16px;
      }
      .lede {
        font-size: 17.5px;
      }
      strong {
        color: var(--text);
        font-weight: 600;
      }
      em {
        font-style: italic;
      }
      code,
      pre {
        font-family: var(--mono);
      }
      p code,
      li code,
      td code {
        font-size: 0.87em;
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 4px;
        padding: 0 4px;
      }
      .meta {
        font-size: 14px;
        color: var(--muted);
      }
      .meta a {
        color: var(--muted);
      }
      math {
        font-family: var(--math);
        font-size: 1.12em;
      }
      math[display="block"] {
        margin: 18px 0 20px;
        padding: 2px 0;
        overflow-x: auto;
        overflow-y: hidden;
        font-size: 1.16em;
      }
      .button {
        display: inline-block;
        font-size: 15px;
        font-weight: 500;
        color: var(--text);
        background: var(--bg);
        border: 1px solid var(--line2);
        border-radius: 6px;
        padding: 6px 14px;
      }
      .button:hover {
        background: var(--panel);
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 16px;
        margin: 20px 0 0;
      }
      .note {
        background: var(--panel);
        border-radius: 6px;
        padding: 12px 16px;
        font-size: 15px;
        margin: 22px 0 0;
      }
      .band {
        font-size: 14px;
        white-space: nowrap;
      }
      .band.pass {
        color: var(--pass);
      }
      .band.fail {
        color: var(--fail);
      }
      sup {
        line-height: 0;
      }

      /* Tables: ruled, with a grey header row. */
      .table-wrap {
        overflow-x: auto;
        border: 1px solid var(--line);
        border-radius: 8px;
        margin: 18px 0 22px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 15px;
      }
      th,
      td {
        padding: 9px 14px;
        text-align: left;
        vertical-align: top;
        border-bottom: 1px solid var(--line);
      }
      thead th {
        background: var(--panel);
        font-weight: 500;
        color: var(--text);
        white-space: nowrap;
      }
      th + th,
      td + td,
      th + td {
        border-left: 1px solid var(--line);
      }
      tbody tr:last-child > * {
        border-bottom: 0;
      }
      tbody th {
        font-weight: 500;
        color: var(--text);
      }
      td.num,
      th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      table.spec th {
        width: 120px;
        background: var(--panel);
      }
      caption {
        caption-side: top;
        text-align: left;
        padding: 9px 14px;
        font-size: 14px;
        color: var(--muted);
        border-bottom: 1px solid var(--line);
      }
      table.key-result td.num,
      table.key-result th.num {
        width: 33.3%;
      }

      /* Figures. */
      figure {
        margin: 22px 0;
      }
      figure.diagram,
      figure.chart {
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 14px 16px 10px;
      }
      figure svg {
        display: block;
        width: 100%;
        height: auto;
      }
      figure.result img {
        display: block;
        width: 100%;
        height: auto;
        border: 1px solid var(--line);
        border-radius: 8px;
      }
      figcaption {
        font-size: 14px;
        color: var(--muted);
        margin-top: 8px;
      }
      .colorbar {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 13px;
        color: var(--muted);
        margin-top: 10px;
        font-variant-numeric: tabular-nums;
      }
      .colorbar .bar {
        flex: 0 1 220px;
        height: 9px;
        border-radius: 2px;
        /* The app's contour scale, low → high: hsl(240°) → hsl(0°). */
        background: linear-gradient(
          to right,
          hsl(240 100% 50%),
          hsl(180 100% 50%),
          hsl(120 100% 50%),
          hsl(60 100% 50%),
          hsl(0 100% 50%)
        );
      }
      .fig-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 0;
      }
      .fig-row svg.half {
        flex: 1 1 280px;
        width: auto;
        max-width: 100%;
      }
      svg.fig .body {
        fill: var(--panel2);
        stroke: #4f5966;
        stroke-width: 1.3;
      }
      svg.fig .body.top {
        fill: #e3e8ee;
      }
      svg.fig .body.end {
        fill: #d9dfe7;
      }
      svg.fig .hole {
        fill: var(--bg);
        stroke: #4f5966;
        stroke-width: 1.3;
      }
      svg.fig .mesh {
        stroke: #c5ccd5;
        stroke-width: 0.7;
        fill: none;
      }
      svg.fig .clamp {
        fill: url(#hatch);
      }
      svg.fig .hatch {
        stroke: #7d8693;
        stroke-width: 1.1;
      }
      svg.fig .wall {
        stroke: #4f5966;
        stroke-width: 2;
      }
      svg.fig .load {
        stroke: var(--s1);
        stroke-width: 1.7;
        fill: none;
      }
      svg.fig .m-load {
        fill: var(--s1);
      }
      svg.fig .dim {
        stroke: var(--muted);
        stroke-width: 1;
      }
      svg.fig .m-dim {
        fill: var(--muted);
      }
      svg.fig .m-def {
        fill: var(--s2);
      }
      svg.fig .ext {
        stroke: #b5bcc6;
        stroke-width: 1;
      }
      svg.fig .deformed {
        stroke: var(--s2);
        stroke-width: 1.5;
        stroke-dasharray: 5 4;
        fill: none;
      }
      svg.fig .axis {
        stroke: #9aa2ad;
        stroke-width: 1;
        stroke-dasharray: 8 3 2 3;
      }
      svg.fig text {
        font-family: var(--sans);
      }
      svg.fig .lbl {
        fill: var(--muted);
        font-size: 12px;
      }
      svg.fig .sym,
      svg.fig .axis-lbl {
        fill: var(--text);
        font-family: var(--math);
        font-size: 17px;
      }
      svg.fig .sub {
        font-size: 70%;
      }
      svg.fig .m {
        font-family: var(--math);
        font-size: 14px;
      }
      svg.fig .axis-lbl {
        fill: var(--muted);
        font-size: 14px;
      }
      svg.fig .tick,
      svg.fig .coord {
        fill: var(--muted);
        font-family: var(--mono);
        font-size: 10.5px;
      }
      svg.fig .warp {
        fill: var(--s1);
        font-size: 17px;
        font-weight: 600;
      }
      svg.fig .pt {
        fill: var(--s1);
        stroke: var(--bg);
        stroke-width: 1.5;
      }
      svg.fig .curve {
        stroke: var(--s1);
        stroke-width: 2;
        fill: none;
      }
      svg.fig .chart-axis {
        stroke: var(--line2);
      }
      svg.fig .chart-grid {
        stroke: var(--line);
      }

      /* Charts. */
      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 18px;
        font-size: 13px;
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
      svg.conv .grid {
        stroke: var(--line);
        stroke-width: 1;
      }
      svg.conv .axis {
        stroke: var(--line2);
        stroke-width: 1;
      }
      svg.conv .tick,
      svg.conv .axis-title {
        fill: var(--muted);
        font-size: 11px;
        font-family: var(--mono);
      }
      svg.conv .tol {
        stroke: var(--caution);
        stroke-width: 1;
        stroke-dasharray: 4 3;
      }
      svg.conv .tol-label {
        fill: var(--muted);
        font-size: 10.5px;
        font-family: var(--sans);
      }
      svg.conv .ci-ring {
        fill: none;
        stroke: var(--text);
        stroke-width: 1.2;
      }
      figure.chart svg.conv {
        max-width: 560px;
        margin: 0 auto;
      }
      svg.conv .line {
        fill: none;
        stroke-width: 2;
        stroke-linejoin: round;
        stroke-linecap: round;
      }
      svg.conv .line.s1 {
        stroke: var(--s1);
      }
      svg.conv .line.s2 {
        stroke: var(--s2);
      }
      svg.conv .mark {
        stroke-width: 2;
      }
      svg.conv .mark.s1.under {
        fill: var(--s1);
        stroke: var(--bg);
      }
      svg.conv .mark.s2.under {
        fill: var(--s2);
        stroke: var(--bg);
      }
      svg.conv .mark.over {
        fill: var(--bg);
      }
      svg.conv .mark.s1.over {
        stroke: var(--s1);
      }
      svg.conv .mark.s2.over {
        stroke: var(--s2);
      }
      svg.conv .hit {
        fill: transparent;
      }
      main details {
        margin: 0 0 8px;
        font-size: 15px;
      }
      main summary {
        cursor: pointer;
        color: var(--accent);
      }

      pre {
        font-size: 13px;
        line-height: 1.6;
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 12px 16px;
        overflow-x: auto;
        margin: 10px 0 16px;
      }
      pre.console {
        font-size: 11.5px;
      }
      .readout {
        font-family: var(--mono);
        font-size: 14px;
        white-space: nowrap;
      }
      ol.refs {
        padding-left: 22px;
        font-size: 15px;
      }
      ol.refs li {
        margin: 0 0 8px;
      }
      cite {
        font-style: italic;
      }

      /* The list of examples. */
      .examples {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 32px 28px;
        margin: 28px 0 8px;
        padding: 0;
        list-style: none;
      }
      .examples img {
        display: block;
        width: 100%;
        height: auto;
        aspect-ratio: 16 / 10;
        object-fit: contain;
        border: 1px solid var(--line);
        border-radius: 8px;
        margin-bottom: 10px;
      }
      .examples h3 {
        font-size: 16.5px;
        margin: 0 0 4px;
      }
      main .examples h3 a {
        color: var(--text);
        text-decoration: none;
      }
      .examples h3 a:hover {
        color: var(--accent);
      }
      .examples p {
        font-size: 15px;
        margin: 0 0 4px;
      }

      .pager {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        margin: 56px 0 0;
        padding-top: 18px;
        border-top: 1px solid var(--line);
        font-size: 15px;
      }
      .pager a:hover {
        text-decoration: underline;
      }
      .pager .next {
        margin-left: auto;
        text-align: right;
      }
      .pager small {
        display: block;
        color: var(--muted);
        font-size: 13px;
      }

      @media (max-width: 700px) {
        main {
          padding: 24px 0 64px;
        }
        h1 {
          font-size: 27px;
        }
        .examples {
          grid-template-columns: 1fr;
        }
        table.spec th {
          width: 92px;
        }
        th,
        td {
          padding: 8px 10px;
        }
        .wide {
          display: none;
        }
        /* Each result row stacks: the example, then its three numbers. */
        table.results thead {
          display: none;
        }
        table.results tr {
          display: grid;
          grid-template-columns: 1fr 1fr auto;
          column-gap: 10px;
          padding: 10px 12px;
          border-bottom: 1px solid var(--line);
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
          font-size: 13.5px;
        }
        table.results td::before {
          content: attr(data-label);
          display: block;
          font-size: 12px;
          color: var(--muted);
        }
        figure.diagram {
          overflow-x: auto;
          padding: 10px 8px 8px;
        }
        figure.diagram > svg.fig {
          min-width: 540px;
        }
      }`;

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

// The theme switch: light by default, dark on request, remembered in this
// browser only. Without script the switch stays hidden and the page light.
const THEME_KEY = "kofem_docs_theme";
const THEME_SWITCH = `
      (function () {
        var root = document.documentElement;
        var icons = document.querySelectorAll(".site-theme");
        var texts = document.querySelectorAll(".theme-toggle");
        function show() {
          var dark = root.getAttribute("data-theme") === "dark";
          var next = dark ? "light" : "dark";
          icons.forEach(function (b) {
            b.setAttribute("aria-label", "Switch to the " + next + " theme");
            b.title = "Switch to the " + next + " theme";
            b.hidden = false;
          });
          texts.forEach(function (b) {
            b.textContent = dark ? "Light theme" : "Dark theme";
            b.hidden = false;
          });
        }
        function toggle() {
          var dark = root.getAttribute("data-theme") !== "dark";
          if (dark) root.setAttribute("data-theme", "dark");
          else root.removeAttribute("data-theme");
          try {
            localStorage.setItem("${THEME_KEY}", dark ? "dark" : "light");
          } catch (e) {}
          show();
        }
        icons.forEach(function (b) {
          b.addEventListener("click", toggle);
        });
        texts.forEach(function (b) {
          b.addEventListener("click", toggle);
        });
        show();
      })();`;

/** A complete static page. */
function layout({ title, description, path, image, jsonLd, body }) {
  const url = `${SITE}${path}`;
  const img = image ? `${SITE}${image}` : `${SITE}/kofem_logo.svg`;
  return `<!doctype html>
<!--
  Generated by examples/validation/run.mjs --report. Do not edit by hand:
  change the case files, examples/validation/textbook/ or
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

    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}" />
    <link rel="canonical" href="${url}" />
    <meta name="robots" content="index, follow" />

    <meta property="og:type" content="article" />
    <meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(description)}" />
    <meta property="og:url" content="${url}" />
    <meta property="og:image" content="${img}" />
    <meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}" />
    <meta name="twitter:title" content="${esc(title)}" />
    <meta name="twitter:description" content="${esc(description)}" />
    <meta name="twitter:image" content="${img}" />

    <!-- Self-hosted fonts (SIL OFL) — see public/fonts/README.md -->
    <link href="/fonts/ibm-plex.css" rel="stylesheet" />
    <link href="/case-page.css" rel="stylesheet" />
    <link rel="preload" href="/fonts/kofem-math.woff2" as="font" type="font/woff2" crossorigin />

    <script type="application/ld+json">
${JSON.stringify(jsonLd, null, 2)
  .split("\n")
  .map((l) => `      ${l}`)
  .join("\n")}
    </script>

    <link href="/site.css" rel="stylesheet" />
    <style>${STYLE}
    </style>
    <!-- The theme a reader chose, before first paint; light otherwise. -->
    <script>
      try {
        if (localStorage.getItem("${THEME_KEY}") === "dark")
          document.documentElement.setAttribute("data-theme", "dark");
      } catch (e) {}
    </script>
  </head>
  <body>
    ${body}
    <script>${THEME_SWITCH}
    </script>
  </body>
</html>
`;
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
        <figcaption>${esc(name)}, ${esc(shape)}. Drawn from the analysis file that Open in KoFEM loads.</figcaption>
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

  return `<svg class="conv" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${study.title}: difference from the reference against degrees of freedom, logarithmic axes`)}">
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

// ── /examples/ ────────────────────────────────────────────────────────────────

export function renderIndexPage(data, allEntries) {
  const entries = contentsOrder(allEntries);
  const benchmarks = entries.filter((e) => e.kind === "case");
  const passed = benchmarks.filter((e) => e.pass).length;
  const description = `Finite element examples you can open in KoFEM, and validation cases compared with a known result: axial bar, cantilever beams, torsion, a plate with a hole, Cook's membrane, topology optimization.`;

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
      (Node.js 20+, bash, curl):</p>
      ${cloneSteps("node examples/validation/run.mjs")}
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

const ELEMENTS = {
  1: "linear 8-node hexahedra (P1)",
  2: "quadratic 27-node hexahedra (P2)",
};

/** "Mesh" and "Unknowns": from the solved mesh, or as the generator wrote them. */
function meshRows(e) {
  const m = e.mesh;
  const elements =
    e.kind === "case"
      ? `${int(m.elements)} ${ELEMENTS[m.order]}`
      : esc(m.elements);
  return [
    ["Mesh", `${esc(e.page.mesh)}: ${elements}`],
    ["Unknowns", `${int(m.nodes)} nodes, ${int(m.dofs)} degrees of freedom`],
  ];
}

function reproduceCommand(e) {
  if (e.kind === "case")
    return `node examples/validation/run.mjs --case ${e.id}`;
  return `cd web &amp;&amp; bun install &amp;&amp; bun run ${esc(e.script)}`;
}

export function renderExamplePage(data, allEntries, { studies, textbook }, id) {
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
        <figcaption>${esc(page.model)} Sketch, not to scale${page.grid ? "; thin lines show the element mesh" : ""}.</figcaption>
      </figure>
      ${inputsTable(e)}
      ${specTable([
        ["Supports", esc(page.supports)],
        ["Load", esc(page.loads)],
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
        [
          "Solver",
          `KoFEM engine (MFEM), the WebAssembly build the app runs: ${esc(e.engine ?? data.engine)}`,
        ],
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
      ${inApp(e)}
      <p>From a clone (Node.js 20+, bash, curl)${e.kind === "case" ? ", this solves the model with the same engine and prints its line" : ", this rebuilds the model and its figure"}:</p>
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
      <p class="actions">${openButton(e.id)}<span class="meta">${esc(text.opens ?? "Opens the solved model in the app.")}</span></p>
      ${sections.join("\n")}

      <nav class="pager" aria-label="Other examples">${prev ? `\n        <a class="prev" href="${pageUrl(prev.id)}"><small>Previous</small>${esc(prev.name)}</a>` : ""}${next ? `\n        <a class="next" href="${pageUrl(next.id)}"><small>Next</small>${esc(next.name)}</a>` : ""}
      </nav>`;

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
          image: `${SITE}${imagePath(e.id)}`,
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
    body: docsBody({ entries, currentId: e.id, sections: toc, body }),
  });
}
