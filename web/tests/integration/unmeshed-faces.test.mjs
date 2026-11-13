// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A face far narrower than an element (KOF-292): Netgen gives up on it but
// still reports success. The volume fill used to run on what was left and
// either trap with "Illegal position in Geomsearch" or report overlaps that
// are not in the geometry. generate_fem_mesh must name the face instead.
//
// The sliver is made the way a user makes one: two face splits 0.01 mm apart
// across the outer cylinder of tube.stp leave a 0.01 mm ring between them.

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { loadEngine } from "../support/wasm.mjs";

const TESSELLATION = JSON.stringify({
  deflection_relative: 0.001,
  angular_deflection: 0.5,
  format: "step",
});
const RING = 0.01; // mm
const CUT = 30; // mm, halfway up the 60 mm tube

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

// The face of the outer cylinder (radius ~20 mm) spanning z from `from` up.
function outerCylinderAbove(tessellation, from) {
  const { vertices, triangles, triangleFaceIds } = tessellation;
  const span = new Map();
  for (let tri = 0; tri < triangleFaceIds.length; tri++) {
    const face = triangleFaceIds[tri];
    const extent = span.get(face) ?? { low: Infinity, radius: Infinity };
    for (let corner = 0; corner < 3; corner++) {
      const at = 3 * triangles[3 * tri + corner];
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

describe("a face Netgen cannot mesh is reported, not volume-filled", () => {
  let result;
  let log;
  let overlaps;
  let ring;
  let facesBefore;
  let facesAfter;
  let remeshed;
  let refused;

  beforeAll(async () => {
    // The engine's log is kept and shown in the message of the first check,
    // where Netgen's "GIVING UP" / "NOT ALL FACES HAVE BEEN MESHED" lines
    // explain a failure.
    const engineLog = [];
    const engine = await loadEngine({
      print: (line) => engineLog.push(line),
      printErr: (line) => engineLog.push(line),
    });
    const load = (bytes) => engine.tessellate_step(bytes, TESSELLATION);
    const splitAt = (height, faceId) => {
      const { bytes } = engine.split_geometry(
        JSON.stringify({
          mode: "faces",
          origin: [0, 0, height],
          normal: [0, 0, 1],
          faceIds: [faceId],
        }),
      );
      return load(bytes);
    };

    // The sliver is made the way a user makes one: two face splits 0.01 mm
    // apart across the outer cylinder of tube.stp leave a 0.01 mm ring
    // between them.
    let tessellation = load(
      new Uint8Array(
        readFileSync(new URL("../../../test_files/tube.stp", import.meta.url)),
      ),
    );
    tessellation = splitAt(CUT, outerCylinderAbove(tessellation, 0));
    tessellation = splitAt(CUT + RING, outerCylinderAbove(tessellation, CUT));
    ring = outerCylinderAbove(tessellation, CUT);

    result = engine.generate_fem_mesh(OPTIONS);
    overlaps = "overlaps" in result ? result.overlaps : [];
    log = engineLog.join("\n");

    // Removing the ring closes the gap with the cylinder around it, and the
    // part meshes. The two halves of the cylinder stay apart: removing the
    // ring takes out a 0.01 mm band, not more.
    const { bytes } = engine.remove_faces(JSON.stringify({ faceIds: [ring] }));
    const repaired = load(bytes);
    facesBefore = new Set(tessellation.triangleFaceIds).size;
    facesAfter = new Set(repaired.triangleFaceIds).size;
    remeshed = engine.generate_fem_mesh(OPTIONS);

    // A face that can't be removed is an error, never a silent no-op.
    load(bytes);
    refused = "";
    try {
      engine.remove_faces(JSON.stringify({ faceIds: [999] }));
    } catch (error) {
      refused = String(engine.getExceptionMessage?.(error) ?? error);
    }
  });

  test("no mesh is returned", () => {
    expect("overlaps" in result, log).toBe(true);
  });

  test("only the ring is reported, as unmeshed", () => {
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].kind).toBe("unmeshed");
    expect(Array.from(overlaps[0].faceIds)).toEqual([ring]);
  });

  test("its width is the ring's height", () => {
    expect(overlaps[0].width).toBeDefined();
    expect(Math.abs(overlaps[0].width - RING)).toBeLessThan(1e-4);
  });

  test("it is highlighted with the face's display tessellation", () => {
    expect(overlaps[0].positions.length).toBeGreaterThan(0);
    expect(overlaps[0].positions.length % 9).toBe(0);
  });

  test("the ring is gone", () => {
    expect(facesAfter, `${facesBefore} -> ${facesAfter} faces`).toBe(
      facesBefore - 2,
    );
  });

  test("the part meshes after the removal", () => {
    expect("overlaps" in remeshed).toBe(false);
    expect(remeshed.tetrahedra.length).toBeGreaterThan(0);
  });

  test("an unknown face is refused", () => {
    expect(refused).not.toBe("");
  });
});
