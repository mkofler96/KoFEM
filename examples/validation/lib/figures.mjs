// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Schematic figures for the example pages, written as SVG markup styled by
// the CSS classes of docs-layout.mjs. The page generator publishes each as
// SVG and PNG files (web/figure-assets.mjs), named <page>-<name> from the
// `name` option (default "diagram"). Sketches, not to scale: they show the
// model, supports, load and measured quantity; no mesh, as every example is
// meshed by Netgen.

const f = (v) => (Math.round(v * 10) / 10).toString();

const DEFS = `<defs>
      <marker id="arr-load" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="m-load"/></marker>
      <marker id="arr-dim" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 1L10 5L0 9z" class="m-dim"/></marker>
      <marker id="arr-def" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 1L10 5L0 9z" class="m-def"/></marker>
      <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" class="hatch"/></pattern>
    </defs>`;

const svg = (w, h, label, body, { defs = true, cls = "fig", name } = {}) =>
  `<svg class="${cls}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${label}"${name ? ` data-name="${name}"` : ""}>
    ${defs ? DEFS : ""}
    ${body}
  </svg>`;

const line = (x1, y1, x2, y2, cls) =>
  `<line class="${cls}" x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}"/>`;

const arrow = (x1, y1, x2, y2, kind = "load") =>
  `<line class="${kind}" x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" marker-end="url(#arr-${kind})"/>`;

/** Dimension line with arrowheads at both ends. */
const dim = (x1, y1, x2, y2) =>
  `<line class="dim" x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" marker-start="url(#arr-dim)" marker-end="url(#arr-dim)"/>`;

/** A label; `sym` labels are set in italic like the symbols in the text. */
const label = (x, y, s, { anchor = "middle", cls = "lbl" } = {}) =>
  `<text class="${cls}" x="${f(x)}" y="${f(y)}" text-anchor="${anchor}">${s}</text>`;

// Mathematical italic code points, so symbols are set in the math font's
// italic as in LaTeX rather than slanted by the browser. Planck's h has its
// own code point (U+210E); the slot in the italic block is reserved.
export function italic(c) {
  const code = c.codePointAt(0);
  if (c === "h") return "\u210E";
  if (code >= 0x41 && code <= 0x5a)
    return String.fromCodePoint(0x1d434 + code - 0x41);
  if (code >= 0x61 && code <= 0x7a)
    return String.fromCodePoint(0x1d44e + code - 0x61);
  if (code >= 0x391 && code <= 0x3a9)
    return String.fromCodePoint(0x1d6e2 + code - 0x391);
  if (code >= 0x3b1 && code <= 0x3c9)
    return String.fromCodePoint(0x1d6fc + code - 0x3b1);
  return c;
}

/**
 * Math text for a label: single letters become math italic, words of two or
 * more letters stay upright (as \text would), everything else is kept.
 */
const mathText = (s) =>
  s.replace(/[A-Za-zΑ-Ωα-ω]+/g, (w) => (w.length === 1 ? italic(w) : w));

/** Math inside a plain label, set in the math font. */
const math = (s) => `<tspan class="m">${mathText(s)}</tspan>`;

/** A symbol label; `sub` adds an upright subscript (rᵢ: sym(…, "r", …, "i")). */
const sym = (x, y, s, anchor = "middle", sub = null) =>
  label(
    x,
    y,
    mathText(s) + (sub ? `<tspan class="sub" dy="4">${sub}</tspan>` : ""),
    { anchor, cls: "sym" },
  );

/** Clamped support: a hatched strip to the left of x, from y1 to y2. */
const clamp = (x, y1, y2) =>
  `<rect class="clamp" x="${f(x - 14)}" y="${f(y1 - 6)}" width="14" height="${f(y2 - y1 + 12)}"/>${line(x, y1 - 6, x, y2 + 6, "wall")}`;

const poly = (pts, cls) =>
  `<polygon class="${cls}" points="${pts.map(([x, y]) => `${f(x)},${f(y)}`).join(" ")}"/>`;
const polyline = (pts, cls) =>
  `<polyline class="${cls}" points="${pts.map(([x, y]) => `${f(x)},${f(y)}`).join(" ")}"/>`;

/** x–y axis triad at (x, y). */
const triad = (x, y, [a, b] = ["x", "y"]) =>
  [
    arrow(x, y, x + 26, y, "dim"),
    arrow(x, y, x, y - 26, "dim"),
    label(x + 32, y + 4, mathText(a), { anchor: "start", cls: "axis-lbl" }),
    label(x, y - 32, mathText(b), { cls: "axis-lbl" }),
  ].join("");

// ── Axial bar: point loads, surface traction or end pressure ────────────────

