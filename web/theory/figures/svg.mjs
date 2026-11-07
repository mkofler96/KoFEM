// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Shared drawing vocabulary for the Theory Guide figures. Each figure is a
// standalone SVG file (public/theory/figures/<id>.svg) so it stays vector,
// renders without the page's CSS and can be indexed as an image. Colours are
// for a light background; theory.css inverts them for the dark theme.

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
  text { font-family: "Helvetica Neue", Helvetica, Arial, "Segoe UI", Roboto, sans-serif; font-size: 13px; fill: ${palette.ink}; }
  .sym { font-family: "Latin Modern Math", "STIX Two Math", "Cambria Math", "Times New Roman", Times, serif; font-style: italic; font-size: 17px; }
  .sym.up { font-style: normal; }
  .bold { font-weight: 700; }
  .halo { paint-order: stroke; stroke: #ffffff; stroke-width: 4px; stroke-linejoin: round; }
  .small { font-size: 11px; }
  .lbl { fill: ${palette.muted}; }
  .title { font-size: 14px; font-weight: 600; }
  .load-text { fill: ${palette.load}; font-weight: 700; font-style: italic; }
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

/** A complete standalone SVG document. */
export function svgDocument({ width, height, title, description, body }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="title desc">
<title id="title">${escapeXml(title)}</title>
<desc id="desc">${escapeXml(description)}</desc>
<style>${style.replace(/\s+/g, " ").trim()}</style>
${defs}
${body}
</svg>
`;
}

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

/**
 * Text at a point. `anchor` is start | middle | end; `cls` adds classes.
 * Subscripts: pass [base, sub] as `content` to typeset base with a lowered sub.
 */
export function text([x, y], content, cls = "", anchor = "middle", extra = "") {
  const body = Array.isArray(content)
    ? `${escapeXml(content[0])}<tspan dy="4" font-size="70%">${escapeXml(content[1])}</tspan>${content[2] ? `<tspan dy="-4">${escapeXml(content[2])}</tspan>` : ""}`
    : escapeXml(content);
  return `<text x="${fmt(x)}" y="${fmt(y)}" text-anchor="${anchor}"${cls ? ` class="${cls}"` : ""}${extra ? ` ${extra}` : ""}>${body}</text>`;
}

/** Text with a raised superscript, e.g. Ω with an upright r. */
export function textSup([x, y], base, sup, cls = "", anchor = "middle") {
  return `<text x="${fmt(x)}" y="${fmt(y)}" text-anchor="${anchor}"${cls ? ` class="${cls}"` : ""}>${escapeXml(base)}<tspan dy="-8" font-size="65%" font-style="normal">${escapeXml(sup)}</tspan></text>`;
}

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
