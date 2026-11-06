#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A face far narrower than an element (KOF-292): Netgen gives up on it but
// still reports success. The volume fill used to run on what was left and
// either trap with "Illegal position in Geomsearch" or report overlaps that
// are not in the geometry. generate_fem_mesh must name the face instead.
//
// The sliver is made the way a user makes one: two face splits 0.01 mm apart
// across the outer cylinder of tube.stp leave a 0.01 mm ring between them.
//
// Run: bun tests/test_unmeshed_faces.mjs   (from the web/ directory)

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPkg = join(__dirname, "../src/wasm/pkg");
const { default: createModule } = await import(
  join(wasmPkg, "kofem_wasm_emcc.js")
);
const engine = await createModule({
  wasmBinary: readFileSync(join(wasmPkg, "kofem_wasm_emcc.wasm")).buffer,
  print: () => {},
  printErr: () => {},
});

let failed = 0;
function check(label, ok, detail = "") {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`,
  );
  if (!ok) failed++;
}

const TESSELLATION = JSON.stringify({
  deflection_relative: 0.001,
  angular_deflection: 0.5,
  format: "step",
});
const RING = 0.01; // mm
const CUT = 30; // mm, halfway up the 60 mm tube

function load(bytes) {
  return engine.tessellate_step(bytes, TESSELLATION);
}

// The face of the outer cylinder (radius ~20 mm) spanning z from `from` up.
function outerCylinderAbove(tessellation, from) {
  const { vertices, triangles, triangleFaceIds } = tessellation;
  const span = new Map();
  for (let t = 0; t < triangleFaceIds.length; t++) {
    const face = triangleFaceIds[t];
    const extent = span.get(face) ?? { low: Infinity, radius: Infinity };
    for (let k = 0; k < 3; k++) {
      const at = 3 * triangles[3 * t + k];
      extent.low = Math.min(extent.low, vertices[at + 2]);
      extent.radius = Math.min(
        extent.radius,
        Math.hypot(vertices[at], vertices[at + 1]),
      );
    }
    span.set(face, extent);
  }
  const faces = [...span].filter(
    ([, extent]) => extent.radius > 19 && Math.abs(extent.low - from) < 1e-6,
  );
  if (faces.length !== 1)
    throw new Error(
      `expected one outer-cylinder face from z=${from}, found ${faces.length}`,
    );
  return faces[0][0];
}

function splitAt(z, faceId) {
  const { bytes } = engine.split_geometry(
    JSON.stringify({
      mode: "faces",
      origin: [0, 0, z],
      normal: [0, 0, 1],
      faceIds: [faceId],
    }),
  );
  return load(bytes);
}

let tessellation = load(
  new Uint8Array(readFileSync(join(__dirname, "../../test_files/tube.stp"))),
);
tessellation = splitAt(CUT, outerCylinderAbove(tessellation, 0));
tessellation = splitAt(CUT + RING, outerCylinderAbove(tessellation, CUT));
const ring = outerCylinderAbove(tessellation, CUT);

const OPTIONS = JSON.stringify({
  max_element_size: 5,
  min_element_size: 0.5,
  grading: 0.3,
  second_order: false,
  elementsperedge: 2,
  elementspercurve: 2,
  optsteps_2d: 3,
  optsteps_3d: 3,
});
const result = engine.generate_fem_mesh(OPTIONS);

check("no mesh is returned", "overlaps" in result);
const overlaps = "overlaps" in result ? result.overlaps : [];
check(
  "only the ring is reported, as unmeshed",
  overlaps.length === 1 &&
    overlaps[0].kind === "unmeshed" &&
    overlaps[0].faceIds.length === 1 &&
    overlaps[0].faceIds[0] === ring,
  JSON.stringify(
    overlaps.map((o) => ({ kind: o.kind, faceIds: Array.from(o.faceIds) })),
  ),
);
const width = overlaps[0]?.width;
check(
  "its width is the ring's height",
  width !== undefined && Math.abs(width - RING) < 1e-4,
  String(width),
);
check(
  "it is highlighted with the face's display tessellation",
  overlaps[0]?.positions.length > 0 && overlaps[0].positions.length % 9 === 0,
);

// Removing the ring closes the gap with the cylinder around it, and the part
// meshes. The two halves of the cylinder stay apart: removing the ring takes
// out a 0.01 mm band, not more.
const { bytes } = engine.remove_faces(JSON.stringify({ faceIds: [ring] }));
const repaired = load(bytes);
check(
  "the ring is gone",
  new Set(repaired.triangleFaceIds).size ===
    new Set(tessellation.triangleFaceIds).size - 2,
  `${new Set(tessellation.triangleFaceIds).size} -> ${new Set(repaired.triangleFaceIds).size} faces`,
);
const remeshed = engine.generate_fem_mesh(OPTIONS);
check(
  "the part meshes after the removal",
  !("overlaps" in remeshed) && remeshed.tetrahedra.length > 0,
);

// A face that can't be removed is an error, never a silent no-op.
load(bytes);
let refused = "";
try {
  engine.remove_faces(JSON.stringify({ faceIds: [999] }));
} catch (error) {
  refused = String(engine.getExceptionMessage?.(error) ?? error);
}
check("an unknown face is refused", refused !== "", refused);

if (failed > 0) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("✓ a face Netgen cannot mesh is reported, not volume-filled");