/**
 * Side view of the prismatic bar. `load`: "traction" (a uniform traction, how
 * the app applies a force to a face) or "pressure" (pressure on the end face).
 */
export function barFigure({ load }) {
  const x0 = 90,
    x1 = 410,
    yc = 112,
    hh = 34,
    d = load === "pressure" ? -22 : 22;
  const top = yc - hh,
    bot = yc + hh;
  const parts = [
    `<rect class="body" x="${x0}" y="${top}" width="${x1 - x0}" height="${2 * hh}"/>`,
    clamp(x0, top, bot),
    // Deformed outline: the end face moves by δ, the section contracts (or,
    // in compression, bulges) away from the clamp.
    polyline(
      [
        [x0, top],
        [x1 + d, top + (d > 0 ? 3 : -3)],
        [x1 + d, bot - (d > 0 ? 3 : -3)],
        [x0, bot],
      ],
      "deformed",
    ),
  ];
  const face = x1 + d;
  if (load === "traction") {
    for (let j = 0; j <= 8; j++) {
      const y = top + 3 + ((2 * hh - 6) * j) / 8;
      parts.push(arrow(face, y, face + 30, y));
    }
    parts.push(sym(face + 40, yc + 5, "t = P / A", "start"));
  } else if (load === "pressure") {
    // Drawn on the undeformed face, clear of the shortened (dashed) bar.
    for (let j = 0; j <= 6; j++) {
      const y = top + 4 + ((2 * hh - 8) * j) / 6;
      parts.push(arrow(x1 + 40, y, x1 + 4, y));
    }
    parts.push(sym(x1 + 50, yc + 5, "p", "start"));
  } else throw new Error(`bar figure: unknown load "${load}"`);
  // δ at the top, L below.
  const dy = top - 16;
  parts.push(
    line(x1, top - 4, x1, dy - 6, "ext"),
    line(face, top - 4, face, dy - 6, "ext"),
    dim(Math.min(x1, face), dy, Math.max(x1, face), dy),
    sym((x1 + face) / 2, dy - 8, load === "pressure" ? "|u|" : "δ"),
    dim(x0, bot + 24, x1, bot + 24),
    sym((x0 + x1) / 2, bot + 18, "L"),
    triad(30, 196),
  );
  // Cross-section inset.
  const sx = 560,
    s = 54;
  parts.push(
    `<rect class="body" x="${sx - s / 2}" y="${yc - s / 2}" width="${s}" height="${s}"/>`,
    dim(sx - s / 2, yc + s / 2 + 14, sx + s / 2, yc + s / 2 + 14),
    sym(sx, yc + s / 2 + 30, "W"),
    dim(sx + s / 2 + 14, yc - s / 2, sx + s / 2 + 14, yc + s / 2),
    sym(sx + s / 2 + 26, yc + 5, "H", "start"),
    label(sx, yc - s / 2 - 12, `section ${math("A = W H")}`),
  );
  return svg(
    640,
    214,
    `Prismatic bar clamped at the left end and loaded axially at the right end`,
    parts.join("\n    "),
  );
}

// ── Cantilever ───────────────────────────────────────────────────────────────

export function cantileverFigure() {
  const x0 = 90,
    x1 = 470,
    yc = 92,
    hh = 19,
    dv = 52;
  const w = (x) => {
    const s = (x - x0) / (x1 - x0);
    return (dv * s * s * (3 - s)) / 2;
  };
  const xs = Array.from({ length: 41 }, (_, i) => x0 + ((x1 - x0) * i) / 40);
  const parts = [
    `<rect class="body" x="${x0}" y="${yc - hh}" width="${x1 - x0}" height="${2 * hh}"/>`,
    clamp(x0, yc - hh, yc + hh),
    polyline(
      xs.map((x) => [x, yc - hh + w(x)]),
      "deformed",
    ),
    polyline(
      xs.map((x) => [x, yc + hh + w(x)]),
      "deformed",
    ),
    line(x1, yc - hh + dv, x1, yc + hh + dv, "deformed"),
    arrow(x1, yc - hh - 52, x1, yc - hh - 2),
    sym(x1 + 10, yc - hh - 34, "P", "start"),
    line(x1 + 4, yc, x1 + 34, yc, "ext"),
    line(x1 + 4, yc + dv, x1 + 34, yc + dv, "ext"),
    dim(x1 + 28, yc, x1 + 28, yc + dv),
    sym(x1 + 38, yc + dv / 2 + 5, "δ", "start"),
    dim(x0, yc + hh + dv + 34, x1, yc + hh + dv + 34),
    sym((x0 + x1) / 2, yc + hh + dv + 28, "L"),
    triad(30, 236),
  ];
  const sx = 575,
    b = 30,
    h = 30;
  parts.push(
    `<rect class="body" x="${sx - b / 2}" y="${yc - h / 2}" width="${b}" height="${h}"/>`,
    dim(sx - b / 2, yc + h / 2 + 14, sx + b / 2, yc + h / 2 + 14),
    sym(sx, yc + h / 2 + 30, "b"),
    dim(sx + b / 2 + 14, yc - h / 2, sx + b / 2 + 14, yc + h / 2),
    sym(sx + b / 2 + 24, yc + 5, "h", "start"),
    label(sx, yc - h / 2 - 12, "section"),
  );
  return svg(
    640,
    260,
    "Cantilever beam clamped at the left end with a downward tip load; the deflected shape is dashed",
    parts.join("\n    "),
  );
}

