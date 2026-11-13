// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for src/lib/sampleGuide.ts — the guide through the empty
// workspace's sample (KOF-261): which step the model is on, and that the CAD
// faces it asks the user to pick are the bolt holes and the hub bore of the
// shipped wall bracket. The browser path is tests/first-simulation.spec.ts.

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SAMPLE, guideStep, guideTargets } from "../../src/lib/sampleGuide.ts";
import { loadEngine } from "../support/wasm.mjs";

const face = (cadFaceId) => ({
  id: cadFaceId,
  label: `Face ${cadFaceId}`,
  nodeIds: [cadFaceId],
  geometry: "face",
  cadFaceId,
});
const support = (faces, dofs = [0, 1, 2], value = 0) => ({
  id: 1,
  name: "BC1",
  dofs,
  value,
  faces: faces.map(face),
});
const force = (faces, components = [0, -2000, 0], kind = "force") => ({
  id: 1,
  name: "Load1",
  dof: 1,
  totalForce: components[1],
  components,
  kind,
  faces: faces.map(face),
});
const holes = [...SAMPLE.boltHoleFaces];
const bore = [...SAMPLE.hubBoreFaces];
const step = (model) =>
  guideStep({
    meshed: true,
    bcGroups: [],
    loadGroups: [],
    solved: false,
    ...model,
  });

describe("steps", () => {
  const fixed = { bcGroups: [support(holes)] };
  const loaded = { ...fixed, loadGroups: [force(bore, [500, 0, 0])] };

  test("no mesh: mesh", () => {
    expect(step({ meshed: false })).toBe("mesh");
  });
  test("meshed, nothing else: support", () => {
    expect(step({})).toBe("support");
  });
  test("two of the three holes: still support", () => {
    expect(step({ bcGroups: [support(holes.slice(0, 2))] })).toBe("support");
  });
  test("all three holes, in two supports: load", () => {
    expect(
      step({
        bcGroups: [support(holes.slice(0, 1)), support(holes.slice(1))],
      }),
    ).toBe("load");
  });
  test("holes held in Ux only: still support", () => {
    expect(step({ bcGroups: [support(holes, [0])] })).toBe("support");
  });
  test("holes moved by a prescribed displacement: still support", () => {
    expect(step({ bcGroups: [support(holes, [0, 1, 2], 0.1)] })).toBe(
      "support",
    );
  });
  test("a force on the wrong face: still load", () => {
    expect(step({ ...fixed, loadGroups: [force([1])] })).toBe("load");
  });
  test("a zero force on the bore: still load", () => {
    expect(step({ ...fixed, loadGroups: [force(bore, [0, 0, 0])] })).toBe(
      "load",
    );
  });
  test("a pressure on the bore: still load", () => {
    expect(
      step({ ...fixed, loadGroups: [force(bore, [0, 0, 0], "pressure")] }),
    ).toBe("load");
  });
  test("any force on the bore: run", () => {
    expect(step(loaded)).toBe("run");
  });
  test("solved: done", () => {
    expect(step({ ...loaded, solved: true })).toBe("done");
  });
  test("a result without the setup does not skip a step", () => {
    expect(step({ solved: true })).toBe("support");
  });
  test("targets: the holes, then the bore, else none", () => {
    expect(guideTargets("support")).toBe(SAMPLE.boltHoleFaces);
    expect(guideTargets("load")).toBe(SAMPLE.hubBoreFaces);
    expect(guideTargets("mesh")).toBeNull();
    expect(guideTargets("run")).toBeNull();
    expect(guideTargets("done")).toBeNull();
  });
});

// The guide names faces by number, and those numbers are only right for the
// file the app ships. Mesh it the way the app does and check them.
describe("the shipped wall bracket", () => {
  let mesh;

  beforeAll(async () => {
    const Module = await loadEngine();
    Module.tessellate_step(
      new Uint8Array(
        readFileSync(new URL(`../../public/${SAMPLE.url}`, import.meta.url)),
      ),
      JSON.stringify({ deflection_relative: 0.001, angular_deflection: 0.5 }),
    );
    mesh = Module.generate_fem_mesh(
      JSON.stringify({
        max_element_size: 20,
        min_element_size: 2,
        grading: 0.3,
        second_order: false,
        elementsperedge: 2.0,
        elementspercurve: 2.0,
        optsteps_2d: 3,
        optsteps_3d: 3,
      }),
    );
    Module.free_geometry_cache();
  });

  // The mesh's points on CAD face `id`, and the cylinder they lie on: the
  // axis along `axis`, through the middle of the points' extent across it.
  function cylinder(id, axis) {
    const nodes = new Set();
    mesh.surfaceFaceIds.forEach((faceId, triangle) => {
      if (faceId === id)
        for (let corner = 0; corner < 3; corner++)
          nodes.add(mesh.surfaceTriangles[3 * triangle + corner]);
    });
    const points = [...nodes].map((node) =>
      [0, 1, 2].map((component) => mesh.vertices[3 * node + component]),
    );
    const across = [0, 1, 2].filter((component) => component !== axis);
    const lo = (component) => Math.min(...points.map((p) => p[component]));
    const hi = (component) => Math.max(...points.map((p) => p[component]));
    const centre = across.map(
      (component) => (lo(component) + hi(component)) / 2,
    );
    const radii = points.map((p) =>
      Math.hypot(p[across[0]] - centre[0], p[across[1]] - centre[1]),
    );
    return {
      centre,
      length: hi(axis) - lo(axis),
      rMin: Math.min(...radii),
      rMax: Math.max(...radii),
    };
  }

  // Bolt holes: Ø16 mm through the 10 mm wall plate (normal x), at
  // (y, z) = (±38, −20) and (0, −118).
  test("the bolt-hole faces are Ø16 bores through the 10 mm plate at the three bolt positions", () => {
    const holeCentres = holes.map((id) => {
      const bolt = cylinder(id, 0);
      const detail = `face ${id}: ${JSON.stringify(bolt)}`;
      expect(bolt.rMin, detail).toBeGreaterThan(7.9);
      expect(bolt.rMax, detail).toBeLessThan(8.1);
      expect(Math.abs(bolt.length - 10), detail).toBeLessThanOrEqual(0.01);
      return bolt.centre.map((value) => Math.round(value)).join(",");
    });
    expect(holeCentres.sort().join(" ")).toBe("-38,-20 0,-118 38,-20");
  });

  // Hub bore: Ø20 mm along z, the full 54 mm length of the hub.
  test("the hub-bore face is the Ø20 bore through the hub", () => {
    const hub = cylinder(bore[0], 2);
    const detail = `face ${bore[0]}: ${JSON.stringify(hub)}`;
    expect(bore).toHaveLength(1);
    expect(hub.rMin, detail).toBeGreaterThan(9.9);
    expect(hub.rMax, detail).toBeLessThan(10.1);
    expect(Math.abs(hub.length - 54), detail).toBeLessThanOrEqual(0.01);
    expect(Math.abs(hub.centre[0] - 85), detail).toBeLessThanOrEqual(0.01);
    expect(Math.abs(hub.centre[1]), detail).toBeLessThanOrEqual(0.01);
  });
});
