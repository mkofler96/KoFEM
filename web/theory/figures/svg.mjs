// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Shared drawing vocabulary for the Theory Guide figures. figures/index.mjs
// publishes each as a standalone SVG with the site fonts embedded and a PNG
// (web/figure-assets.mjs). Colours are for a light background; theory.css
// inverts them for the dark theme.

import { italic } from "../../../examples/validation/lib/figures.mjs";

const fmt = (value) => {
  if (!Number.isFinite(value))
    throw new Error(`Non-finite coordinate ${value}`);
  return String(Math.round(value * 100) / 100);
};
export const n = fmt;

const escapeXml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export const esc = escapeXml;

export const palette = {
  ink: "#1f2933",
  muted: "#5f6b7a",
  faint: "#9aa5b1",
  body: "#dce8f4",
  bodyDark: "#c3d5e8",
  bodyAlt: "#eef2f6",
  mesh: "#3e4c5b",
  load: "#c62828",
  accent: "#1d5bbf",
  accent2: "#c4561f",
  accent3: "#2e7d32",
  accent4: "#7b3fa0",
};

const style = `
  text { font-family: "IBM Plex Sans", "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 13px; fill: ${palette.ink}; }
  .sym { font-family: "KoFEM Math", math; font-size: 17px; }
  .m { font-family: "KoFEM Math", math; }
  .sym.bold { font-weight: 400; }
  .bold { font-weight: 700; }
  .halo { paint-order: stroke; stroke: #ffffff; stroke-width: 4px; stroke-linejoin: round; }
  .small { font-size: 11px; }
  .lbl { fill: ${palette.muted}; }
  .title { font-size: 14px; font-weight: 600; }
  .load-text { fill: ${palette.load}; font-weight: 700; }
  .accent-text { fill: ${palette.accent}; }
  .accent2-text { fill: ${palette.accent2}; }
  .body { fill: ${palette.body}; stroke: ${palette.ink}; stroke-width: 1.6; stroke-linejoin: round; }
  .body-alt { fill: ${palette.bodyAlt}; stroke: ${palette.ink}; stroke-width: 1.4; stroke-linejoin: round; }
  .side { fill: ${palette.bodyDark}; stroke: ${palette.ink}; stroke-width: 1.2; stroke-linejoin: round; }
  .outline { fill: none; stroke: ${palette.ink}; stroke-width: 1.6; stroke-linejoin: round; }
  .mesh { fill: none; stroke: ${palette.mesh}; stroke-width: 0.8; stroke-linejoin: round; }
  .ink { fill: none; stroke: ${palette.ink}; stroke-width: 1.3; }
  .thin { fill: none; stroke: ${palette.ink}; stroke-width: 0.8; }
  .dash { fill: none; stroke: ${palette.muted}; stroke-width: 1; stroke-dasharray: 5 4; }
  .grid { fill: none; stroke: #d5dbe2; stroke-width: 0.8; }
  .axis { fill: none; stroke: ${palette.ink}; stroke-width: 1.2; }
  .dim { fill: none; stroke: ${palette.muted}; stroke-width: 1; }
  .load { fill: none; stroke: ${palette.load}; stroke-width: 2; }
  .accent { fill: none; stroke: ${palette.accent}; stroke-width: 2; }
  .accent2 { fill: none; stroke: ${palette.accent2}; stroke-width: 2; }
  .accent3 { fill: none; stroke: ${palette.accent3}; stroke-width: 2; }
  .accent4 { fill: none; stroke: ${palette.accent4}; stroke-width: 2; }
  .node { fill: ${palette.ink}; }
  .node-open { fill: #ffffff; stroke: ${palette.ink}; stroke-width: 1.4; }
  .node-accent { fill: ${palette.accent2}; }
  .gauss { fill: ${palette.load}; }
  .hatch-fill { fill: url(#hatch); stroke: none; }
  .ground { fill: none; stroke: ${palette.ink}; stroke-width: 1.6; }
`;

// Arrowheads in each stroke colour. Use with marker-end="url(#a-<name>)".
const markers = Object.entries({
  ink: palette.ink,
  muted: palette.muted,
  load: palette.load,
  accent: palette.accent,
  accent2: palette.accent2,
  accent3: palette.accent3,
  accent4: palette.accent4,
})
  .map(
    ([name, colour]) =>
      `<marker id="a-${name}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${colour}"/></marker>`,
  )
  .join("");

const defs = `<defs>${markers}<pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="7" stroke="${palette.muted}" stroke-width="1.2"/></pattern></defs>`;

/** The CSS and shared <defs> of every Theory figure (figures/index.mjs). */
export const FIGURE_STYLE = style;
export const FIGURE_DEFS = defs;

// ── Primitives ────────────────────────────────────────────────────────────────

