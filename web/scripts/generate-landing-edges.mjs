// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Writes the landing bracket's CAD edges (public/landing/ge-engine-bracket-edges.*)
// from the original Onshape STEP export, a tessellated AP242 file:
//
//   cd web
//   bun scripts/generate-landing-edges.mjs /path/to/GE_engine_bracket.step
//
// Only the sharp-edge line segments are written; the STEP stays where it is.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { parseTriangulatedStep, sharpEdges } from "./landing-edges.mjs";

const landing = new URL("../public/landing/", import.meta.url);
const SOURCE_SHA256 =
  "3659a39854373c9af14d814bdeac431ac212d3eda12b78c45f42350f8a164035";
// Fillets bend by under 5° per tessellation edge, CAD edges by 40° or more.
const MIN_ANGLE_DEG = 20;
// Quantization step in mm: the bracket fits ±32767 × 0.005 mm = ±163 mm.
const SCALE = 0.005;

const sourcePath = process.argv[2];
if (!sourcePath)
  throw Error(
    "Usage: bun scripts/generate-landing-edges.mjs /path/to/GE_engine_bracket.step",
  );
const source = readFileSync(sourcePath);
const sourceHash = createHash("sha256").update(source).digest("hex");
if (sourceHash !== SOURCE_SHA256)
  throw Error(
    `STEP source hash ${sourceHash} is not the expected ${SOURCE_SHA256}`,
  );

const { points, triangles } = parseTriangulatedStep(source.toString("latin1"));

// The landing mounting frame (scripts/generate-landing-bracket.mjs, aligned())
// followed by the axis map between this export and the re-export it was built
// from: landing (x, y, z) = (-z', y', x').
const normalY = 0.662599371078666,
  normalZ = 0.748974013865739;
const toLanding = ([x, y, z]) => {
  const a = [normalY * y + normalZ * z, x + 74.0283, normalZ * y - normalY * z];
  return [-a[2], a[1], a[0]];
};
const mapped = points.map(toLanding);

const geometry = JSON.parse(
  readFileSync(new URL("ge-engine-bracket.json", landing), "utf8"),
);
const min = [0, 1, 2].map((axis) => Math.min(...mapped.map((p) => p[axis])));
const max = [0, 1, 2].map((axis) => Math.max(...mapped.map((p) => p[axis])));
for (let axis = 0; axis < 3; axis++) {
  const span = max[axis] - min[axis];
  if (Math.abs(span - geometry.span[axis]) > 0.1)
    throw Error(
      `Axis ${axis} spans ${span.toFixed(3)} mm, the landing bracket ${geometry.span[axis].toFixed(3)} mm`,
    );
}
const offset = [0, 1, 2].map(
  (axis) =>
    (geometry.min[axis] + geometry.max[axis]) / 2 - (min[axis] + max[axis]) / 2,
);
const placed = mapped.map((p) => p.map((value, axis) => value + offset[axis]));

const segments = sharpEdges(placed, triangles, MIN_ANGLE_DEG);
const quantized = Int16Array.from(segments.flat(2), (value) => {
  const level = Math.round(value / SCALE);
  if (Math.abs(level) > 32767)
    throw Error(`${value} mm is outside the quantized range`);
  return level;
});
const binary = gzipSync(Buffer.from(quantized.buffer), { level: 9 });
writeFileSync(new URL("ge-engine-bracket-edges.bin", landing), binary);
writeFileSync(
  new URL("ge-engine-bracket-edges.json", landing),
  `${JSON.stringify(
    {
      source: "GE_engine_bracket.step (Onshape tessellated AP242 export)",
      sourceSha256: SOURCE_SHA256,
      generator: "scripts/generate-landing-edges.mjs",
      minAngleDeg: MIN_ANGLE_DEG,
      segmentCount: segments.length,
      offsetMm: offset,
      layout: {
        segments: {
          offset: 0,
          length: quantized.length,
          type: "Int16Array",
          scale: SCALE,
        },
      },
    },
    null,
    2,
  )}\n`,
);
console.log(
  `${segments.length} CAD edge segments (${binary.length} bytes gzipped), offset ${offset.map((v) => v.toFixed(3)).join(", ")} mm`,
);
