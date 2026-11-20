// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The two coupling models of the Theory article on kinematic and distributing
// couplings, built and solved the way the app builds and solves them: a STEP
// file meshed by the engine (Netgen), the store's model, and the worker's
// coupled solid solve in the Rust module (buildCoupledEngineInputs →
// solveCoupledSolidInRust → mapMixedResult).
//
//   screwHead   a plate with a clearance hole, its lower face fixed on a rigid
//               base; a screw head bears on the ring of the top face around
//               the hole. The plate is two bonded solids, the ring under the
//               head and the rest, so the ring is its own face (as a user
//               splits it off to pick it) and is meshed finer.
//               The ring is coupled to a point on the screw axis, at the
//               height of the top face, which carries the screw force.
//   cantilever  a square bar clamped at its root; its free end face is
//               coupled to a point at the face centre, which carries a
//               transverse force or a torque.

import { freshEngine } from "../../../examples/validation/lib/pipeline.mjs";
import { rustFem } from "../../../examples/validation/lib/solver.mjs";
import { APP_STEEL } from "../../../examples/validation/lib/recipe.mjs";
import {
  circleLoop,
  extrudedProfilesStep,
  line,
  prismStep,
} from "../../../examples/gallery/step-prism.mjs";
import {
  buildCoupledEngineInputs,
  mapMixedResult,
} from "../../src/lib/solve/coupled.ts";
import { solveCoupledSolidInRust } from "../../src/lib/solve/amg.ts";
import { nodeVonMisesField } from "../../src/lib/resultField.ts";

export const KINDS = ["kinematic", "distributing"];
export const MATERIAL = APP_STEEL;
const ORDER = 2;

/** The screw-head model's dimensions (mm) and load (N). */
export const SCREW = Object.freeze({
  halfWidth: 16,
  thickness: 6,
  holeRadius: 4.5, // M8 clearance hole
  headRadius: 8, // the head (or washer) bears out to this radius
  force: 5000, // screw force, pressing the head into the plate (−z)
  meshSize: 1.25, // the plate
  ringMeshSize: 0.5, // the ring under the head
});

/** The cantilever's dimensions (mm) and loads (N, N·mm). */
export const BAR = Object.freeze({
  side: 20,
  length: 200,
  force: 1000, // transverse tip force (−y)
  torque: 100000, // tip torque about the bar axis (+z)
  meshSize: 4,
});

const TESSELLATE = JSON.stringify({
  deflection_relative: 0.001,
  angular_deflection: 0.5,
});

/**
 * Mesh STEP text as the app does; the mesh with its CAD face of each surface
 * triangle. `solidSizes` gives each solid its own largest element size.
 */
async function meshStep(stepText, maxElementSize, solidSizes) {
  const engine = await freshEngine();
  engine.tessellate_step(new TextEncoder().encode(stepText), TESSELLATE);
  const mesh = engine.generate_fem_mesh(
    JSON.stringify({
      max_element_size: maxElementSize,
      min_element_size: maxElementSize / 10,
      grading: 0.3,
      second_order: false,
      elementsperedge: 2.0,
      elementspercurve: 2.0,
      optsteps_2d: 3,
      optsteps_3d: 3,
      ...(solidSizes ? { solid_max_sizes: solidSizes } : {}),
    }),
  );
  if ("overlaps" in mesh)
    throw new Error(`Netgen reports ${mesh.overlaps.length} overlaps`);
  engine.free_geometry_cache();
  return mesh;
}

/** The store model of a mesh: nodes, CTETRA elements, one steel body. */
function storeModel(mesh) {
  const nodes = Array.from({ length: mesh.vertices.length / 3 }, (_, i) => ({
    id: i,
    x: mesh.vertices[3 * i],
    y: mesh.vertices[3 * i + 1],
    z: mesh.vertices[3 * i + 2],
  }));
  // The store keeps linear tetrahedra; the solve raises the order (ORDER).
  const elements = Array.from({ length: mesh.bodyIds.length }, (_, i) => ({
    id: i,
    type: "CTETRA",
    nodeIds: Array.from(mesh.tetrahedra.subarray(4 * i, 4 * i + 4)),
    propertyId: 1,
  }));
  return {
    nodes,
    elements,
    materials: [{ id: 1, ...MATERIAL }],
    properties: [{ id: 1, materialId: 1 }],
    constraints: [],
    loads: [],
    surfaceLoads: [],
    couplings: [],
    tieGroups: [],
  };
}

