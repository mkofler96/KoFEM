// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Renders the public validation pages from one engine run (run.mjs --report):
//
//   web/validation/index.html          /validation/       overview + results
//   web/validation/<id>/index.html     /validation/<id>/  one page per case
//
// Every number comes from `data` — the object also written to
// web/public/validation/results.json — and every text from the case files
// (../cases/, the `page` block) and the textbook text (../textbook/). Static,
// crawlable and script-free; equations are MathML (./tex.mjs). The look
// follows the homepage (web/index.html, web/public/landing/landing.css).

import { consoleHeader, consoleRow, fmt } from "./format.mjs";
import { tex, texBlock } from "./tex.mjs";

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
  if (order === 1) return "linear 8-node hexahedra (P1)";
  if (order === 2) return "quadratic 27-node hexahedra (P2)";
  throw new Error(`no element name for order ${order}`);
}

const caseUrl = (id) => `/validation/${id}/`;

const band = (r) =>
  `<span class="band ${r.pass ? "pass" : "fail"}">${r.pass ? "✓ within" : "✗ outside"} ±${r.tolPct}&nbsp;%</span>`;

const openLink = (id, text, testid) =>
  `<a class="pill" href="/app/?example=${encodeURIComponent(id)}"${testid ? ` data-testid="${testid}"` : ""}>${esc(text)} <span aria-hidden="true">↗</span></a>`;

// ── Page chrome ───────────────────────────────────────────────────────────────

const GITHUB_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.37.5 0 5.78 0 12.29c0 5.2 3.44 9.6 8.21 11.16.6.11.82-.25.82-.56 0-.28-.01-1.02-.02-2-3.34.71-4.04-1.58-4.04-1.58-.55-1.37-1.34-1.74-1.34-1.74-1.08-.72.08-.71.08-.71 1.2.08 1.83 1.21 1.83 1.21 1.07 1.79 2.81 1.27 3.5.97.11-.76.42-1.27.76-1.56-2.67-.3-5.47-1.3-5.47-5.78 0-1.28.47-2.32 1.24-3.14-.12-.3-.54-1.52.12-3.16 0 0 1.01-.32 3.3 1.2a11.6 11.6 0 0 1 6 0c2.29-1.52 3.3-1.2 3.3-1.2.66 1.64.24 2.86.12 3.16.77.82 1.24 1.86 1.24 3.14 0 4.49-2.81 5.47-5.49 5.76.43.36.81 1.08.81 2.18 0 1.58-.01 2.85-.01 3.24 0 .31.22.68.83.56A12.02 12.02 0 0 0 24 12.29C24 5.78 18.63.5 12 .5z"></path></svg>`;