export const path = (d, cls, extra = "") =>
  `<path d="${d}" class="${cls}"${extra ? ` ${extra}` : ""}/>`;

export const polyline = (points, cls, extra = "") =>
  `<polyline points="${points.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" ")}" class="${cls}"${extra ? ` ${extra}` : ""}/>`;

export const polygon = (points, cls, extra = "") =>
  `<polygon points="${points.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" ")}" class="${cls}"${extra ? ` ${extra}` : ""}/>`;

export const line = ([x1, y1], [x2, y2], cls, extra = "") =>
  `<line x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}" class="${cls}"${extra ? ` ${extra}` : ""}/>`;

/** A straight arrow; `colour` picks both stroke class and arrowhead. */
export const arrow = (from, to, colour = "ink", extra = "") =>
  line(
    from,
    to,
    colour === "ink" ? "ink" : colour === "muted" ? "dim" : colour,
    `marker-end="url(#a-${colour})"${extra ? ` ${extra}` : ""}`,
  );

export const doubleArrow = (from, to, colour = "muted") =>
  line(
    from,
    to,
    colour === "muted" ? "dim" : colour,
    `marker-start="url(#a-${colour})" marker-end="url(#a-${colour})"`,
  );

export const circle = ([x, y], r, cls) =>
  `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${fmt(r)}" class="${cls}"/>`;

export const dot = (p, r = 3.2, cls = "node") => circle(p, r, cls);

// Symbols are set in the math font's italic letters, as in LaTeX, rather
// than slanted by a renderer: the site fonts have no italic face, and the
// PNG renderer does not synthesise one. The math font has one weight, so a
// "bold" symbol stays regular (.sym.bold below) in the browser and the PNG.
export const mathLetters = (value) =>
  value.replace(/[A-Za-zΑ-Ωα-ω]/g, (c) => italic(c));

// An oblique label: the same 12° slant a browser gives a font without italic.
const oblique = (x, y) =>
  `transform="translate(${fmt(x)} ${fmt(y)}) skewX(-12) translate(${fmt(-x)} ${fmt(-y)})"`;

/**
 * Text at a point. `anchor` is start | middle | end; `cls` adds classes.
 * Subscripts: pass [base, sub] as `content` to typeset base with a lowered
 * sub. With class "sym", letters of the base become math italic and
 * subscripts stay upright; "_x" inside a symbol is a subscript too. Other text with class
 * "load-text" or font-style="italic" in `extra` is slanted.
 */
export function text([x, y], content, cls = "", anchor = "middle", extra = "") {
  const classes = cls.split(/\s+/);
  const symbol = classes.includes("sym");
  // In a symbol, letters become math italic; in a label, Greek letters and
  // math signs (absent from the sans font) are set in the math font.
  // A symbol's "_x" is an upright subscript: k_1 + k_2.
  const subscripts = (value) => {
    const [head, ...rest] = value.split(/_(\w)/);
    let out = escapeXml(mathLetters(head));
    for (let i = 0; i < rest.length; i += 2)
      out += `<tspan dy="4" font-size="70%">${escapeXml(rest[i])}</tspan><tspan dy="-4">${escapeXml(mathLetters(rest[i + 1]))}</tspan>`;
    return out;
  };
  const letters = (value) =>
    symbol
      ? subscripts(value)
      : escapeXml(value).replace(
          /[Α-Ωα-ω∂∇∞]+/g,
          (run) => `<tspan class="m">${mathLetters(run)}</tspan>`,
        );
  const body = Array.isArray(content)
    ? `${letters(content[0])}<tspan dy="4" font-size="70%">${escapeXml(content[1])}</tspan>${content[2] ? `<tspan dy="-4">${letters(content[2])}</tspan>` : ""}`
    : letters(content);
  const slanted =
    !symbol &&
    (classes.includes("load-text") || extra.includes('font-style="italic"'));
  const attributes = [
    extra.replace(/\s*font-style="italic"/, "").trim(),
    slanted ? oblique(x, y) : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<text x="${fmt(x)}" y="${fmt(y)}" text-anchor="${anchor}"${cls ? ` class="${cls}"` : ""}${attributes ? ` ${attributes}` : ""}>${body}</text>`;
}

/**
 * Text with a raised superscript, e.g. Ω with an upright r, or a power of
 * ten. `rise` is how far the superscript is raised (default 8).
 */
export function textSup(
  [x, y],
  base,
  sup,
  cls = "",
  anchor = "middle",
  rise = 8,
) {
  const classes = cls.split(/\s+/);
  const symbol = classes.includes("sym");
  const slanted = !symbol && classes.includes("load-text");
  return `<text x="${fmt(x)}" y="${fmt(y)}" text-anchor="${anchor}"${cls ? ` class="${cls}"` : ""}${slanted ? ` ${oblique(x, y)}` : ""}>${escapeXml(symbol ? mathLetters(base) : base)}<tspan dy="${-rise}" font-size="65%">${escapeXml(sup)}</tspan></text>`;
}

/** An axis label 10^e (or 1), the exponent raised; site fonts have no ⁻⁶. */
export const powerOfTen = (
  point,
  exponent,
  cls = "small lbl",
  anchor = "middle",
) =>
  exponent === 0
    ? text(point, "1", cls, anchor)
    : textSup(point, "10", String(exponent).replace("-", "−"), cls, anchor, 5);

/** Smooth closed curve through points (Catmull–Rom converted to Béziers). */
export function smoothClosed(points) {
  const m = points.length;
  let d = `M${fmt(points[0][0])} ${fmt(points[0][1])}`;
  for (let i = 0; i < m; i++) {
    const p0 = points[(i - 1 + m) % m];
    const p1 = points[i];
    const p2 = points[(i + 1) % m];
    const p3 = points[(i + 2) % m];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${fmt(c1[0])} ${fmt(c1[1])} ${fmt(c2[0])} ${fmt(c2[1])} ${fmt(p2[0])} ${fmt(p2[1])}`;
  }
  return `${d}Z`;
}