// ── Prismatic shafts under torsion (oblique view) ────────────────────────────

function torqueArc(cx, cy, rx, ry) {
  // Three-quarter elliptical arc with an arrowhead: the sense of T about +x.
  const a0 = -0.6 * Math.PI,
    a1 = 0.9 * Math.PI;
  const pts = Array.from({ length: 31 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / 30;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  });
  return `<polyline class="load" points="${pts.map(([x, y]) => `${f(x)},${f(y)}`).join(" ")}" marker-end="url(#arr-load)"/>`;
}

export function squareTorsionFigure() {
  const x0 = 100,
    x1 = 420,
    yc = 120,
    s = 60,
    dx = 26,
    dy = -20;
  const top = yc - s / 2,
    bot = yc + s / 2;
  const parts = [
    // Side face, top face, end face.
    `<rect class="body" x="${x0}" y="${top}" width="${x1 - x0}" height="${s}"/>`,
    poly(
      [
        [x0, top],
        [x0 + dx, top + dy],
        [x1 + dx, top + dy],
        [x1, top],
      ],
      "body top",
    ),
    poly(
      [
        [x1, top],
        [x1 + dx, top + dy],
        [x1 + dx, bot + dy],
        [x1, bot],
      ],
      "body end",
    ),
    clamp(x0, top + dy, bot),
    line(x0 - 30, yc + dy / 2, x0 + 12, yc + dy / 2, "axis"),
    line(x1 + dx / 2 + 4, yc + dy / 2, x1 + 92, yc + dy / 2, "axis"),
    label(x1 + 98, yc + dy / 2 + 4, mathText("x"), {
      anchor: "start",
      cls: "axis-lbl",
    }),
    torqueArc(x1 + dx / 2, yc + dy / 2, 22, 52),
    sym(x1 + dx / 2 + 30, top - 30, "T", "start"),
    dim(x0, bot + 26, x1, bot + 26),
    sym((x0 + x1) / 2, bot + 20, "L"),
  ];
  // Section inset: warping w(y, z) of a square section alternates in sign
  // from quadrant to quadrant.
  const sx = 560,
    q = 64;
  parts.push(
    `<rect class="body" x="${sx - q / 2}" y="${yc - q / 2}" width="${q}" height="${q}"/>`,
    line(sx - q / 2, yc, sx + q / 2, yc, "mesh"),
    line(sx, yc - q / 2, sx, yc + q / 2, "mesh"),
    label(sx - q / 4, yc - q / 4 + 5, "+", { cls: "warp" }),
    label(sx + q / 4, yc - q / 4 + 5, "−", { cls: "warp" }),
    label(sx - q / 4, yc + q / 4 + 5, "−", { cls: "warp" }),
    label(sx + q / 4, yc + q / 4 + 5, "+", { cls: "warp" }),
    dim(sx - q / 2, yc + q / 2 + 14, sx + q / 2, yc + q / 2 + 14),
    sym(sx, yc + q / 2 + 30, "b"),
    label(sx, yc - q / 2 - 12, "warping sign"),
  );
  return svg(
    640,
    230,
    "Square bar clamped at the left end and twisted by a torque at the right end; inset shows the sign of the out-of-plane warping over the section",
    parts.join("\n    "),
  );
}

/**
 * The shaft and its section; the inset shows the true circles with a coarse
 * inscribed polygon, a sketch of what straight element edges do to them.
 */