const STYLE = `
      :root {
        color-scheme: dark;
        --bg: #0c1015;
        --panel: #111820;
        --panel2: #16202b;
        --line: #1f2a35;
        --line2: #36424e;
        --text: #edf1f5;
        --body: #a0adb9;
        --muted: #82909e;
        --accent: #83b6ed;
        --pass: #6fcf97;
        --fail: #f28b82;
        --caution: #e5c07b;
        --s1: #4a90e2;
        --s2: #cf6d2c;
        --sans: "IBM Plex Sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
        --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, monospace;
        --serif: "STIX Two Text", "Cambria", "Times New Roman", serif;
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
        font-family: var(--sans);
        font-size: 16.5px;
        line-height: 1.7;
        background: var(--bg);
        color: var(--body);
        -webkit-font-smoothing: antialiased;
      }
      a {
        color: var(--accent);
        text-decoration: none;
      }
      main a:not(.pill):not(.card):not(.step) {
        text-decoration: underline;
        text-decoration-color: color-mix(in srgb, var(--accent) 35%, transparent);
        text-underline-offset: 3px;
      }
      a:hover {
        text-decoration-color: var(--accent);
      }
      a:focus-visible,
      summary:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 4px;
        border-radius: 4px;
      }
      @media (prefers-reduced-motion: reduce) {
        html {
          scroll-behavior: auto;
        }
      }

      /* Navigation, as on the homepage. */
      .navigation {
        position: sticky;
        top: 0;
        z-index: 20;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 22px 5.5vw;
        background: color-mix(in srgb, var(--bg) 88%, transparent);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
      }
      .wordmark {
        color: var(--text);
        font-weight: 600;
        font-size: 20px;
        letter-spacing: -0.01em;
      }
      .brand-dot {
        color: var(--accent);
      }
      .navigation-links {
        display: flex;
        align-items: center;
        gap: 24px;
        font-size: 12px;
        color: var(--muted);
      }
      .navigation-links a {
        color: var(--muted);
      }
      .navigation-links a:hover,
      .navigation-links a[aria-current] {
        color: var(--text);
      }
      .launch {
        color: var(--text) !important;
        border: 1px solid var(--line2);
        border-radius: 30px;
        padding: 10px 18px;
        white-space: nowrap;
      }
      .launch span {
        margin-left: 14px;
        color: var(--accent);
      }
      .launch:hover {
        background: #1b2733;
      }
      .github {
        display: flex;
      }
      .navigation-more {
        position: relative;
        margin: 0;
        font-size: inherit;
      }
      .navigation-more summary {
        cursor: pointer;
        list-style: none;
        color: var(--muted);
        font-size: inherit;
      }
      .navigation-more summary:hover {
        color: var(--text);
      }
      .navigation-more summary::-webkit-details-marker {
        display: none;
      }
      .navigation-more > div {
        position: absolute;
        right: 0;
        top: 28px;
        min-width: 145px;
        padding: 16px;
        border: 1px solid var(--line2);
        border-radius: 12px;
        background: var(--bg);
        display: grid;
        gap: 16px;
      }

      /* Article. */
      main {
        max-width: 780px;
        margin: 0 auto;
        padding: 48px 20px 96px;
      }
      .eyebrow {
        font-family: var(--mono);
        font-size: 11px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--accent);
        margin: 0 0 18px;
      }
      .eyebrow a {
        color: inherit;
        text-decoration: none !important;
      }
      h1 {
        color: var(--text);
        font-size: clamp(34px, 5.4vw, 54px);
        font-weight: 600;
        line-height: 1.1;
        letter-spacing: -0.015em;
        margin: 0 0 22px;
      }
      h2 {
        color: var(--text);
        font-size: 24px;
        font-weight: 600;
        letter-spacing: -0.01em;
        line-height: 1.25;
        margin: 72px 0 18px;
        padding-top: 22px;
        border-top: 1px solid var(--line);
        scroll-margin-top: 90px;
      }
      h3 {
        color: var(--text);
        font-size: 17px;
        font-weight: 600;
        margin: 0;
      }
      p {
        margin: 0 0 16px;
      }
      .lede p,
      p.lede {
        font-size: 19px;
        line-height: 1.6;
        color: var(--body);
      }
      em {
        color: var(--text);
        font-style: italic;
      }
      code,
      pre {
        font-family: var(--mono);
      }
      p code {
        font-size: 0.86em;
        color: var(--text);
        background: var(--panel2);
        border-radius: 5px;
        padding: 1px 6px;
      }
      .meta {
        font-family: var(--mono);
        font-size: 12px;
        color: var(--muted);
      }
      .meta a {
        color: var(--muted);
      }
      math {
        color: var(--text);
        font-family: "STIX Two Math", "Cambria Math", "Latin Modern Math", math;
        font-size: 1.08em;
      }
      math[display="block"] {
        margin: 20px 0 22px;
        padding: 4px 0;
        overflow-x: auto;
        overflow-y: hidden;
        font-size: 1.18em;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        font-size: 13px;
        color: var(--text);
        border: 1px solid var(--line2);
        border-radius: 30px;
        padding: 8px 16px;
        white-space: nowrap;
      }
      .pill span {
        color: var(--accent);
      }
      .pill:hover {
        background: #1b2733;
      }
      .open-app {
        margin: 18px 0 0;
      }
      .callout {
        border: 1px solid var(--line);
        border-left: 2px solid var(--caution);
        border-radius: 10px;
        padding: 12px 16px;
        margin: 22px 0 0;
        font-size: 14.5px;
      }
      .callout strong {
        color: var(--text);
        font-weight: 500;
      }
      .note {
        border-left: 2px solid var(--caution);
        padding-left: 14px;
      }

      /* Key numbers. */
      .stats {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
        margin: 30px 0 0;
      }
      .stat {
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 14px 16px;
        background: var(--panel);
      }
      .stat-label {
        font-family: var(--mono);
        font-size: 10.5px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .stat-value {
        font-family: var(--mono);
        font-size: 17px;
        color: var(--text);
        margin-top: 4px;
        overflow-wrap: anywhere;
      }
      .stat-value sup,
      table sup {
        line-height: 0;
      }
      .stat .band {
        display: block;
        margin: 2px 0 0;
      }
      .band {
        font-size: 12.5px;
      }
      .band.pass {
        color: var(--pass);
      }
      .band.fail {
        color: var(--fail);
      }

      /* Tables. */
      .table-wrap {
        overflow-x: auto;
        border: 1px solid var(--line);
        border-radius: 12px;
        margin: 18px 0;
      }
      table.data {
        width: 100%;
        border-collapse: collapse;
        font-size: 14px;
      }
      table.data th,
      table.data td {
        padding: 9px 14px;
        text-align: left;
        border-bottom: 1px solid var(--line);
        white-space: nowrap;
      }
      table.data thead th {
        font-family: var(--mono);
        font-size: 10.5px;
        font-weight: 400;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--muted);
        background: var(--panel);
      }
      table.data tbody tr:last-child th,
      table.data tbody tr:last-child td {
        border-bottom: 0;
      }
      table.data tbody th {
        font-weight: 500;
        color: var(--text);
      }
      table.data tbody th a {
        color: var(--text);
      }
      table.results tbody th {
        white-space: normal;
      }
      table.data .num {
        text-align: right;
        font-family: var(--mono);
        font-size: 13px;
        font-variant-numeric: tabular-nums;
        color: var(--text);
      }
      table.data tr.ci td {
        background: color-mix(in srgb, var(--accent) 8%, transparent);
      }
      table.spec {
        border-collapse: collapse;
        width: 100%;
        font-size: 15px;
        margin: 8px 0 18px;
      }
      table.spec th {
        text-align: left;
        vertical-align: top;
        font-weight: 500;
        color: var(--text);
        padding: 7px 18px 7px 0;
        width: 120px;
        border-bottom: 1px solid var(--line);
      }
      table.spec td {
        padding: 7px 0;
        border-bottom: 1px solid var(--line);
      }

      /* Case cards on the overview. */
      .cards {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
        margin: 22px 0 0;
      }
      .card {
        display: flex;
        flex-direction: column;
        gap: 6px;
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 16px 18px;
        background: var(--panel);
        color: var(--body);
        font-size: 14.5px;
        line-height: 1.55;
      }
      .card:hover {
        border-color: var(--line2);
        background: var(--panel2);
      }
      .card h3 {
        font-size: 16px;
      }
      .card .card-foot {
        margin-top: auto;
        padding-top: 6px;
        display: flex;
        justify-content: space-between;
        gap: 10px;
        font-family: var(--mono);
        font-size: 12px;
        color: var(--muted);
      }
      .card .card-foot span:last-child {
        color: var(--accent);
      }

      /* Figures. */
      figure {
        margin: 22px 0;
      }
      figure.diagram,
      figure.chart {
        border: 1px solid var(--line);
        border-radius: 16px;
        background: var(--panel);
        padding: 14px 16px 10px;
      }
      figure svg {
        display: block;
        width: 100%;
        height: auto;
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
      figcaption {
        font-size: 13px;
        color: var(--muted);
        margin-top: 8px;
      }
      svg.fig .body {
        fill: var(--panel2);
        stroke: #8fa3b5;
        stroke-width: 1.4;
      }
      svg.fig .body.top {
        fill: #1b2733;
      }
      svg.fig .body.end {
        fill: #1f2d3b;
      }
      svg.fig .hole {
        fill: var(--panel);
        stroke: #8fa3b5;
        stroke-width: 1.4;
      }
      svg.fig .mesh {
        stroke: #2c3b4a;
        stroke-width: 0.7;
        fill: none;
      }
      svg.fig .clamp {
        fill: url(#hatch);
      }
      svg.fig .hatch {
        stroke: #5f6d7a;
        stroke-width: 1.2;
      }
      svg.fig .wall {
        stroke: #8fa3b5;
        stroke-width: 2;
      }
      svg.fig .load {
        stroke: var(--accent);
        stroke-width: 1.8;
        fill: none;
      }
      svg.fig .m-load {
        fill: var(--accent);
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
        stroke: #3d4a57;
        stroke-width: 1;
      }
      svg.fig .deformed {
        stroke: var(--s2);
        stroke-width: 1.5;
        stroke-dasharray: 5 4;
        fill: none;
      }
      svg.fig .axis {
        stroke: #4a5866;
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
        font-family: var(--serif);
        font-style: italic;
        font-size: 16px;
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
        fill: var(--accent);
        font-size: 17px;
        font-weight: 600;
      }
      svg.fig .pt {
        fill: var(--accent);
        stroke: var(--bg);
        stroke-width: 1.5;
      }
      svg.fig .curve {
        stroke: var(--accent);
        stroke-width: 2;
        fill: none;
      }
      svg.fig .chart-axis {
        stroke: var(--line2);
      }
      svg.fig .chart-grid {
        stroke: var(--line);
      }

      /* Convergence charts. */
      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 18px;
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
      svg.conv .ci-label {
        fill: var(--text);
        font-size: 9.5px;
        font-weight: 600;
        font-family: var(--mono);
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
        stroke: var(--panel);
      }
      svg.conv .mark.s2.under {
        fill: var(--s2);
        stroke: var(--panel);
      }
      svg.conv .mark.over {
        fill: var(--panel);
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
      svg.conv g:hover .mark {
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

      /* Reproduce. */
      pre {
        font-size: 12.5px;
        line-height: 1.6;
        color: var(--text);
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 12px 16px;
        overflow-x: auto;
        margin: 10px 0 16px;
      }
      pre.console {
        font-size: 11px;
      }
      .readout {
        font-family: var(--mono);
        font-size: 13.5px;
        color: var(--text);
        background: var(--panel2);
        border-radius: 6px;
        padding: 1px 7px;
        white-space: nowrap;
      }
      ol.refs {
        padding-left: 20px;
        font-size: 14.5px;
      }
      ol.refs li {
        margin: 0 0 8px;
      }
      cite {
        font-style: italic;
        color: var(--text);
      }

      /* Previous / next case. */
      .pager {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
        margin: 72px 0 0;
      }
      .step {
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 14px 18px;
        color: var(--text);
      }
      .step:hover {
        border-color: var(--line2);
        background: var(--panel);
      }
      .step small {
        display: block;
        font-family: var(--mono);
        font-size: 10.5px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .step.next {
        text-align: right;
        grid-column: 2;
      }

      footer {
        border-top: 1px solid var(--line);
        padding: 26px 5.5vw 34px;
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 12px 24px;
        font-size: 12px;
        color: var(--muted);
      }
      footer nav {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 20px;
      }
      footer a {
        color: var(--muted);
      }
      footer a:hover {
        color: var(--text);
      }

      @media (max-width: 700px) {
        body {
          font-size: 16px;
        }
        .navigation {
          padding: 16px 16px;
        }
        .navigation-links {
          gap: 12px;
          font-size: 11px;
        }
        .launch {
          padding: 8px 12px;
        }
        .launch span {
          margin-left: 6px;
        }
        .github {
          display: none;
        }
        main {
          padding: 32px 16px 72px;
        }
        .lede p,
        p.lede {
          font-size: 17px;
        }
        h2 {
          margin-top: 56px;
        }
        .stats {
          grid-template-columns: 1fr;
        }
        .cards {
          grid-template-columns: 1fr;
        }
        table.spec th {
          width: 92px;
          padding-right: 10px;
        }
        figure.diagram,
        figure.chart {
          padding: 10px 8px 8px;
        }
        /* Sketches keep a legible scale and scroll inside their frame. */
        figure.diagram {
          overflow-x: auto;
        }
        figure.diagram > svg.fig {
          min-width: 540px;
        }
        footer {
          padding: 22px 16px 30px;
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
          padding: 10px 14px;
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
          font-size: 12px;
        }
        table.results td::before {
          content: attr(data-label);
          display: block;
          font-family: var(--mono);
          font-size: 10px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--muted);
        }
      }`;

