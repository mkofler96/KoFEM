// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A CAD mid-surface (KOF-498) from the engine to the shell solve. The engine's
// midSurface becomes the stored model through web/src/lib/cadShell.ts: CTRIA3
// facets, one PSHELL per thickness that inherits the Shell body's material,
// and the links from each facet and rim edge back to its CAD faces. Supports
// and loads are picked on the CAD faces, which stay the ground truth, and go
// through the code the app runs: the pick (cadShellPick) and the surface load
// the store builds from it (rebuildSurfaceLoads):
//   - a top face loads its facets, wound along its outward normal;
//   - a bottom face the same facets, wound the other way, along its own
//     outward normal;
//   - a side face picks the rim nodes it collapsed to.
// So a pressure on either face of the plate pushes into the plate (KOF-451),
// and an edge support is a pick of the side face.
//
// Model: NAFEMS LE6 (examples/validation/cases/nafems-le6.mjs), the 30° skew
// plate, 10 mm thick, edges held in Ux, Uy, Uz, 0.7 kPa on one face.

import { beforeAll, describe, expect, test } from "bun:test";
import {
  annulusStep,
  prismStep,
} from "../../../examples/gallery/step-prism.mjs";
import { buildCadShellModel, cadShellPick } from "../../src/lib/cadShell.ts";
import { shellThinWallRule } from "../../src/lib/shellize.ts";
import { buildShellEngineInputs } from "../../src/lib/solve/shell.ts";
import { rebuildSurfaceLoads } from "../../src/store/boundaryRebuild.ts";
import { solveShellInRust } from "../../src/lib/solve/shellRust.ts";
import { loadEngine, loadFem } from "../support/wasm.mjs";
import { TESSELLATION_OPTIONS } from "../support/step-parts.mjs";
import {
  allFaces,
  distanceFromLine,
  faceWhere,
} from "../support/cad-faces.mjs";

const SIDE = 1000; // mm
const THICKNESS = 10; // mm
const PRESSURE = 0.7e-3; // MPa
const SIZE = 25; // mm
const STEEL = {
  id: 1,
  name: "Steel",
  young: 210000,
  poisson: 0.3,
  density: 7.85e-9,
};
const cos30 = Math.cos(Math.PI / 6);
const sin30 = Math.sin(Math.PI / 6);
const RHOMBUS = [
  [0, 0],
  [SIDE, 0],
  [SIDE * (1 + cos30), SIDE * sin30],
  [SIDE * cos30, SIDE * sin30],
];
const CENTRE = [(SIDE * (1 + cos30)) / 2, (SIDE * sin30) / 2]; // E = (A + C) / 2

const neverContinue = async () => false;

// What a click on `cadFaceId` selects in the app.
function pick(shell, cadFaceId) {
  const picked = cadShellPick(shell.links, shell.elements, cadFaceId);
  if (!picked) throw new Error(`face ${cadFaceId} is not on the mid-surface`);
  return picked;
}

// The surface load the store builds from a pressure picked on `cadFaceId`.
function pressureOn(shell, cadFaceId, pressure) {
  const { geometry, nodeIds } = pick(shell, cadFaceId);
  const [load] = rebuildSurfaceLoads(
    [
      {
        id: 1,
        name: "Pressure",
        kind: "pressure",
        dof: 0,
        totalForce: pressure,
        faces: [{ id: 1, label: "Face", nodeIds, geometry, cadFaceId }],
      },
    ],
    shell.elements,
    [],
    shell.links,
  );
  return load;
}

let top = 0;
let bottom = 0;
let sides = [];
let model = null;
let ShellModel = null;

beforeAll(async () => {
  ({ ShellModel } = await loadFem());
  const engine = await loadEngine();
  const tessellation = engine.tessellate_step(
    new TextEncoder().encode(prismStep(RHOMBUS, THICKNESS, "NAFEMS LE6")),
    TESSELLATION_OPTIONS,
  );
  top = faceWhere(tessellation, (_x, _y, z) => Math.abs(z - THICKNESS) < 1e-6);
  bottom = faceWhere(tessellation, (_x, _y, z) => Math.abs(z) < 1e-6);
  sides = allFaces(tessellation).filter((f) => f !== top && f !== bottom);
  const dto = engine.generate_fem_mesh(
    JSON.stringify({
      max_element_size: SIZE,
      min_element_size: 0,
      shell_bodies: [1],
      thin_wall: shellThinWallRule(),
      grading: 0.3,
      second_order: false,
      elementsperedge: 2,
      elementspercurve: 2,
      optsteps_2d: 3,
      optsteps_3d: 3,
    }),
  );
  expect(dto.tetrahedra.length).toBe(0);
  model = buildCadShellModel(
    { nodes: [], elements: [], surfaceTriangles: [], surfaceFaceIds: [] },
    dto.midSurface,
    [{ id: 1, materialId: STEEL.id, discretization: "shell" }],
  );
});