export function hollowShaftFigure() {
  const nth = 10;
  const x0 = 100,
    x1 = 400,
    yc = 112,
    ro = 50,
    ri = 30,
    ex = 16;
  const ell = (cx, r, cls) =>
    `<ellipse class="${cls}" cx="${cx}" cy="${yc}" rx="${f((ex * r) / ro)}" ry="${r}"/>`;
  const parts = [
    `<path class="body" d="M${x0} ${yc - ro} H${x1} A${ex} ${ro} 0 0 1 ${x1} ${yc + ro} H${x0} A${ex} ${ro} 0 0 1 ${x0} ${yc - ro} Z"/>`,
    ell(x1, ro, "body end"),
    ell(x1, ri, "hole"),
    clamp(x0 - ex, yc - ro, yc + ro),
    line(x1 + 6, yc, x1 + 100, yc, "axis"),
    label(x1 + 106, yc + 4, mathText("z"), {
      anchor: "start",
      cls: "axis-lbl",
    }),
    torqueArc(x1, yc, 30, 74),
    sym(x1 + 26, yc - ro - 24, "T", "start"),
    dim(x0, yc + ro + 26, x1, yc + ro + 26),
    sym((x0 + x1) / 2, yc + ro + 20, "L"),
  ];
  // Section inset: a 10-gon over the true circles — straight element edges
  // turn the circle into a polygon.
  const sx = 560,
    Ro = 56,
    Ri = (Ro * ri) / ro;
  const ring = (r) =>
    Array.from({ length: nth }, (_, k) => {
      const a = (2 * Math.PI * k) / nth;
      return [sx + r * Math.cos(a), yc + r * Math.sin(a)];
    });
  const outer = ring(Ro),
    inner = ring(Ri);
  parts.push(
    `<path class="body" fill-rule="evenodd" d="M${outer.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}Z M${inner.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}Z"/>`,
  );
  parts.push(
    arrow(sx, yc, sx + Ri * Math.cos(-2.2), yc + Ri * Math.sin(-2.2), "dim"),
    sym(sx - 18, yc - 2, "r", "end", "i"),
    arrow(sx, yc, sx + Ro * Math.cos(0.5), yc + Ro * Math.sin(0.5), "dim"),
    sym(sx + Ro * 0.62, yc + Ro * 0.62 + 18, "r", "start", "o"),
    label(sx, yc - Ro - 12, "straight edges: a polygon"),
    `<circle class="axis" cx="${sx}" cy="${yc}" r="${f(Ro)}" fill="none"/>`,
    `<circle class="axis" cx="${sx}" cy="${yc}" r="${f(Ri)}" fill="none"/>`,
  );
  return svg(
    640,
    230,
    "Hollow circular shaft clamped at the left end and twisted by a torque at the right end; inset shows how straight element edges turn the circles into polygons",
    parts.join("\n    "),
  );
}

// ── Plate with a hole, and the Kirsch stress along the transverse axis ───────

// A long strip with a central hole, pulled at both ends: the quarter x, y ≥ 0
// the model keeps is shaded, the symmetry lines are dash-dotted.
function stripDiagram() {
  const px = 46,
    py = 60,
    w = 214,
    h = 130,
    a = 13,
    cx = px + w / 2,
    cy = py + h / 2;
  const parts = [
    `<path class="body" fill-rule="evenodd" d="M${px} ${py}h${w}v${h}h${-w}Z M${cx + a} ${cy}A${a} ${a} 0 1 0 ${cx - a} ${cy}A${a} ${a} 0 1 0 ${cx + a} ${cy}Z"/>`,
    `<path class="body top" d="M${cx + a} ${cy}H${px + w}V${py}H${cx}V${cy - a}A${a} ${a} 0 0 1 ${cx + a} ${cy}Z"/>`,
    line(cx, py - 12, cx, py + h + 12, "axis"),
    line(px - 30, cy, px + w + 30, cy, "axis"),
    label(cx + (px + w - cx) / 2, py + 24, "model"),
  ];
  for (let j = 0; j <= 5; j++) {
    const y = py + 6 + ((h - 12) * j) / 5;
    parts.push(
      arrow(px + w + 2, y, px + w + 28, y),
      arrow(px - 2, y, px - 28, y),
    );
  }
  parts.push(
    sym(px + w + 36, cy - 6, "σ", "start"),
    sym(px - 36, cy - 6, "σ", "end"),
    `<circle class="pt" cx="${cx}" cy="${cy - a}" r="3.5"/>`,
    `<circle class="pt" cx="${cx}" cy="${cy + a}" r="3.5"/>`,
    label(cx - 8, cy - a - 6, "A", { anchor: "end" }),
    label(cx - 8, cy + a + 16, "A", { anchor: "end" }),
    dim(cx, cy, cx + a * Math.cos(2.4), cy + a * Math.sin(2.4)),
    sym(cx - a - 6, cy + a + 4, "a", "end"),
    dim(px, py + h + 24, px + w, py + h + 24),
    sym(cx + 40, py + h + 18, "2L"),
    dim(px + 16, py, px + 16, py + h),
    sym(px + 22, py + h - 12, "2b", "start"),
  );
  return svg(
    310,
    270,
    "Long strip with a central hole pulled at both ends; dash-dotted symmetry lines through the hole centre, the modelled quarter x, y ≥ 0 shaded; points A at the top and bottom of the hole carry the peak stress",
    parts.join("\n    "),
    { cls: "fig half", name: "plate-diagram" },
  );
}

