// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Schematic figures for the validation case pages (inline SVG, styled by the
// page's CSS classes). Sketches, not to scale: they show the model, supports,
// load and measured quantity, with the case's mesh drawn faintly where it fits.

const f = (v) => (Math.round(v * 10) / 10).toString();

const DEFS = `<defs>
      <marker id="arr-load" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="m-load"/></marker>
      <marker id="arr-dim" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 1L10 5L0 9z" class="m-dim"/></marker>
      <marker id="arr-def" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 1L10 5L0 9z" class="m-def"/></marker>
      <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" class="hatch"/></pattern>
    </defs>`;

const svg = (w, h, label, body, { defs = true, cls = "fig" } = {}) =>
  `<svg class="${cls}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${label}">
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
function italic(c) {
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

/** Grid lines of an nx × ny structured mesh on the rectangle. */
function rectMesh(x0, y0, x1, y1, nx, ny) {
  const out = [];
  for (let i = 1; i < nx; i++) {
    const x = x0 + ((x1 - x0) * i) / nx;
    out.push(line(x, y0, x, y1, "mesh"));
  }
  for (let j = 1; j < ny; j++) {
    const y = y0 + ((y1 - y0) * j) / ny;
    out.push(line(x0, y, x1, y, "mesh"));
  }
  return out.join("");
}

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
 * Side view of the prismatic bar. `load`: "nodal" (equal nodal forces),
 * "traction" (uniform traction) or "pressure" (pressure on the end face).
 */
export function barFigure({ load, div }) {
  const [nx, ny] = div;
  const x0 = 90,
    x1 = 410,
    yc = 112,
    hh = 34,
    d = load === "pressure" ? -22 : 22;
  const top = yc - hh,
    bot = yc + hh;
  const parts = [
    `<rect class="body" x="${x0}" y="${top}" width="${x1 - x0}" height="${2 * hh}"/>`,
    rectMesh(x0, top, x1, bot, nx, ny),
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
  if (load === "nodal") {
    for (let j = 0; j <= ny; j++) {
      const y = top + (2 * hh * j) / ny;
      parts.push(arrow(face, y, face + 46, y));
    }
    parts.push(sym(face + 60, yc + 5, "P", "start"));
  } else if (load === "traction") {
    for (let j = 0; j <= 8; j++) {
      const y = top + 3 + ((2 * hh - 6) * j) / 8;
      parts.push(arrow(face, y, face + 30, y));
    }
    parts.push(sym(face + 40, yc + 5, "t = P / A", "start"));
  } else {
    // Drawn on the undeformed face, clear of the shortened (dashed) bar.
    for (let j = 0; j <= 6; j++) {
      const y = top + 4 + ((2 * hh - 8) * j) / 6;
      parts.push(arrow(x1 + 40, y, x1 + 4, y));
    }
    parts.push(sym(x1 + 50, yc + 5, "p", "start"));
  }
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

export function cantileverFigure({ div }) {
  const [nx, ny] = div;
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
    rectMesh(x0, yc - hh, x1, yc + hh, nx, ny),
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

export function squareTorsionFigure({ div }) {
  const [nx, ny] = div;
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
    rectMesh(x0, top, x1, bot, nx, ny),
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

export function hollowShaftFigure({ div }) {
  const [nr, nth] = div;
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
  // Section inset: the case's mesh, nr rings × nth segments with straight
  // sides — the circle becomes a polygon.
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
  for (let i = 1; i < nr; i++)
    parts.push(
      polyline(
        [
          ...ring(Ri + ((Ro - Ri) * i) / nr),
          ring(Ri + ((Ro - Ri) * i) / nr)[0],
        ],
        "mesh",
      ),
    );
  for (let k = 0; k < nth; k++)
    parts.push(line(...inner[k], ...outer[k], "mesh"));
  parts.push(
    arrow(sx, yc, sx + Ri * Math.cos(-2.2), yc + Ri * Math.sin(-2.2), "dim"),
    sym(sx - 18, yc - 2, "r", "end", "i"),
    arrow(sx, yc, sx + Ro * Math.cos(0.5), yc + Ro * Math.sin(0.5), "dim"),
    sym(sx + Ro * 0.62, yc + Ro * 0.62 + 18, "r", "start", "o"),
    label(sx, yc - Ro - 12, `section mesh, ${nth} segments`),
  );
  return svg(
    640,
    230,
    "Hollow circular shaft clamped at the left end and twisted by a torque at the right end; inset shows the polygonal section mesh",
    parts.join("\n    "),
  );
}

// ── Plate with a hole, and the Kirsch stress along the transverse axis ───────

export function plateFigure() {
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
  const plate = svg(
    310,
    270,
    "Plate with a central hole under tension, clamped on the left; points A at the top and bottom of the hole carry the peak stress",
    parts.join("\n    "),
    { cls: "fig half" },
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
    { defs: false, cls: "fig half" },
  );
  return `<div class="fig-row">${plate}${graph}</div>`;
}

// ── Cook's membrane ──────────────────────────────────────────────────────────

export function cookFigure({ n }) {
  const k = 3.4,
    ox = 150,
    oy = 236;
  const P = ([x, y]) => [ox + k * x, oy - k * y];
  const A = [0, 0],
    B = [48, 44],
    C = [48, 60],
    D = [0, 44];
  const at = (s, t) =>
    P([
      (1 - s) * (1 - t) * A[0] +
        s * (1 - t) * B[0] +
        s * t * C[0] +
        (1 - s) * t * D[0],
      (1 - s) * (1 - t) * A[1] +
        s * (1 - t) * B[1] +
        s * t * C[1] +
        (1 - s) * t * D[1],
    ]);
  const parts = [poly([A, B, C, D].map(P), "body")];
  for (let i = 1; i < n; i++) {
    parts.push(line(...at(i / n, 0), ...at(i / n, 1), "mesh"));
    parts.push(line(...at(0, i / n), ...at(1, i / n), "mesh"));
  }
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
    `<circle class="pt" cx="${f(P(C)[0])}" cy="${f(P(C)[1])}" r="3.5"/>`,
    label(P(C)[0] + 10, P(C)[1] - 8, "C (48, 60)", { anchor: "start" }),
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
    "Cook's membrane: a tapered panel clamped on its left edge with a uniform shear load F on its right edge; C is the top-right corner where the deflection is measured",
    parts.join("\n    "),
  );
}