/** The node ids on the given CAD faces, from the mesh's surface triangles. */
function faceNodes(mesh, faces) {
  const wanted = new Set(faces);
  const ids = new Set();
  for (let t = 0; t < mesh.surfaceFaceIds.length; t++)
    if (wanted.has(mesh.surfaceFaceIds[t]))
      for (let k = 0; k < 3; k++) ids.add(mesh.surfaceTriangles[3 * t + k]);
  return [...ids];
}

/** The ids of the nodes elements use that satisfy `test`. */
function solidNodes(model, test) {
  const used = new Set(model.elements.flatMap((e) => e.nodeIds));
  return [...used].filter((id) => test(model.nodes[id]));
}

/** A reference point: a store node no element uses. */
function addPoint(model, [x, y, z]) {
  const id = model.nodes.length;
  model.nodes.push({ id, x, y, z });
  return id;
}

const clamp = (ids) =>
  ids.flatMap((nodeId) => [0, 1, 2].map((dof) => ({ nodeId, dof })));

/**
 * Solve a store model through the worker's coupled solid path. The nodal
 * von Mises field is averaged as the app averages it for display.
 */
async function solve(model) {
  const fem = await rustFem();
  const inputs = buildCoupledEngineInputs(model, () => {});
  const raw = await solveCoupledSolidInRust(
    fem,
    inputs,
    ORDER,
    "amg",
    undefined,
    () => {
      throw new Error("the CG budget ran out");
    },
    () => {},
  );
  const result = mapMixedResult(model, inputs.model, raw);
  const nodal = nodeVonMisesField(result, model.nodes, model.elements);
  if (!nodal) throw new Error("the solve returned no von Mises stress");
  return { ...result, nodalVonMises: nodal };
}

/** The STEP text of the screw-head plate: the ring under the head, bonded to the rest. */
export function screwPlateStep() {
  const { halfWidth: b, holeRadius: a, headRadius: r, thickness: t } = SCREW;
  return extrudedProfilesStep(
    [
      {
        outer: circleLoop([0, 0], r, true),
        holes: [circleLoop([0, 0], a, false)],
      },
      {
        outer: [line([b, -b]), line([b, b]), line([-b, b]), line([-b, -b])],
        holes: [circleLoop([0, 0], r, false)],
      },
    ],
    t,
    "Plate",
  );
}

/** The screw-head model with the given coupling kind, solved. */
export async function screwHead(kind) {
  const s = SCREW;
  const mesh = await meshStep(screwPlateStep(), s.meshSize, [
    s.ringMeshSize,
    s.meshSize,
  ]);
  const model = storeModel(mesh);
  const tol = 1e-6;
  // The lower face stands on a rigid base: fixed.
  model.constraints = clamp(solidNodes(model, ({ z }) => Math.abs(z) < tol));
  // The ring under the head: the top face out to the head's radius.
  const ring = solidNodes(
    model,
    ({ x, y, z }) =>
      Math.abs(z - s.thickness) < tol && Math.hypot(x, y) <= s.headRadius + tol,
  );
  const point = addPoint(model, [0, 0, s.thickness]);
  model.couplings = [
    {
      name: "Screw head",
      kind,
      dofs: [0, 1, 2, 3, 4, 5],
      refNodeId: point,
      faces: [{ nodeIds: ring }],
    },
  ];
  model.loads = [{ nodeId: point, dof: 2, value: -s.force }];
  return { model, mesh, ring, point, result: await solve(model) };
}

/** The cantilever with the given coupling kind and tip load, solved. */
export async function cantilever(kind, load) {
  const b = BAR;
  const h = b.side / 2;
  const mesh = await meshStep(
    prismStep(
      [
        [-h, -h],
        [h, -h],
        [h, h],
        [-h, h],
      ],
      b.length,
      "Bar",
    ),
    b.meshSize,
  );
  const model = storeModel(mesh);
  // Faces of prismStep: 1–4 the sides, 5 the root z = 0, 6 the tip.
  model.constraints = clamp(faceNodes(mesh, [5]));
  const tip = faceNodes(mesh, [6]);
  const point = addPoint(model, [0, 0, b.length]);
  model.couplings = [
    {
      name: "Tip",
      kind,
      dofs: [0, 1, 2, 3, 4, 5],
      refNodeId: point,
      faces: [{ nodeIds: tip }],
    },
  ];
  model.loads =
    load === "bending"
      ? [{ nodeId: point, dof: 1, value: -b.force }]
      : [{ nodeId: point, dof: 5, value: b.torque }];
  return { model, mesh, ring: tip, point, result: await solve(model) };
}