export const pointsPath = (points, close = true) =>
  `M${points.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join("L")}${close ? "Z" : ""}`;

// ── Engineering symbols ───────────────────────────────────────────────────────

/** A pinned support (triangle on hatched ground) with its apex at p. */
export function pinSupport([x, y], size = 14) {
  return [
    polygon(
      [
        [x, y],
        [x - size * 0.75, y + size],
        [x + size * 0.75, y + size],
      ],
      "body-alt",
    ),
    `<rect x="${fmt(x - size * 1.2)}" y="${fmt(y + size)}" width="${fmt(size * 2.4)}" height="${fmt(size * 0.45)}" class="hatch-fill"/>`,
    line([x - size * 1.2, y + size], [x + size * 1.2, y + size], "ground"),
  ].join("");
}

/** A roller support (triangle on two wheels) with its apex at p. */
export function rollerSupport([x, y], size = 14) {
  const base = y + size * 0.8;
  const r = size * 0.18;
  return [
    polygon(
      [
        [x, y],
        [x - size * 0.7, base],
        [x + size * 0.7, base],
      ],
      "body-alt",
    ),
    circle([x - size * 0.38, base + r], r, "node-open"),
    circle([x + size * 0.38, base + r], r, "node-open"),
    `<rect x="${fmt(x - size * 1.2)}" y="${fmt(base + 2 * r)}" width="${fmt(size * 2.4)}" height="${fmt(size * 0.45)}" class="hatch-fill"/>`,
    line(
      [x - size * 1.2, base + 2 * r],
      [x + size * 1.2, base + 2 * r],
      "ground",
    ),
  ].join("");
}

/** A hatched clamp wall along a vertical line x from y0 to y1, on the left. */
export function clampLeft(x, y0, y1, depth = 12) {
  return [
    `<rect x="${fmt(x - depth)}" y="${fmt(y0)}" width="${fmt(depth)}" height="${fmt(y1 - y0)}" class="hatch-fill"/>`,
    line([x, y0], [x, y1], "ground"),
  ].join("");
}

/** A hatched ground strip under a horizontal line y from x0 to x1. */
export function clampBelow(y, x0, x1, depth = 10) {
  return [
    `<rect x="${fmt(x0)}" y="${fmt(y)}" width="${fmt(x1 - x0)}" height="${fmt(depth)}" class="hatch-fill"/>`,
    line([x0, y], [x1, y], "ground"),
  ].join("");
}

/** Small x/y axis triad with its origin at p. */
export function axes2d([x, y], length = 34, labels = ["x", "y"]) {
  return [
    arrow([x, y], [x + length, y]),
    arrow([x, y], [x, y - length]),
    text([x + length + 4, y + 5], labels[0], "sym", "start"),
    text([x - 3, y - length - 4], labels[1], "sym", "middle"),
  ].join("");
}

// ── Plot helpers ──────────────────────────────────────────────────────────────

/** Map data → pixel for a rectangular plot area. */
export function scale(domain, range, log = false) {
  const [d0, d1] = log ? domain.map(Math.log10) : domain;
  const [r0, r1] = range;
  return (v) => r0 + (((log ? Math.log10(v) : v) - d0) / (d1 - d0)) * (r1 - r0);
}

/** The app's contour colour for t in [0, 1] (blue → red). */
export function contourColour(t) {
  const h = 0.667 * (1 - Math.min(1, Math.max(0, t)));
  const f = (k0) => {
    const k = (k0 + h * 12) % 12;
    return 0.5 - 0.5 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  const hex = (v) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}