/**
 * Left: the plate — `model` "clamped" (default), a square plate fixed on the
 * left and pulled on the right, or "strip", a long strip pulled at both ends
 * with the modelled quarter shaded. Right: Kirsch's stress along the
 * transverse axis.
 */
export function plateFigure({ model = "clamped" } = {}) {
  if (model !== "clamped" && model !== "strip")
    throw new Error(
      `plateFigure: model must be "clamped" or "strip", got "${model}"`,
    );
  const px = 50,
    py = 30,
    side = 200,
    a = 24,
    cx = px + side / 2,
    cy = py + side / 2;
  const parts = [
    `<path class="body" fill-rule="evenodd" d="M${px} ${py}h${side}v${side}h${-side}Z M${cx + a} ${cy}A${a} ${a} 0 1 0 ${cx - a} ${cy}A${a} ${a} 0 1 0 ${cx + a} ${cy}Z"/>`,
    clamp(px, py, py + side),
  ];
  for (let j = 0; j <= 6; j++) {
    const y = py + 6 + ((side - 12) * j) / 6;
    parts.push(arrow(px + side + 2, y, px + side + 32, y));
  }
  parts.push(
    sym(px + side + 40, cy + 5, "σ", "start"),
    `<circle class="pt" cx="${cx}" cy="${cy - a}" r="3.5"/>`,
    `<circle class="pt" cx="${cx}" cy="${cy + a}" r="3.5"/>`,
    label(cx, cy - a - 10, "A"),
    label(cx, cy + a + 20, "A"),
    dim(cx, cy, cx + a * Math.cos(-0.7), cy + a * Math.sin(-0.7)),
    sym(cx + 4, cy + 14, "a", "start"),
    dim(px, py + side + 22, px + side, py + side + 22),
    sym(cx, py + side + 16, "2b"),
  );
  const plate =
    model === "strip"
      ? stripDiagram()
      : svg(
          310,
          270,
          "Plate with a central hole under tension, clamped on the left; points A at the top and bottom of the hole carry the peak stress",
          parts.join("\n    "),
          { cls: "fig half", name: "plate-diagram" },
        );

  // σxx / σ along the transverse axis (x = 0), y / a from 1 to 5.
  const g = [];
  const gx0 = 50,
    gx1 = 290,
    gy0 = 214,
    gy1 = 40;
  const X = (s) => gx0 + ((s - 1) / 4) * (gx1 - gx0);
  const Y = (v) => gy0 - (v / 3.2) * (gy0 - gy1);
  const kirsch = (s) => 1 + 1 / (2 * s * s) + 3 / (2 * s ** 4);
  const pts = Array.from({ length: 81 }, (_, i) => {
    const s = 1 + (4 * i) / 80;
    return [X(s), Y(kirsch(s))];
  });
  g.push(
    line(gx0, gy0, gx1, gy0, "chart-axis"),
    line(gx0, gy0, gx0, gy1, "chart-axis"),
  );
  for (let s = 1; s <= 5; s++)
    g.push(label(X(s), gy0 + 16, String(s), { cls: "tick" }));
  for (let v = 0; v <= 3; v++)
    g.push(
      line(gx0, Y(v), gx1, Y(v), "chart-grid"),
      label(gx0 - 8, Y(v) + 4, String(v), { anchor: "end", cls: "tick" }),
    );
  g.push(
    polyline(pts, "curve"),
    `<circle class="pt" cx="${X(1)}" cy="${Y(3)}" r="3.5"/>`,
    label(X(1) + 10, Y(3) + 4, `A: ${math("3σ")}`, { anchor: "start" }),
    label(gx1, gy0 + 32, mathText("y/a"), { anchor: "end", cls: "axis-lbl" }),
    label(
      gx0,
      gy1 - 12,
      `${italic("σ")}<tspan class="sub" dy="4">${italic("x")}${italic("x")}</tspan><tspan dy="-4">/${mathText("σ")}  ${mathText("on x = 0")}</tspan>`,
      { anchor: "start", cls: "axis-lbl" },
    ),
  );
  const graph = svg(
    310,
    270,
    "The Kirsch stress along the transverse axis falls from 3σ at the hole edge towards σ",
    g.join("\n    "),
    { defs: false, cls: "fig half", name: "kirsch-stress-distribution" },
  );
  return `<div class="fig-row">${plate}${graph}</div>`;
}