function header(current) {
  return `<header class="navigation">
      <a class="wordmark" href="/" aria-label="KoFEM home">KoFEM<span class="brand-dot">.</span></a>
      <nav class="navigation-links" aria-label="Main navigation">
        <a href="/examples/">Examples</a>
        <a href="/validation/" aria-current="${current}">Validation</a>
        <details class="navigation-more">
          <summary>More</summary>
          <div>
            <a href="/privacy/">Privacy</a><a href="#cookie-settings" id="kofem-cookie-settings">Cookie settings</a>
          </div>
        </details>
        <a class="github" href="${REPO}" target="_blank" rel="noopener" aria-label="KoFEM on GitHub">${GITHUB_ICON}</a>
        <a class="launch" href="/app/">Start Solver <span aria-hidden="true">↗</span></a>
      </nav>
    </header>`;
}

const FOOTER = `<footer>
      <span>KoFEM — finite element analysis in your browser</span>
      <nav aria-label="Footer">
        <a href="/">Home</a>
        <a href="/examples/">Examples</a>
        <a href="/validation/">Validation</a>
        <a href="/privacy/">Privacy</a>
        <a href="${REPO}">GitHub</a>
      </nav>
    </footer>`;

/** A complete static page. */
function layout({
  title,
  socialTitle,
  description,
  path,
  current,
  jsonLd,
  body,
}) {
  const url = `${SITE}${path}`;
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
    <meta property="og:title" content="${esc(socialTitle)}" />
    <meta property="og:description" content="${esc(description)}" />
    <meta property="og:url" content="${url}" />
    <meta property="og:image" content="${SITE}/kofem_logo.svg" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="${esc(socialTitle)}" />
    <meta name="twitter:description" content="${esc(description)}" />
    <meta name="twitter:image" content="${SITE}/kofem_logo.svg" />

    <!-- Self-hosted fonts (SIL OFL) — see public/fonts/README.md -->
    <link href="/fonts/ibm-plex.css" rel="stylesheet" />

    <script type="application/ld+json">
${JSON.stringify(jsonLd, null, 2)
  .split("\n")
  .map((l) => `      ${l}`)
  .join("\n")}
    </script>

    <style>${STYLE}
    </style>
  </head>
  <body>
    ${header(current)}
    <main>${body}
    </main>
    ${FOOTER}
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

// ── Results table ─────────────────────────────────────────────────────────────

function resultsTable(rows) {
  const body = rows
    .map(
      (r) => `
            <tr>
              <th scope="row"><a href="${caseUrl(r.id)}">${esc(r.name)}</a></th>
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

const DISCLAIMER = `<p class="callout" data-testid="disclaimer">
        <strong>Research software, not certified for safety-critical design.</strong>
        Linear-static, linear-elastic solids only. These cases use structured
        hex meshes, not the app's tetrahedral meshing. Check results that
        matter against your own references.
      </p>`;

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

  return `<svg class="conv" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${study.title}: relative error against degrees of freedom, logarithmic axes`)}">
            <text class="axis-title" x="${PAD.l}" y="${PAD.t - 11}">|error| %</text>
            ${grid.join("\n            ")}
            <line class="axis" x1="${PAD.l}" x2="${PAD.l + pw}" y1="${PAD.t + ph}" y2="${PAD.t + ph}"/>
            <line class="axis" x1="${PAD.l}" x2="${PAD.l}" y1="${PAD.t}" y2="${PAD.t + ph}"/>
            ${tol}
            ${series}
            <text class="axis-title" x="${PAD.l + pw}" y="${H - 5}" text-anchor="end">degrees of freedom</text>
          </svg>`;
}

function convergenceSection(study, def, caseRow) {
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
      <section class="study" id="convergence" data-study="${study.id}">
        <h3>Mesh convergence: ${esc(study.title)}</h3>
        <figure class="chart">
          <div class="legend">${legend}<span class="key"><span class="dot under"></span>below reference</span><span class="key"><span class="dot over"></span>above</span></div>
          ${chart(study, caseRow.tolPct)}
          <figcaption>Error against degrees of freedom on refined meshes, logarithmic axes. CI marks the mesh a case is gated on.</figcaption>
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

// ── Reproduction ──────────────────────────────────────────────────────────────

const cloneSteps = (
  args,
) => `<pre><code>git clone ${REPO}.git &amp;&amp; cd KoFEM
bash scripts/fetch-wasm-engine.sh
node examples/validation/run.mjs${args}</code></pre>`;

/** The in-app reproduction of the published axial-bar value. */
function appReproduction(app, appCase) {
  return `<p>
        In the app: ${openLink(app.galleryId, `Open ${app.title}`, "reproduce-open")}
        then run Studies → Static 1 → Run static solve, select the result plot
        and set Field to ${esc(app.field)}. The Result summary shows
        <span class="readout" data-testid="app-readout" data-stat="${esc(app.stat)}" data-value="${esc(app.appReadout)}">${esc(app.stat)} ${esc(app.appReadout)}</span>;
        the end-face mean, ${withUnit(num(app.faceMean), app.unit)}, is the
        <a href="${caseUrl(appCase.id)}">${esc(appCase.name)}</a> result in mm.
      </p>`;
}

// ── Overview: /validation/ ────────────────────────────────────────────────────

export function renderValidationPage(data, { cases }) {
  const pageById = new Map(cases.map((c) => [c.id, c.page]));
  const rowsById = new Map(data.cases.map((r) => [r.id, r]));
  const passed = data.cases.filter((r) => r.pass).length;
  const app = data.reproduce;
  const appCase = rowsById.get(app.caseId);
  if (!appCase)
    throw new Error(`reproduction refers to unknown case "${app.caseId}"`);
  const description = `KoFEM's finite element solver against ${data.cases.length} textbook benchmarks with known answers: reference, KoFEM result, error, a derivation per case and how to reproduce them.`;

  const cards = data.cases
    .map((r) => {
      const page = pageById.get(r.id);
      if (!page) throw new Error(`no page text for case "${r.id}"`);
      return `
        <a class="card" href="${caseUrl(r.id)}" data-case="${r.id}">
          <h3>${esc(r.name)}</h3>
          <span>${esc(page.summary)}</span>
          <span class="card-foot"><span data-testid="case-error">${errHtml(r.errPct)}</span><span>Read →</span></span>
        </a>`;
    })
    .join("");

  const body = `
      <p class="eyebrow">Validation</p>
      <h1>Validation benchmarks</h1>
      <p class="lede">
        Textbook problems with known answers, solved by the engine the app
        runs. Each case has its own page with the derivation, the model and a
        discussion of the result.
      </p>
      <p class="meta">
        ${passed} of ${data.cases.length} within their CI band ·
        engine ${esc(data.engine)} · ${esc(data.generated)} ·
        <a href="/validation/results.json">results.json</a> ·
        <a href="${REPO}/blob/main/examples/validation/README.md">source</a>
      </p>
      ${resultsTable(data.cases)}
      <p class="meta">Error = (KoFEM − reference) / reference.</p>
      ${DISCLAIMER}
      <h2 id="cases">Cases</h2>
      <div class="cards">${cards}
      </div>
      <h2 id="reproduce">Reproduce</h2>
      <p>From a clone (Node.js 20+, bash, curl):</p>
      ${cloneSteps("")}
      <p>prints every case, for example:</p>
      <pre class="console" data-testid="console-line"><code>${esc(consoleHeader())}
${esc(consoleRow(appCase))}</code></pre>
      ${appReproduction(app, appCase)}`;

  return layout({
    title: "Validation benchmarks — KoFEM Online Finite Element Solver",
    socialTitle: "Validation benchmarks — KoFEM",
    description,
    path: "/validation/",
    current: "page",
    jsonLd: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "CollectionPage",
          name: "KoFEM validation benchmarks",
          description,
          url: `${SITE}/validation/`,
          dateModified: data.generated,
          hasPart: data.cases.map((r) => ({
            "@type": "TechArticle",
            headline: r.name,
            url: `${SITE}${caseUrl(r.id)}`,
          })),
        },
        breadcrumbs([
          ["KoFEM", "/"],
          ["Validation", "/validation/"],
        ]),
      ],
    },
    body,
  });
}

