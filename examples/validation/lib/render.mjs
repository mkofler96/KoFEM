// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The figure on an example page: the solved surface, drawn the way the app's
// viewport draws it (deformed shape, blue → red contour, element edges), as a
// PNG. A small software rasteriser, so the page needs no script and no WebGL,
// and the same model always gives the same image.
//
//   renderPng(surface, options) → Buffer
//
// `surface` is { positions, displacements, scalars, triangles, edgeMask? }:
// flat xyz arrays, one scalar per vertex and vertex-index triples. `edgeMask`
// has one entry per triangle; bit i set means the edge opposite vertex i is an
// element edge (a quad split in two has one diagonal that is not). Without it
// every triangle edge is drawn.
//
// options: { width, view: [x, y, z] (direction the camera looks along),
//            up: [x, y, z], deformScale, range: [min, max],
//            focus?: { center: [x, y, z], half, aspect } }
// Without `focus` the whole model is framed; with it, a square of half-width
// `half` (model units) about `center`, at height/width `aspect`.

import { deflateSync } from "node:zlib";

const SS = 3; // supersampling per axis

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a) => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** The app's contour colour (MeshScene: setHSL(0.667·(1 − t), 1, 0.5)). */
function contour(t) {
  const h = 0.667 * (1 - Math.min(1, Math.max(0, t)));
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return 0.5 - 0.5 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

export function renderPng(surface, options) {
  const { positions, displacements, scalars, triangles } = surface;
  const { width, view, up = [0, 1, 0], deformScale, range, focus } = options;
  const n = positions.length / 3;
  const [lo, hi] = range;
  if (!(hi > lo)) throw new Error(`figure range [${lo}, ${hi}] is empty`);

  // Orthographic camera looking along `view`.
  const w = unit(view.map((c) => -c)); // towards the viewer
  const u = unit(cross(up, w));
  const v = cross(w, u);
  const P = [];
  for (let i = 0; i < n; i++) {
    const p = [0, 1, 2].map(
      (k) => positions[3 * i + k] + deformScale * displacements[3 * i + k],
    );
    P.push([dot(p, u), dot(p, v), dot(p, w), p]);
  }
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity;
  for (const [x, y] of P) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  const margin = focus ? 0 : 0.04;
  const aspect = focus
    ? focus.aspect
    : Math.min(0.75, Math.max(0.32, (y1 - y0) / (x1 - x0)));
  const height = Math.round(width * aspect);
  const W = width * SS,
    H = height * SS;
  const scale = focus
    ? W / (2 * focus.half)
    : Math.min(
        (W * (1 - 2 * margin)) / (x1 - x0),
        (H * (1 - 2 * margin)) / (y1 - y0),
      );
  const cx = focus ? dot(focus.center, u) : (x0 + x1) / 2,
    cy = focus ? dot(focus.center, v) : (y0 + y1) / 2;
  const sx = P.map(([x]) => W / 2 + (x - cx) * scale);
  const sy = P.map(([, y]) => H / 2 - (y - cy) * scale);
  const sz = P.map(([, , z]) => z);

  const depth = new Float32Array(W * H).fill(-Infinity);
  const rgb = new Float32Array(W * H * 3);
  const cover = new Uint8Array(W * H);
  const light = unit([0.35, 0.55, 1]); // in camera space, from the upper left
  const lineWidth = 0.9 * SS;
  const t = (s) => (s - lo) / (hi - lo);

  for (let f = 0; f < triangles.length / 3; f++) {
    const a = triangles[3 * f],
      b = triangles[3 * f + 1],
      c = triangles[3 * f + 2];
    const mask = surface.edgeMask ? surface.edgeMask[f] : 7;
    const area =
      (sx[b] - sx[a]) * (sy[c] - sy[a]) - (sx[c] - sx[a]) * (sy[b] - sy[a]);
    if (Math.abs(area) < 1e-9) continue;
    // Flat shading from the deformed face normal, lit from both sides.
    const nrm = unit(cross(sub(P[b][3], P[a][3]), sub(P[c][3], P[a][3])));
    const nCam = [dot(nrm, u), dot(nrm, v), dot(nrm, w)];
    const shade = 0.62 + 0.38 * Math.abs(dot(nCam, light));
    // Distance (px) from a point to each edge = λ_i · 2|area| / |edge_i|.
    const len = [
      Math.hypot(sx[c] - sx[b], sy[c] - sy[b]),
      Math.hypot(sx[a] - sx[c], sy[a] - sy[c]),
      Math.hypot(sx[b] - sx[a], sy[b] - sy[a]),
    ];
    const minX = Math.max(0, Math.floor(Math.min(sx[a], sx[b], sx[c])));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(sx[a], sx[b], sx[c])));
    const minY = Math.max(0, Math.floor(Math.min(sy[a], sy[b], sy[c])));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(sy[a], sy[b], sy[c])));
    for (let py = minY; py <= maxY; py++)
      for (let px = minX; px <= maxX; px++) {
        const qx = px + 0.5,
          qy = py + 0.5;
        const l0 =
          ((sx[b] - qx) * (sy[c] - qy) - (sx[c] - qx) * (sy[b] - qy)) / area;
        const l1 =
          ((sx[c] - qx) * (sy[a] - qy) - (sx[a] - qx) * (sy[c] - qy)) / area;
        const l2 = 1 - l0 - l1;
        if (l0 < 0 || l1 < 0 || l2 < 0) continue;
        const z = l0 * sz[a] + l1 * sz[b] + l2 * sz[c];
        const k = py * W + px;
        if (z <= depth[k]) continue;
        depth[k] = z;
        cover[k] = 1;
        const col = contour(
          l0 * t(scalars[a]) + l1 * t(scalars[b]) + l2 * t(scalars[c]),
        );
        const twoA = Math.abs(area);
        const onEdge = [l0, l1, l2].some(
          (l, i) => mask & (1 << i) && (l * twoA) / len[i] < lineWidth,
        );
        const m = onEdge ? shade * 0.72 : shade;
        rgb[3 * k] = col[0] * m;
        rgb[3 * k + 1] = col[1] * m;
        rgb[3 * k + 2] = col[2] * m;
      }
  }

  // Box-filter down to the output size; uncovered pixels stay transparent.
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let r = 0,
        g = 0,
        bl = 0,
        cov = 0;
      for (let j = 0; j < SS; j++)
        for (let i = 0; i < SS; i++) {
          const k = (y * SS + j) * W + x * SS + i;
          if (!cover[k]) continue;
          r += rgb[3 * k];
          g += rgb[3 * k + 1];
          bl += rgb[3 * k + 2];
          cov++;
        }
      const o = 4 * (y * width + x);
      if (!cov) continue;
      out[o] = Math.round((255 * r) / cov);
      out[o + 1] = Math.round((255 * g) / cov);
      out[o + 2] = Math.round((255 * bl) / cov);
      out[o + 3] = Math.round((255 * cov) / (SS * SS));
    }
  return encodePng(out, width, height);
}