/**
 * The quarter x, y ≥ 0 of the long strip with a hole that the shell model
 * keeps, to scale (L = 3b, a = b/5): symmetry supports (rollers) on the cut
 * edges x = 0 and y = 0, the tension σ on the edge x = L, and the peak at A,
 * where the hole meets x = 0.
 */
export function quarterPlateFigure() {
  const px = 52,
    py = 62,
    w = 228,
    hgt = w / 3,
    a = hgt / 5,
    bottom = py + hgt;
  const rollers = [];
  for (let k = 0; k < 3; k++) {
    const y = py + 10 + ((hgt - a - 20) * k) / 2;
    rollers.push(`<circle class="hole" cx="${f(px - 6)}" cy="${f(y)}" r="5"/>`);
  }
  for (let k = 0; k < 9; k++) {
    const x = px + a + 12 + ((w - a - 24) * k) / 8;
    rollers.push(
      `<circle class="hole" cx="${f(x)}" cy="${f(bottom + 6)}" r="5"/>`,
    );
  }
  const parts = [
    `<path class="body" d="M${f(px + a)} ${f(bottom)}H${px + w}V${py}H${px}V${f(bottom - a)}A${f(a)} ${f(a)} 0 0 1 ${f(px + a)} ${f(bottom)}Z"/>`,
    ...rollers,
    line(px - 12, py + 4, px - 12, bottom - a - 4, "wall"),
    line(px + a + 4, bottom + 12, px + w - 4, bottom + 12, "wall"),
  ];
  for (let j = 0; j <= 3; j++) {
    const y = py + 6 + ((hgt - 12) * j) / 3;
    parts.push(arrow(px + w + 2, y, px + w + 28, y));
  }
  parts.push(
    sym(px + w + 36, py + hgt / 2 + 5, "σ", "start"),
    `<circle class="pt" cx="${px}" cy="${f(bottom - a)}" r="3.5"/>`,
    label(px + 10, bottom - a - 6, "A", { anchor: "start" }),
    dim(px - 26, py, px - 26, bottom),
    sym(px - 32, py + hgt / 2 + 5, "b", "end"),
    dim(px, bottom + 30, px + w, bottom + 30),
    sym(px + w / 2, bottom + 24, "L"),
    triad(px + 4, py - 16),
  );
  return svg(
    330,
    200,
    "Quarter of a long strip with a central hole under tension σ, with symmetry supports on the cut edges; point A, where the hole meets the vertical cut, carries the peak stress",
    parts.join("\n    "),
    { cls: "fig half", name: "quarter-plate-diagram" },
  );
}

// ── Cook's membrane ──────────────────────────────────────────────────────────

/**
 * The panel, its clamp and shear load, the point M where the deflection is
 * read (the middle of the loaded edge) and the corner C.
 */
export function cookFigure() {
  const k = 3.4,
    ox = 150,
    oy = 236;
  const P = ([x, y]) => [ox + k * x, oy - k * y];
  const A = [0, 0],
    B = [48, 44],
    C = [48, 60],
    D = [0, 44],
    M = [48, 52];
  const parts = [poly([A, B, C, D].map(P), "body")];
  const [lx, ly0] = P(A),
    [, ly1] = P(D);
  parts.push(clamp(lx, ly1, ly0));
  const [rx, ry0] = P(B),
    [, ry1] = P(C);
  for (let j = 0; j < 4; j++) {
    const y = ry0 - 4 - ((ry0 - ry1 - 8) * j) / 4;
    parts.push(arrow(rx + 14, y, rx + 14, y - 11));
  }
  parts.push(
    sym(rx + 26, (ry0 + ry1) / 2 + 5, "F", "start"),
    `<circle class="pt" cx="${f(P(M)[0])}" cy="${f(P(M)[1])}" r="3.5"/>`,
    label(P(M)[0] - 8, P(M)[1] + 4, "M (48, 52)", { anchor: "end" }),
    label(P(C)[0] + 10, P(C)[1] - 8, "C (48, 60)", {
      anchor: "start",
      cls: "coord",
    }),
    label(P(A)[0] - 20, P(A)[1] + 4, "(0, 0)", { anchor: "end", cls: "coord" }),
    label(P(D)[0] - 20, P(D)[1] + 4, "(0, 44)", {
      anchor: "end",
      cls: "coord",
    }),
    label(P(B)[0] + 10, P(B)[1] + 16, "(48, 44)", {
      anchor: "start",
      cls: "coord",
    }),
    triad(30, 236),
  );
  return svg(
    640,
    260,
    "Cook's membrane: a tapered panel clamped on its left edge with a uniform shear load F on its right edge; M, the middle of the loaded edge, is where the deflection is measured, C the top-right corner",
    parts.join("\n    "),
  );
}

