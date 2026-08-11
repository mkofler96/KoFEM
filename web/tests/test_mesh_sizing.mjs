// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for src/lib/meshSizing.ts — the default element size a fresh
// import starts from (KOF-222). The old fixed 20 mm default (and the 0.5 mm
// floor on the input) made small parts unmeshable: on a 1x1x1 mm cube every
// legal setting was coarser than the part itself.
//
// The estimator's coefficients were calibrated against Netgen on the parts in
// test_files/; these tests pin the properties that calibration relies on —
// exact measurement of a closed tessellation, scale invariance, and hitting the
// target count — without needing the WASM engine.
//
// Run:  bun tests/test_mesh_sizing.mjs   (from the web/ directory)

import {
  measureTessellation,
  estimateElementCount,
  sizeFromMeasure,
  suggestElementSizes,
  TARGET_ELEMENT_COUNT,
  MIN_SIZE_RATIO,
} from "../src/lib/meshSizing.ts";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  [PASS] ${name}`);
  } else {
    failures++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Axis-aligned box tessellation with outward-facing triangles, side lengths
// sx/sy/sz — volume sx·sy·sz and area 2(sx·sy + sy·sz + sz·sx) exactly.
function box(sx, sy, sz) {
  const points = [
    [0, 0, 0],
    [sx, 0, 0],
    [sx, sy, 0],
    [0, sy, 0],
    [0, 0, sz],
    [sx, 0, sz],
    [sx, sy, sz],
    [0, sy, sz],
  ];
  const triangles = [
    [0, 2, 1],
    [0, 3, 2], // z = 0
    [4, 5, 6],
    [4, 6, 7], // z = sz
    [0, 1, 5],
    [0, 5, 4], // y = 0
    [3, 7, 6],
    [3, 6, 2], // y = sy
    [0, 4, 7],
    [0, 7, 3], // x = 0
    [1, 2, 6],
    [1, 6, 5], // x = sx
  ];
  return { points, triangles };
}

console.log("\n1. Measuring a closed tessellation");
{
  const { points, triangles } = box(2, 3, 4);
  const measure = measureTessellation(points, triangles);
  check(
    "volume is exact",
    Math.abs(measure.volume - 24) < 1e-9,
    `${measure.volume}`,
  );
  check("area is exact", Math.abs(measure.area - 52) < 1e-9, `${measure.area}`);
  check(
    "bounding box is exact",
    measure.dx === 2 && measure.dy === 3 && measure.dz === 4,
    `${measure.dx} x ${measure.dy} x ${measure.dz}`,
  );
}

console.log("\n2. Empty geometry has no measure");
check("no points", measureTessellation([], []) === null);
check("no triangles", measureTessellation([[0, 0, 0]], []) === null);

console.log("\n3. The suggested size hits the target element count");
for (const dims of [
  [1, 1, 1],
  [40, 40, 60],
  [300, 80, 80],
  [1000, 20, 2], // long thin strip: the area term dominates
]) {
  const { points, triangles } = box(...dims);
  const measure = measureTessellation(points, triangles);
  const size = sizeFromMeasure(measure);
  const count = estimateElementCount(measure, size);
  check(
    `${dims.join("x")} mm -> ${size.toPrecision(3)} mm`,
    Math.abs(count - TARGET_ELEMENT_COUNT) / TARGET_ELEMENT_COUNT < 1e-3,
    `estimated ${Math.round(count)} elements, target ${TARGET_ELEMENT_COUNT}`,
  );
}

console.log(
  "\n4. KOF-222: a 1 mm cube is sized far below the old 0.5 mm floor",
);
{
  const { points, triangles } = box(1, 1, 1);
  const suggestion = suggestElementSizes(points, triangles);
  const max = parseFloat(suggestion.max);
  const min = parseFloat(suggestion.min);
  check("max size is well under 0.5 mm", max < 0.1, `${suggestion.max} mm`);
  check(
    "the cube spans at least 10 elements per side",
    1 / max >= 10,
    `${(1 / max).toFixed(1)} elements per side`,
  );
  check(
    `min size is max/${MIN_SIZE_RATIO}`,
    Math.abs(min - max / MIN_SIZE_RATIO) < max / MIN_SIZE_RATIO / 100,
    `${suggestion.min} mm vs ${max / MIN_SIZE_RATIO}`,
  );
  check(
    "sizes are rounded for display, not raw solver output",
    /^\d*\.?\d+$/.test(suggestion.max) && suggestion.max.length <= 6,
    suggestion.max,
  );
}

console.log("\n5. Sizing is scale invariant");
{
  const sizeOf = (sx, sy, sz) => {
    const { points, triangles } = box(sx, sy, sz);
    return sizeFromMeasure(measureTessellation(points, triangles));
  };
  const small = sizeOf(1, 1, 1);
  const large = sizeOf(1000, 1000, 1000);
  // Volume and area terms scale differently, so the ratio is not exactly 1000;
  // it must still track the model's scale rather than sitting at a constant.
  check(
    "a 1000x larger cube gets a much larger element size",
    large / small > 100,
    `${small.toPrecision(3)} mm vs ${large.toPrecision(3)} mm`,
  );
}

console.log("\n6. Open (surface-only) geometry is sized from its area alone");
{
  const points = [
    [0, 0, 0],
    [100, 0, 0],
    [100, 100, 0],
  ];
  const measure = measureTessellation(points, [[0, 1, 2]]);
  check(
    "a flat sheet encloses no volume",
    measure.volume < 1e-9,
    `${measure.volume}`,
  );
  const size = sizeFromMeasure(measure);
  check("it still gets a size", size !== null && size > 0, `${size}`);
  check(
    "sized to the target from the area term",
    Math.abs(estimateElementCount(measure, size) - TARGET_ELEMENT_COUNT) /
      TARGET_ELEMENT_COUNT <
      1e-3,
  );
}

console.log(
  "\n7. A degenerate tessellation reports the bad index, not a silent NaN",
);
{
  let message = null;
  try {
    measureTessellation([[0, 0, 0]], [[0, 1, 2]]);
  } catch (err) {
    message = err.message;
  }
  check("out-of-range vertex throws", message !== null);
  check(
    "the message names the triangle",
    message?.includes("(0, 1, 2)") === true,
    message ?? "",
  );
}

console.log(
  failures === 0
    ? "\nAll mesh-sizing checks passed.\n"
    : `\n${failures} mesh-sizing check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
