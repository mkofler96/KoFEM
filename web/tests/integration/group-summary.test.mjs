// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The support and load card numbers (KOF-494) from the engine's CAD face areas
// (cad_face_properties, KOF-493, the status bar's figures) through the Rust
// module's selectedArea and load summaries, as the cards call them.

import { beforeAll, describe, expect, test } from "bun:test";
import { plateWithHoleStep } from "../../../examples/gallery/step-prism.mjs";
import { decodeCadFaceProperties } from "../../src/lib/cadFaceProperties.ts";
import { groupArea, loadFigures } from "../../src/lib/groupSummary.ts";
import { TESSELLATION_OPTIONS } from "../support/step-parts.mjs";
import { loadEngine, loadFem } from "../support/wasm.mjs";

// Plate with a Ø3.2 hole (step-prism.mjs): faces 5 the hole, 6 z = 0, 7 z = t.
const radius = 1.6;
const half = 10;
const thickness = 4;
const plateArea = 4 * half * half - Math.PI * radius * radius;
const holeArea = 2 * Math.PI * radius * thickness;

let cadFaces = [];
beforeAll(async () => {
  await loadFem();
  const engine = await loadEngine();
  engine.tessellate_step(
    new TextEncoder().encode(
      plateWithHoleStep(radius, half, thickness, "Plate with a hole"),
    ),
    TESSELLATION_OPTIONS,
  );
  cadFaces = decodeCadFaceProperties(engine.cad_face_properties());
});

const entry = (id, cadFaceId, geometry = "face") => ({
  id,
  label: `Face ${id}`,
  nodeIds: [id],
  geometry,
  ...(cadFaceId === undefined ? {} : { cadFaceId }),
});

function expectClose(value, expected) {
  expect(Math.abs(value - expected) / Math.abs(expected)).toBeLessThan(1e-9);
}

describe("groupArea", () => {
  test("is the status bar's area of the picked face", () => {
    const area = groupArea([entry(1, 7)], cadFaces);
    expect(area.state).toBe("measured");
    expectClose(area.area, cadFaces[6].area);
    expectClose(area.area, plateArea);
  });

  test("adds the faces of a group", () => {
    const area = groupArea([entry(1, 7), entry(2, 5)], cadFaces);
    expectClose(area.area, plateArea + holeArea);
    expect(area.repeated).toEqual([]);
  });

  test("counts a face picked twice once and names it", () => {
    const area = groupArea([entry(1, 5), entry(2, 7), entry(3, 5)], cadFaces);
    expectClose(area.area, plateArea + holeArea);
    expect(area.repeated).toEqual([5]);
  });

  test("is not measured without geometry, nor on a point", () => {
    expect(groupArea([entry(1, 7)], null)).toEqual({ state: "noGeometry" });
    expect(groupArea([entry(1, 7, "point")], cadFaces)).toEqual({
      state: "unmeasured",
    });
  });

  test("is empty without a selection", () => {
    expect(groupArea([], cadFaces)).toEqual({ state: "empty" });
  });
});

describe("loadFigures", () => {
  const group = (fields) => ({
    id: 1,
    name: "Load 1",
    dof: 0,
    totalForce: 0,
    faces: [entry(1, 7)],
    ...fields,
  });

  test("a force: its magnitude, spread over the faces' area", () => {
    const figures = loadFigures(
      group({ kind: "force", components: [0, 0, -100] }),
      cadFaces,
      [],
    );
    expect(figures.kind).toBe("force");
    expect(figures.axes).toBe(1);
    expectClose(figures.value.total, 100);
    expectClose(figures.value.meanTraction, 100 / plateArea);
  });

  test("a pressure: pressure times the area", () => {
    const figures = loadFigures(
      group({
        kind: "pressure",
        totalForce: 2,
        faces: [entry(1, 6), entry(2, 7)],
      }),
      cadFaces,
      [],
    );
    expectClose(figures.value.total, 2 * 2 * plateArea);
    expect(figures.value.pressure).toBe(2);
  });

  test("a legacy single-axis force reads its dof and total", () => {
    const figures = loadFigures(
      group({ dof: 1, totalForce: -50 }),
      cadFaces,
      [],
    );
    expectClose(figures.value.total, 50);
  });

  test("a moment is applied once per face selection, as the solve applies it", () => {
    const figures = loadFigures(
      group({
        kind: "moment",
        components: [0, 0, 1000],
        faces: [entry(1, 6), entry(2, 7)],
      }),
      cadFaces,
      [],
    );
    expect(figures.value).toEqual({ each: 1000, applied: 2, total: 2000 });
  });

  test("a moment's point selections share it once, like the solve's", () => {
    const figures = loadFigures(
      group({
        kind: "moment",
        components: [0, 0, 1000],
        faces: [entry(1, undefined, "point"), entry(2, undefined, "point")],
      }),
      cadFaces,
      [],
    );
    expect(figures.value).toEqual({ each: 1000, applied: 1, total: 1000 });
  });

  test("a coupling's reference point is a point selection", () => {
    const refPoint = { ...entry(1, undefined), nodeIds: [99] };
    delete refPoint.geometry;
    const figures = loadFigures(
      group({ kind: "moment", components: [500, 0, 0], faces: [refPoint] }),
      cadFaces,
      [{ refNodeId: 99 }],
    );
    expect(figures.value).toEqual({ each: 500, applied: 1, total: 500 });
  });

  test("a group without faces has nothing to apply its value to", () => {
    const figures = loadFigures(
      group({ kind: "moment", components: [0, 0, 1000], faces: [] }),
      cadFaces,
      [],
    );
    expect(figures.area).toEqual({ state: "empty" });
    expect(figures.value).toBeNull();
  });

  test("a zero force has no value, not 0 N", () => {
    const figures = loadFigures(
      group({ kind: "force", components: [0, 0, 0] }),
      cadFaces,
      [],
    );
    expect(figures.value).toBeNull();
  });
});