// ── One case: /validation/<id>/ ───────────────────────────────────────────────

/** Case inputs by symbol: numbers, and "a × b" strings as [a, b]. */
function inputGetter(row) {
  const inputs = new Map(row.inputs.map((i) => [i.symbol, i.value]));
  return (symbol) => {
    if (!inputs.has(symbol))
      throw new Error(`case "${row.id}" has no input "${symbol}"`);
    const v = inputs.get(symbol);
    if (typeof v === "number") return v;
    const parts = String(v).split("×").map(Number);
    if (parts.length < 2 || parts.some((x) => !Number.isFinite(x)))
      throw new Error(
        `case "${row.id}": input "${symbol}" = "${v}" is not a number or a × b`,
      );
    return parts;
  };
}

/** What a textbook function gets: the case's data and formatting helpers. */
function caseContext(row, page, data, studies) {
  const rowsById = new Map(data.cases.map((r) => [r.id, r]));
  const rowOf = (id) => {
    const r = rowsById.get(id);
    if (!r)
      throw new Error(`case page "${row.id}" refers to unknown case "${id}"`);
    return r;
  };
  const study =
    data.convergence.find((s) => s.series.some((x) => x.caseId === row.id)) ??
    null;
  const studyDef = study ? studies.find((s) => s.id === study.id) : null;
  if (study && !studyDef)
    throw new Error(`no study definition for "${study.id}"`);
  return {
    row,
    page,
    rowOf,
    inp: inputGetter(row),
    inpOf: (id, symbol) => inputGetter(rowOf(id))(symbol),
    study,
    studyDef,
    tex,
    texBlock,
    n: numTex,
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

function inputsTable(row) {
  const body = row.inputs
    .map(
      (i) => `
            <tr><th scope="row">${tex(symbolTex(i.symbol))}</th><td>${inputValue(i.value, i.unit)}</td></tr>`,
    )
    .join("");
  return `<table class="spec inputs">${body}
        </table>`;
}

export function renderCasePage(data, { cases, studies, textbook }, id) {
  const index = data.cases.findIndex((r) => r.id === id);
  if (index < 0) throw new Error(`no published row for case "${id}"`);
  const row = data.cases[index];
  const def = cases.find((c) => c.id === id);
  if (!def) throw new Error(`no case definition for "${id}"`);
  const text = textbook.get(id);
  if (!text)
    throw new Error(
      `no textbook text for case "${id}" (examples/validation/textbook/)`,
    );
  const page = def.page;
  const ctx = caseContext(row, page, data, studies);
  const m = row.mesh;
  const literal = row.referenceLabel.includes(String(row.reference));
  const prev = data.cases[index - 1];
  const next = data.cases[index + 1];
  const app = data.reproduce;

  const body = `
      <p class="eyebrow"><a href="/validation/">Validation</a> / Benchmark ${index + 1} of ${data.cases.length}</p>
      <h1>${esc(row.name)}</h1>
      <div class="lede">${text.intro(ctx)}
      </div>
      <div class="stats" data-case="${row.id}">
        <div class="stat">
          <div class="stat-label">Reference</div>
          <div class="stat-value">${withUnit(num(row.reference), row.unit)}</div>
        </div>
        <div class="stat">
          <div class="stat-label">KoFEM</div>
          <div class="stat-value" data-testid="fe-value">${withUnit(num(row.fe), row.unit)}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Error</div>
          <div class="stat-value">${errHtml(row.errPct)}</div>
          ${band(row)}
        </div>
      </div>
      ${page.gallery ? `<p class="open-app">${openLink(page.gallery, "Open this model in KoFEM", "open-in-app")}</p>` : ""}

      <h2 id="problem">The problem</h2>
      <figure class="diagram">
        ${text.figure(ctx)}
        <figcaption>${esc(page.model)} Sketch, not to scale${page.grid ? "; faint lines show the element mesh" : ""}.</figcaption>
      </figure>
      ${inputsTable(row)}
      <table class="spec">
        <tr><th scope="row">Supports</th><td>${esc(page.supports)}</td></tr>
        <tr><th scope="row">Load</th><td>${esc(page.loads)}</td></tr>
        <tr><th scope="row">Measured</th><td>${esc(page.measured)}</td></tr>
      </table>

      <h2 id="theory">Analytical solution</h2>${text.theory(ctx)}

      <h2 id="model">Finite element model</h2>
      <table class="spec">
        <tr><th scope="row">Mesh</th><td>${esc(page.mesh)}: ${int(m.elements)} ${elementName(m.order)}</td></tr>
        <tr><th scope="row">Unknowns</th><td>${int(m.nodes)} nodes, ${int(m.dofs)} degrees of freedom</td></tr>
        <tr><th scope="row">Material</th><td>Linear elastic, isotropic</td></tr>
        <tr><th scope="row">Solver</th><td>KoFEM engine (MFEM), the same WebAssembly build the app runs: ${esc(data.engine)}</td></tr>
      </table>${text.model(ctx)}

      <h2 id="results">Results</h2>
      <table class="spec">
        <tr><th scope="row">Quantity</th><td>${esc(row.quantity)}</td></tr>
        <tr><th scope="row">Reference</th><td>${esc(row.referenceLabel)}${literal ? "" : ` = ${withUnit(num(row.reference), row.unit)}`} <span class="meta">(${esc(page.source)})</span></td></tr>
        <tr><th scope="row">KoFEM</th><td>${withUnit(num(row.fe), row.unit)}</td></tr>
        <tr><th scope="row">Error</th><td>${errHtml(row.errPct)} ${band(row)}</td></tr>
      </table>${page.note ? `\n      <p class="note">${esc(page.note)}</p>` : ""}${ctx.study ? convergenceSection(ctx.study, ctx.studyDef, row) : ""}

      <h2 id="discussion">Discussion</h2>${text.discussion(ctx)}

      <h2 id="reproduce">Reproduce</h2>
      <p>From a clone (Node.js 20+, bash, curl), this solves the case with
      the same engine and prints its line:</p>
      ${cloneSteps(` --case ${row.id}`)}
      <pre class="console"><code>${esc(consoleHeader())}
${esc(consoleRow(row))}</code></pre>${app.caseId === row.id ? `\n      ${appReproduction(app, row)}` : ""}

      <h2 id="references">References</h2>
      <ol class="refs">${text.references.map((r) => `\n        <li>${r}</li>`).join("")}
      </ol>
      ${DISCLAIMER}

      <nav class="pager" aria-label="Other benchmarks">${prev ? `\n        <a class="step prev" href="${caseUrl(prev.id)}"><small>Previous</small>${esc(prev.name)}</a>` : ""}${next ? `\n        <a class="step next" href="${caseUrl(next.id)}"><small>Next</small>${esc(next.name)}</a>` : ""}
      </nav>`;

  const title = `${row.name} — Validation benchmark | KoFEM`;
  return layout({
    title,
    socialTitle: `${row.name} — KoFEM validation`,
    description: text.description,
    path: caseUrl(row.id),
    current: "true",
    jsonLd: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "TechArticle",
          headline: row.name,
          description: text.description,
          url: `${SITE}${caseUrl(row.id)}`,
          dateModified: data.generated,
          isPartOf: { "@type": "CollectionPage", url: `${SITE}/validation/` },
          publisher: { "@type": "Organization", name: "KoFEM", url: SITE },
        },
        breadcrumbs([
          ["KoFEM", "/"],
          ["Validation", "/validation/"],
          [row.name, caseUrl(row.id)],
        ]),
      ],
    },
    body,
  });
}
