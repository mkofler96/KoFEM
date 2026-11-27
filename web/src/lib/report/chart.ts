// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The analysis report's charts (KOF-391) as SVG at their printed size, in the
// style of a scientific plot: a closed frame, inward major and minor ticks on
// all four sides, no grid, every label in Computer Modern (KoFEM Math), and
// the values at the curve's ends written beside it.

import { escapeHtml } from "./tex";

export interface TickSet {
  major: number[];
  minor: number[];
  // Decimals the major labels need.
  decimals: number;
}

/** A tick step near span / n: 1, 2 or 5 times a power of ten. */
export function niceStep(span: number, n: number): number {
  if (!(span > 0) || !(n > 0))
    throw new Error(`report chart: no tick step for span ${span} in ${n}`);
  const raw = span / n;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const leading = raw / magnitude;
  const step =
    (leading < 1.5 ? 1 : leading < 3 ? 2 : leading < 7 ? 5 : 10) * magnitude;
  return Number(step.toPrecision(12));
}

/** Majors on a nice step through [lo, hi], with 4 or 5 minors between. */
export function linearTicks(lo: number, hi: number, n: number): TickSet {
  const step = niceStep(hi - lo, n);
  const leading = Math.round(step / 10 ** Math.floor(Math.log10(step)));
  const minorStep = step / (leading === 2 ? 4 : 5);
  const major: number[] = [];
  const minor: number[] = [];
  const first = Math.ceil(lo / minorStep - 1e-9);
  const last = Math.floor(hi / minorStep + 1e-9);
  for (let k = first; k <= last; k++) {
    const value = Number((k * minorStep).toPrecision(12));
    const ratio = value / step;
    if (Math.abs(ratio - Math.round(ratio)) < 1e-6) major.push(value);
    else minor.push(value);
  }
  return {
    major,
    minor,
    decimals: Math.max(0, -Math.floor(Math.log10(step) + 1e-9)),
  };
}

/** Decades in [lo, hi] as majors, 2…9 times a decade as minors. */
export function logTicks(lo: number, hi: number): TickSet {
  if (!(lo > 0) || !(hi > lo))
    throw new Error(
      `report chart: a log axis needs 0 < lo < hi, got ${lo}…${hi}`,
    );
  const major: number[] = [];
  const minor: number[] = [];
  for (let k = Math.floor(Math.log10(lo)); k <= Math.ceil(Math.log10(hi)); k++)
    for (let m = 1; m <= 9; m++) {
      const value = Number((m * 10 ** k).toPrecision(12));
      if (value >= lo && value <= hi) (m === 1 ? major : minor).push(value);
    }
  return { major, minor, decimals: 0 };
}

// Where a value is written beside its point; aboveLeft keeps the label of
// a point at the frame's right edge inside the frame.
export type EndPlacement = "right" | "left" | "above" | "aboveLeft";

export interface ChartSpec {
  width: number;
  height: number;
  xs: number[];
  ys: number[];
  xScale: "linear" | "log";
  xRange: [number, number];
  // Axis labels: plain text with *x* for an italic symbol and _{…} for an
  // index (svgLabel).
  xLabel: string;
  yLabel: string;
  // [point index, text, placement] for the values written beside the curve.
  ends?: [number, string, EndPlacement][];
  // A dotted reference line at this y.
  refY?: number;
  // Decimals of the y labels; by default what the tick step needs.
  yDecimals?: number;
}

const FRAME = { left: 54, right: 10, top: 10, bottom: 40 };
const MAJOR = 4.5;
const MINOR = 2.4;

/** An axis label as SVG text: *x* italic, _{…} an index. */
export function svgLabel(label: string): string {
  return escapeHtml(label)
    .replace(/\*([^*]+)\*/g, '<tspan font-style="italic">$1</tspan>')
    .replace(
      /_\{([^}]+)\}/g,
      '<tspan dy="3" font-size="8">$1</tspan><tspan dy="-3"> </tspan>',
    );
}

const number = (value: number, decimals: number): string =>
  value.toFixed(decimals).replace("-", "−");

// 7 % of the values' span above and below the curve; a flat curve gets a
// band of 7 % of its value, or of 1 when that is zero, so it still has an axis.
function yPadding(lo: number, hi: number): number {
  if (hi > lo) return (hi - lo) * 0.07;
  if (hi !== 0) return Math.abs(hi) * 0.07;
  return 0.07;
}

