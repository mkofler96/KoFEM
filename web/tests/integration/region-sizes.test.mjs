// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Region mesh sizes live in Netgen's static, shape-keyed size table
// (KOF-426). kofem_set_solid_max_sizes must reset or reassign every entry on
// each mesh, or a later mesh of the same shape in the same engine instance
// keeps the sizes of an earlier one. The app hides this today by meshing in a
// fresh worker each time; node-side callers that mesh twice in one engine do
// not.
//
// tube.stp is split at mid-height into two regions, meshed with sizes, then
// remeshed in the same engine. Each remesh must equal the same mesh from a
// fresh engine.

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { loadEngine } from "../support/wasm.mjs";

const TUBE = new Uint8Array(
  readFileSync(new URL("../../../test_files/tube.stp", import.meta.url)),
);
const TESSELLATION = JSON.stringify({
  deflection_relative: 0.001,
  angular_deflection: 0.5,
  format: "step",
});
const CUT = 30; // mm, halfway up the 60 mm tube

const FINE = 3; // mm
const COARSE = 15; // mm

function options(solidMaxSizes) {
  return JSON.stringify({
    max_element_size: COARSE,
    min_element_size: 0.5,
    ...(solidMaxSizes ? { solid_max_sizes: solidMaxSizes } : {}),
    grading: 0.3,
    second_order: false,
    elementsperedge: 2,
    elementspercurve: 2,
    optsteps_2d: 3,
    optsteps_3d: 3,
  });
}

// A new engine holding tube.stp split into two solids at z = CUT.
async function splitTube() {
  const engine = await loadEngine();
  engine.tessellate_step(TUBE, TESSELLATION);
  const { bytes } = engine.split_geometry(
    JSON.stringify({
      mode: "bodies",
      origin: [0, 0, CUT],
      normal: [0, 0, 1],
      bodyIds: [1],
    }),
  );
  engine.tessellate_step(bytes, TESSELLATION);
  return engine;
}

// What a mesh is compared by: its size, and its tets per body.
function summary(engine, solidMaxSizes) {
  const mesh = engine.generate_fem_mesh(options(solidMaxSizes));
  if ("overlaps" in mesh)
    throw new Error(
      `tube.stp did not mesh with sizes ${JSON.stringify(solidMaxSizes)}: ${JSON.stringify(mesh.overlaps)}`,
    );
  const tetsPerBody = {};
  for (const body of mesh.bodyIds)
    tetsPerBody[body] = (tetsPerBody[body] ?? 0) + 1;
  return {
    nodes: mesh.vertices.length / 3,
    tets: mesh.tetrahedra.length / 4,
    tetsPerBody,
  };
}

describe("region mesh sizes do not outlive the mesh they were set for", () => {
  // One engine, meshed three times in a row.
  let fineFirst = null;
  let cleared = null;
  let fineSecond = null;
  // Each from its own fresh engine.
  let freshDefault = null;
  let freshFineSecond = null;

  beforeAll(async () => {
    const engine = await splitTube();
    fineFirst = summary(engine, [FINE, COARSE]);
    cleared = summary(engine, undefined);
    summary(engine, [FINE, COARSE]);
    fineSecond = summary(engine, [COARSE, FINE]);

    freshDefault = summary(await splitTube(), undefined);
    freshFineSecond = summary(await splitTube(), [COARSE, FINE]);
  });

  test("the split tube has two bodies", () => {
    expect(Object.keys(freshDefault.tetsPerBody)).toHaveLength(2);
  });

  test("the finer region gets more tets", () => {
    const [first, second] = Object.values(fineFirst.tetsPerBody);
    expect(first).toBeGreaterThan(second);
  });

  test("region sizes make the mesh finer than the default", () => {
    expect(fineFirst.tets).toBeGreaterThan(freshDefault.tets);
  });

  test("clearing the sizes gives the default mesh back", () => {
    expect(cleared).toEqual(freshDefault);
  });

  test("new sizes replace the old ones", () => {
    expect(fineSecond).toEqual(freshFineSecond);
    const [first, second] = Object.values(fineSecond.tetsPerBody);
    expect(second).toBeGreaterThan(first);
  });
});
