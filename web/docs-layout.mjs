// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Shared reading layout, typography, MathML font and theme for Examples and Theory.
import { readFileSync } from "node:fs";

const SITE = "https://kofem.org";

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// The KoFEM Math face, shared by the pages and the figure files.
const MATH_FONT_FACE = `@font-face {
        font-family: "KoFEM Math";
        font-style: normal;
        font-weight: 400;
        font-display: swap;
        src: url(/fonts/kofem-math.woff2) format("woff2");
      }`;

// Custom properties: shared, then the light palette (the default) and the
// dark theme's additions to the site palette of web/public/site.css.
const ROOT_VARIABLES = `
        --math: "KoFEM Math", math;
      `;
const LIGHT_VARIABLES = `
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
      `;
const DARK_VARIABLES = `
        --pass: #6fcf97;
        --fail: #f28b82;
        --caution: #e5c07b;
        --s1: #4a90e2;
        --s2: #cf6d2c;
      `;

// The inside of the diagrams (svg.fig) and charts (svg.conv) of the example
// pages. Pages show them as image files: figure-assets.mjs writes this CSS,
// with one theme's colours resolved, into each file.
const FIGURE_SVG_STYLE = `
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
      }`;
const FIGURE_SVG_DARK_STYLE = `
      svg.fig .body,
      svg.fig .hole,
      svg.fig .wall {
        stroke: #8fa3b5;
      }
      svg.fig .body.top {
        fill: #1b2733;
      }
      svg.fig .body.end {
        fill: #1f2d3b;
      }
      svg.fig .mesh {
        stroke: #2c3b4a;
      }
      svg.fig .hatch {
        stroke: #5f6d7a;
      }
      svg.fig .ext {
        stroke: #3d4a57;
      }
      svg.fig .axis {
        stroke: #4a5866;
      }`;

/** The figure CSS for one theme, still with var() references. */
export const figureSvgStyle = (theme) =>
  theme === "dark"
    ? `${FIGURE_SVG_STYLE}${FIGURE_SVG_DARK_STYLE}`
    : FIGURE_SVG_STYLE;

const declarations = (css) =>
  new Map(
    [...css.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map(([, name, value]) => [
      name,
      value.trim(),
    ]),
  );

/** One theme's custom properties, as the page resolves them. */
export function themeVariables(theme) {
  const site = readFileSync(
    new URL("./public/site.css", import.meta.url),
    "utf8",
  );
  const siteRoot = site.match(/^:root\s*\{([^}]*)\}/m);
  if (!siteRoot) throw new Error("web/public/site.css has no :root block");
  return new Map([
    ...declarations(siteRoot[1]),
    ...declarations(ROOT_VARIABLES),
    ...declarations(theme === "dark" ? DARK_VARIABLES : LIGHT_VARIABLES),
  ]);
}

const unicodeRanges = (value) =>
  value.split(",").map((range) => {
    const [lo, hi = lo] = range.trim().replace(/^U\+/i, "").split("-");
    return [parseInt(lo, 16), parseInt(hi, 16)];
  });

/**
 * The page fonts as { family, weight, file, ranges }: the IBM Plex faces of
 * web/public/fonts/ibm-plex.css and KoFEM Math. `file` is relative to web/.
 */
export const FIGURE_FONT_FACES = [
  ...readFileSync(
    new URL("./public/fonts/ibm-plex.css", import.meta.url),
    "utf8",
  ).matchAll(/@font-face\s*\{([^}]*)\}/g),
  ...MATH_FONT_FACE.matchAll(/@font-face\s*\{([^}]*)\}/g),
].map(([, rule]) => {
  const field = (name) =>
    rule.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();
  const src = field("src")?.match(/url\(\/fonts\/([^)]+)\)/)?.[1];
  if (!src) throw new Error(`Font face without a /fonts/ source: ${rule}`);
  const range = field("unicode-range");
  return {
    family: field("font-family").replace(/^["']|["']$/g, ""),
    weight: Number(field("font-weight") ?? 400),
    file: `public/fonts/${src}`,
    ranges: range ? unicodeRanges(range) : null,
  };
});

const STYLE = `
      /* Equations and figure symbols: a subset of New Computer Modern Math,
         the LaTeX look (web/public/fonts/README.md). */
      ${MATH_FONT_FACE}
      /* Light by default, under the site's variable names
         (web/public/site.css), so the shared header and footer follow it:
         --text for headings and numbers, --body for prose, --accent for
         links. The dark theme (data-theme="dark", the theme switch) is the
         site's own palette. */
      :root {${ROOT_VARIABLES}}
      :root:not([data-theme="dark"]) {${LIGHT_VARIABLES}}
      :root[data-theme="dark"] {${DARK_VARIABLES}}
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
      /* Diagrams and charts are image files (figure-assets.mjs): one
         <picture> per theme, the other hidden and never fetched. */
      picture.figure-image {
        display: block;
      }
      picture.figure-image img {
        display: block;
        width: 100%;
        height: auto;
      }
      picture.figure-image.theme-dark,
      :root[data-theme="dark"] picture.figure-image.theme-light {
        display: none;
      }
      :root[data-theme="dark"] picture.figure-image.theme-dark {
        display: block;
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
      .fig-row picture.half {
        flex: 1 1 280px;
        max-width: 100%;
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
      figure.chart picture.conv img {
        max-width: 560px;
        margin: 0 auto;
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
        figure.diagram > picture.fig img {
          min-width: 540px;
        }
      }`;

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
export function renderDocsPage({
  title,
  description,
  path,
  image,
  jsonLd,
  body,
  generatedBy = "examples/validation/run.mjs --report",
}) {
  const url = `${SITE}${path}`;
  // Social previews need a raster image; pages without their own figure share
  // the site card (web/public/og-image.png, `bun run capture:og`).
  const img = `${SITE}${image ?? "/og-image.png"}`;
  return `<!doctype html>
<!--
  Generated by ${generatedBy}. Do not edit by hand; edit the generator sources.
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
    <meta name="twitter:card" content="summary_large_image" />
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