describe("the stored model of a CAD mid-surface", () => {
  test("every element is a CTRIA3 of one PSHELL with the plate's thickness", () => {
    expect(model.elements.length).toBeGreaterThan(0);
    expect(model.elements.every((e) => e.type === "CTRIA3")).toBe(true);
    const shellProps = model.properties.filter((p) => p.sourceBodyId === 1);
    expect(shellProps).toEqual([
      {
        id: 2,
        materialId: STEEL.id,
        thickness: THICKNESS,
        discretization: "shell",
        sourceBodyId: 1,
      },
    ]);
    expect(model.elements.every((e) => e.propertyId === 2)).toBe(true);
    // The CAD body keeps its own property, so its material stays assigned.
    expect(model.properties.find((p) => p.id === 1)).toEqual({
      id: 1,
      materialId: STEEL.id,
      discretization: "shell",
    });
  });

  test("a facet's surface face id is its top face, so face picks still find it", () => {
    expect(model.surfaceTriangles.length).toBe(model.elements.length);
    expect(new Set(model.surfaceFaceIds)).toEqual(new Set([top]));
  });

  test("a pressure on the top or bottom face loads the same facets, wound oppositely", () => {
    const upper = pressureOn(model, top, PRESSURE).faces;
    const lower = pressureOn(model, bottom, PRESSURE).faces;
    expect(upper.length).toBe(model.elements.length);
    expect(lower.map(([a, b, c]) => [a, c, b])).toEqual(upper);
  });

  test("each side face picks the rim nodes on its edge of the rhombus", () => {
    const nodeById = new Map(model.nodes.map((n) => [n.id, n]));
    const covered = new Set();
    for (const face of sides) {
      const { geometry, nodeIds: ids } = pick(model, face);
      expect(geometry).toBe("edge");
      expect(ids.length).toBeGreaterThan(1);
      for (const id of ids) {
        covered.add(id);
        expect(Math.abs(nodeById.get(id).z - THICKNESS / 2)).toBeLessThan(1e-9);
      }
    }
    // Every node on the rhombus outline is on one of the four side faces.
    const onOutline = model.nodes.filter((n) =>
      RHOMBUS.some(
        (start, i) =>
          distanceFromLine(start, RHOMBUS[(i + 1) % 4], n.x, n.y) < 1e-6,
      ),
    );
    expect(onOutline.map((n) => n.id).sort((a, b) => a - b)).toEqual(
      [...covered].sort((a, b) => a - b),
    );
  });

  test("a face that is not on the mid-surface is no shell pick", () => {
    expect(cadShellPick(model.links, model.elements, 999)).toBeNull();
  });
});

describe("a pressure on either face of the plate pushes into it (KOF-451)", () => {
  let fromTop = 0;
  let fromBottom = 0;

  async function centreDeflection(loadedFace) {
    const constraints = [];
    for (const face of sides)
      for (const nodeId of pick(model, face).nodeIds)
        for (const dof of [0, 1, 2]) constraints.push({ nodeId, dof });
    const inputs = buildShellEngineInputs({
      nodes: model.nodes,
      elements: model.elements,
      materials: [STEEL],
      properties: model.properties,
      constraints,
      loads: [],
      surfaceLoads: [pressureOn(model, loadedFace, PRESSURE)],
    });
    const result = await solveShellInRust(
      { ShellModel },
      inputs,
      undefined,
      neverContinue,
      () => undefined,
    );
    let nearest = 0;
    let best = Infinity;
    model.nodes.forEach((n, i) => {
      const distance = Math.hypot(n.x - CENTRE[0], n.y - CENTRE[1]);
      if (distance < best) [best, nearest] = [distance, i];
    });
    return result.displacements[3 * nearest + 2];
  }

  beforeAll(async () => {
    fromTop = await centreDeflection(top);
    fromBottom = await centreDeflection(bottom);
  });

  test("a pressure on the upper face pushes the plate down", () => {
    expect(fromTop).toBeLessThan(0);
  });

  test("a pressure on the lower face pushes it up by the same amount", () => {
    expect(fromBottom).toBeGreaterThan(0);
    expect(Math.abs(fromBottom + fromTop)).toBeLessThan(
      1e-9 * Math.abs(fromTop),
    );
  });
});

// A pressure on the bore of a tube acts on the bore's area, 2π·r_inner·L, not
// on the mid-surface's 2π·r_mid·L: the facets it loads carry the bore's area.
describe("a pressure on a tube's bore pushes with the bore's area", () => {
  const INNER = 45; // mm
  const OUTER = 50; // mm
  const LENGTH = 300; // mm
  let radial = 0;

  beforeAll(async () => {
    const engine = await loadEngine();
    const tessellation = engine.tessellate_step(
      new TextEncoder().encode(annulusStep(INNER, OUTER, LENGTH, "Tube")),
      TESSELLATION_OPTIONS,
    );
    const bore = faceWhere(
      tessellation,
      (x, y) => Math.abs(Math.hypot(x, y) - INNER) < 1e-3,
    );
    const dto = engine.generate_fem_mesh(
      JSON.stringify({
        max_element_size: 5,
        min_element_size: 0,
        shell_bodies: [1],
        thin_wall: shellThinWallRule(),
        grading: 0.3,
        second_order: false,
        elementsperedge: 2,
        elementspercurve: 2,
        optsteps_2d: 3,
        optsteps_3d: 3,
      }),
    );
    const tube = buildCadShellModel(
      { nodes: [], elements: [], surfaceTriangles: [], surfaceFaceIds: [] },
      dto.midSurface,
      [{ id: 1, materialId: STEEL.id, discretization: "shell" }],
    );
    const load = pressureOn(tube, bore, PRESSURE);
    const inputs = buildShellEngineInputs({
      nodes: tube.nodes,
      elements: tube.elements,
      materials: [STEEL],
      properties: tube.properties,
      constraints: [],
      loads: [],
      surfaceLoads: [load],
    });
    const vertices = inputs.mesh.vertices;
    for (const { vertex, force } of JSON.parse(inputs.bcsJson).point_loads) {
      if (!force) continue;
      const px = vertices[3 * vertex];
      const py = vertices[3 * vertex + 1];
      radial += Math.abs(force[0] * px + force[1] * py) / Math.hypot(px, py);
    }
  });

  test("the radial load adds up to p · 2π · r_inner · L", () => {
    const expected = PRESSURE * 2 * Math.PI * INNER * LENGTH;
    expect(Math.abs(radial / expected - 1)).toBeLessThan(0.01);
  });
});