// ── MBB beam (topology optimization) ─────────────────────────────────────────

/** Pin: a triangle under the point, on a hatched ground line. */
const pin = (x, y) =>
  `${poly(
    [
      [x, y],
      [x - 9, y + 14],
      [x + 9, y + 14],
    ],
    "body",
  )}${line(x - 14, y + 15, x + 14, y + 15, "wall")}`;

/** Roller: the triangle on two wheels, free to slide along the ground. */
const roller = (x, y) =>
  `${poly(
    [
      [x, y],
      [x - 9, y + 12],
      [x + 9, y + 12],
    ],
    "body",
  )}<circle class="body" cx="${f(x - 5)}" cy="${f(y + 15)}" r="3"/><circle class="body" cx="${f(x + 5)}" cy="${f(y + 15)}" r="3"/>${line(x - 14, y + 19, x + 14, y + 19, "wall")}`;

export function mbbFigure() {
  const x0 = 60,
    x1 = 540,
    y0 = 50,
    y1 = 130;
  const xm = (x0 + x1) / 2;
  const parts = [
    `<rect class="body" x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}"/>`,
    pin(x0 + 4, y1),
    roller(x1 - 4, y1),
    arrow(xm, y0 - 44, xm, y0 - 2),
    sym(xm + 10, y0 - 26, "F", "start"),
    dim(x0, y1 + 44, x1, y1 + 44),
    sym(xm, y1 + 38, "L"),
    dim(x1 + 26, y0, x1 + 26, y1),
    sym(x1 + 36, (y0 + y1) / 2 + 5, "H", "start"),
    triad(24, 236),
  ];
  return svg(
    620,
    260,
    "MBB beam: a block on a pin at the bottom left and a roller at the bottom right, with a downward load F at the top of mid-span",
    parts.join("\n    "),
  );
}

// ── Tied bodies ──────────────────────────────────────────────────────────────

/** Short dashed links across a gap from x1 to x2 at the heights `ys`. */
const tieLinks = (x1, x2, ys) =>
  ys.map((y) => line(x1, y, x2, y, "ext")).join("");

/**
 * Side view of the tie patch test: two blocks a small gap apart (drawn
 * wider than to scale), symmetry rollers on x = 0 and y = 0, the tension σ on
 * the far end, and the tie across the gap.
 */
export function tiePatchFigure() {
  const x0 = 80,
    xa = 250,
    xb = 266,
    x1 = 520,
    top = 70,
    bot = 160;
  const parts = [
    `<rect class="body" x="${x0}" y="${top}" width="${xa - x0}" height="${bot - top}"/>`,
    `<rect class="body" x="${xb}" y="${top}" width="${x1 - xb}" height="${bot - top}"/>`,
    tieLinks(
      xa,
      xb,
      [0, 1, 2, 3, 4].map((k) => top + 10 + ((bot - top - 20) * k) / 4),
    ),
  ];
  for (let k = 0; k < 3; k++)
    parts.push(
      `<circle class="hole" cx="${f(x0 - 6)}" cy="${f(top + 15 + ((bot - top - 30) * k) / 2)}" r="5"/>`,
    );
  for (const [from, to] of [
    [x0, xa],
    [xb, x1],
  ])
    for (let k = 0; k < 4; k++)
      parts.push(
        `<circle class="hole" cx="${f(from + 14 + ((to - from - 28) * k) / 3)}" cy="${f(bot + 6)}" r="5"/>`,
      );
  parts.push(
    line(x0 - 12, top + 6, x0 - 12, bot - 6, "wall"),
    line(x0 + 6, bot + 12, x1 - 6, bot + 12, "wall"),
  );
  for (let j = 0; j <= 4; j++) {
    const y = top + 6 + ((bot - top - 12) * j) / 4;
    parts.push(arrow(x1 + 2, y, x1 + 30, y));
  }
  parts.push(
    sym(x1 + 38, (top + bot) / 2 + 5, "σ", "start"),
    label((xa + xb) / 2, top - 22, "tie"),
    dim(xa, top - 10, xb, top - 10),
    sym((xa + xb) / 2, top - 36, "g"),
    dim(x0, bot + 30, xa, bot + 30),
    sym((x0 + xa) / 2, bot + 24, "L", "middle", "1"),
    dim(xb, bot + 30, x1, bot + 30),
    sym((xb + x1) / 2, bot + 24, "L", "middle", "2"),
    triad(24, 232),
  );
  return svg(
    600,
    250,
    "Two blocks a small gap apart, tied across the gap, with symmetry supports on the left end and the bottom and a uniform tension σ on the right end",
    parts.join("\n    "),
  );
}