export function scientificChart(spec: ChartSpec): string {
  const { width: w, height: h, xs, ys, xScale, xRange } = spec;
  if (xs.length !== ys.length)
    throw new Error(
      `report chart: ${xs.length} x values but ${ys.length} y values`,
    );
  if (xs.length === 0) throw new Error("report chart: no values to draw");
  if (![...xs, ...ys].every(Number.isFinite))
    throw new Error("report chart: a value is not finite");
  const log = xScale === "log";
  if (log && !(xRange[0] > 0 && xs.every((x) => x > 0)))
    throw new Error("report chart: a log axis needs positive x values");

  const lo = Math.min(...ys, spec.refY ?? Infinity);
  const hi = Math.max(...ys, spec.refY ?? -Infinity);
  const pad = yPadding(lo, hi);
  const [ya, yb] = [lo - pad, hi + pad];
  const fx = (x: number) => (log ? Math.log10(x) : x);
  const X0 = FRAME.left,
    X1 = w - FRAME.right,
    Y0 = FRAME.top,
    Y1 = h - FRAME.bottom;
  const sx = (x: number) =>
    X0 +
    ((fx(x) - fx(xRange[0])) / (fx(xRange[1]) - fx(xRange[0]))) * (X1 - X0);
  const sy = (y: number) => Y0 + (1 - (y - ya) / (yb - ya)) * (Y1 - Y0);
  const xt = log
    ? logTicks(xRange[0], xRange[1])
    : linearTicks(xRange[0], xRange[1], 4);
  const yt = linearTicks(ya, yb, 5);
  const yDecimals = spec.yDecimals ?? yt.decimals;

  const line = (x1: number, y1: number, x2: number, y2: number) =>
    `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#16181d" stroke-width=".7"/>`;
  const parts: string[] = [
    `<rect x="${X0}" y="${Y0}" width="${X1 - X0}" height="${Y1 - Y0}" fill="none" stroke="#16181d" stroke-width=".8"/>`,
  ];
  for (const v of xt.major) {
    const px = sx(v);
    const text = log
      ? `10<tspan dy="-5" font-size="8">${Math.round(Math.log10(v))}</tspan>`
      : number(v, xt.decimals);
    parts.push(
      line(px, Y1, px, Y1 - MAJOR),
      line(px, Y0, px, Y0 + MAJOR),
      `<text x="${px.toFixed(1)}" y="${Y1 + 15}" text-anchor="middle">${text}</text>`,
    );
  }
  for (const v of xt.minor) {
    const px = sx(v);
    parts.push(line(px, Y1, px, Y1 - MINOR), line(px, Y0, px, Y0 + MINOR));
  }
  for (const v of yt.major) {
    const py = sy(v);
    parts.push(
      line(X0, py, X0 + MAJOR, py),
      line(X1, py, X1 - MAJOR, py),
      `<text x="${X0 - 6}" y="${(py + 3.6).toFixed(1)}" text-anchor="end">${number(v, yDecimals)}</text>`,
    );
  }
  for (const v of yt.minor) {
    const py = sy(v);
    parts.push(line(X0, py, X0 + MINOR, py), line(X1, py, X1 - MINOR, py));
  }
  if (spec.refY !== undefined) {
    const py = sy(spec.refY).toFixed(1);
    parts.push(
      `<line x1="${X0}" x2="${X1}" y1="${py}" y2="${py}" stroke="#7a808a" stroke-width=".8" stroke-dasharray="1.5 2"/>`,
    );
  }
  const points = xs.map(
    (x, k) => `${sx(x).toFixed(1)},${sy(ys[k]).toFixed(1)}`,
  );
  parts.push(
    `<polyline fill="none" stroke="var(--chart)" stroke-width="1.5" stroke-linejoin="round" points="${points.join(" ")}"/>`,
  );
  // Few points are marked; a long history reads as a line.
  if (xs.length < 12)
    parts.push(
      ...xs.map(
        (x, k) =>
          `<circle cx="${sx(x).toFixed(1)}" cy="${sy(ys[k]).toFixed(1)}" r="2.4" fill="var(--chart)"/>`,
      ),
    );
  for (const [k, text, place] of spec.ends ?? []) {
    if (k < 0 || k >= xs.length)
      throw new Error(`report chart: label for point ${k} of ${xs.length}`);
    const px = sx(xs[k]);
    const py = sy(ys[k]);
    const label = escapeHtml(text);
    parts.push(
      {
        right: `<text x="${(px + 7).toFixed(1)}" y="${(py + 4).toFixed(1)}">${label}</text>`,
        left: `<text x="${(px - 7).toFixed(1)}" y="${(py + 4).toFixed(1)}" text-anchor="end">${label}</text>`,
        above: `<text x="${px.toFixed(1)}" y="${(py - 9).toFixed(1)}" text-anchor="middle">${label}</text>`,
        aboveLeft: `<text x="${(px - 2).toFixed(1)}" y="${(py - 7).toFixed(1)}" text-anchor="end">${label}</text>`,
      }[place],
    );
  }
  parts.push(
    `<text x="${(X0 + X1) / 2}" y="${h - 6}" text-anchor="middle">${svgLabel(spec.xLabel)}</text>`,
    `<text transform="translate(13 ${(Y0 + Y1) / 2}) rotate(-90)" text-anchor="middle">${svgLabel(spec.yLabel)}</text>`,
  );
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img">${parts.join("")}</svg>`;
}