// ── PNG ───────────────────────────────────────────────────────────────────────

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGBA, 8 bit, with the per-row filter that leaves the smallest residuals. */
function encodePng(rgba, width, height) {
  const stride = width * 4;
  const rows = [];
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a),
      pb = Math.abs(p - b),
      pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y ? rgba.subarray((y - 1) * stride, y * stride) : null;
    let best = null,
      bestSum = Infinity;
    for (let type = 0; type < 5; type++) {
      const f = Buffer.alloc(stride + 1);
      f[0] = type;
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? row[i - 4] : 0;
        const b = prev ? prev[i] : 0;
        const c = prev && i >= 4 ? prev[i - 4] : 0;
        const pred =
          type === 0
            ? 0
            : type === 1
              ? a
              : type === 2
                ? b
                : type === 3
                  ? (a + b) >> 1
                  : paeth(a, b, c);
        const val = (row[i] - pred) & 0xff;
        f[i + 1] = val;
        sum += val < 128 ? val : 256 - val;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = f;
      }
    }
    rows.push(best);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Pixel size of a PNG written by renderPng, for the img element. */
export function pngSize(png) {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

// ── An example page's figure ──────────────────────────────────────────────────

/** The looking direction of the default figure: the app's opening view. */
export const ISO_VIEW = [-0.55, -0.5, -1];

/** The largest 1, 2 or 5 × 10ⁿ not above x. */
function niceBelow(x) {
  const p = 10 ** Math.floor(Math.log10(x));
  const m = x / p;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
}

/**
 * The figure of a solved example: the PNG and what its caption states (the
 * field and its range, and how much the displacements are enlarged). Drawn
 * displacements are about a tenth of the model size, rounded down to a
 * 1-2-5 factor; `deform: false` draws the undeformed shape.
 */
export function resultFigure(
  surface,
  { field, unit, view = ISO_VIEW, deform = true, focus, width = 1200 },
) {
  const { positions, displacements, scalars } = surface;
  let size = 0;
  for (let k = 0; k < 3; k++) {
    let lo = Infinity,
      hi = -Infinity;
    for (let i = k; i < positions.length; i += 3) {
      lo = Math.min(lo, positions[i]);
      hi = Math.max(hi, positions[i]);
    }
    size = Math.max(size, hi - lo);
  }
  const maxU = displacements.reduce((m, d) => Math.max(m, Math.abs(d)), 0);
  const scale = deform && maxU > 0 ? niceBelow((0.1 * size) / maxU) : 0;
  const min = scalars.reduce((m, s) => Math.min(m, s), Infinity);
  const max = scalars.reduce((m, s) => Math.max(m, s), -Infinity);
  const png = renderPng(surface, {
    width,
    view,
    deformScale: scale,
    range: [min, max],
    focus,
  });
  return {
    png,
    meta: { field, unit, min, max, deform: scale, ...pngSize(png) },
  };
}