/**
 * The quarter cylinder in two rings with a radial gap (drawn wider than to
 * scale): symmetry rollers on both cut edges, the pressure p in the bore, the
 * tie across the gap and the measured radial displacement of the bore.
 */
export function tieLameFigure() {
  const ox = 70,
    oy = 250,
    s = 1.9;
  const [a, c, c2, b] = [50, 75, 83, 100].map((r) => r * s);
  const ring = (r1, r2) =>
    `<path class="body" d="M${f(ox + r1)} ${oy}H${f(ox + r2)}A${f(r2)} ${f(r2)} 0 0 0 ${ox} ${f(oy - r2)}V${f(oy - r1)}A${f(r1)} ${f(r1)} 0 0 1 ${f(ox + r1)} ${oy}Z"/>`;
  const at = (r, angle) => [ox + r * Math.cos(angle), oy - r * Math.sin(angle)];
  const parts = [ring(a, c), ring(c2, b)];
  for (const angle of [0.3, 0.55, 0.8, 1.05, 1.3]) {
    const [x1, y1] = at(c, angle);
    const [x2, y2] = at(c2, angle);
    parts.push(line(x1, y1, x2, y2, "ext"));
  }
  for (const angle of [0.2, 0.5, 0.8, 1.1, 1.4]) {
    const [x1, y1] = at(a - 26, angle);
    const [x2, y2] = at(a - 2, angle);
    parts.push(arrow(x1, y1, x2, y2));
  }
  for (const [r1, r2] of [
    [a, c],
    [c2, b],
  ])
    for (let k = 0; k < 2; k++) {
      const r = r1 + 8 + ((r2 - r1 - 16) * k) / 1;
      parts.push(
        `<circle class="hole" cx="${f(ox + r)}" cy="${f(oy + 6)}" r="4"/>`,
        `<circle class="hole" cx="${f(ox - 6)}" cy="${f(oy - r)}" r="4"/>`,
      );
    }
  parts.push(
    line(ox + a, oy + 12, ox + b, oy + 12, "wall"),
    line(ox - 12, oy - a, ox - 12, oy - b, "wall"),
    sym(...at(a - 34, 0.8), "p"),
    label(...at((c + c2) / 2 + 26, 1.25), "tie", { anchor: "start" }),
    sym(ox + a / 2, oy + 26, "a"),
    sym(ox + (a + c) / 2, oy + 26, "c"),
    sym(ox + (c2 + b) / 2, oy + 26, "b"),
    `<circle class="pt" cx="${f(ox + a)}" cy="${oy}" r="3.5"/>`,
    triad(ox + b + 20, oy),
  );
  return svg(
    330,
    290,
    "A quarter of a thick-walled cylinder made of two rings with a radial gap, tied across the gap, with symmetry supports on the cut edges and pressure p in the bore; the radial displacement is read where the bore meets the horizontal cut",
    parts.join("\n    "),
    { cls: "fig half", name: "tie-lame-diagram" },
  );
}

/**
 * The cantilever cut at mid-span into two bodies a small gap apart (drawn
 * wider than to scale), tied across the gap: clamp, tip load and deflection.
 */
export function tieCantileverFigure() {
  const x0 = 90,
    xm = 280,
    xn = 296,
    x1 = 486,
    yc = 92,
    hh = 19;
  const parts = [
    `<rect class="body" x="${x0}" y="${yc - hh}" width="${xm - x0}" height="${2 * hh}"/>`,
    `<rect class="body" x="${xn}" y="${yc - hh}" width="${x1 - xn}" height="${2 * hh}"/>`,
    clamp(x0, yc - hh, yc + hh),
    tieLinks(xm, xn, [yc - hh + 6, yc, yc + hh - 6]),
    arrow(x1, yc - hh - 52, x1, yc - hh - 2),
    sym(x1 + 10, yc - hh - 34, "P", "start"),
    label((xm + xn) / 2, yc - hh - 10, "tie"),
    dim(x0, yc + hh + 34, x1, yc + hh + 34),
    sym((x0 + x1) / 2, yc + hh + 28, "L + g"),
    triad(30, 196),
  ];
  return svg(
    560,
    214,
    "Cantilever beam cut at mid-span into two bodies a small gap apart and tied across the gap, clamped at the left end with a downward tip load",
    parts.join("\n    "),
  );
}
