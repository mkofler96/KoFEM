// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Result probes (KOF-389): the plotted field and the displacement vector read
// at a point the user clicked on the result. Pure, no React / Three.js.
//
// A probe is anchored to the CAD face it was placed on and to a point in model
// space (undeformed, mm). It is resolved on every read: the nearest point of
// that face's surface triangles on the current mesh, found with the hand
// check's face lookup (meshCadFaceTriangles). So a probe stays on its face
// across a re-mesh and shows the new solve's value. Where the clicked triangle
// has no CAD face behind it, the probe holds that triangle instead and is
// valid on that mesh only.

import type {
  Element,
  Node,
  ResultType,
  SolverResult,
} from "../store/modelStore";
import { meshCadFaceTriangles, type CadFacedMesh } from "./handCheck";
import { nodalResultValues } from "./resultField";
import type { ShellSurface } from "./stressFields";

type Vec3 = [number, number, number];
type Tri = [number, number, number];

export type ResultProbe = {
  // Shown as "P<id>"; never reused within a model.
  id: number;
  // Where the probe was placed, on the undeformed surface (mm).
  point: Vec3;
} & (
  { cadFaceId: number; triangle?: never } | { triangle: Tri; cadFaceId?: never }
);

export interface ProbeModel extends CadFacedMesh {
  nodes: Node[];
  elements: Element[];
  result: SolverResult;
}

export type ProbeReading =
  | {
      kind: "value";
      // The point read, on the current mesh's undeformed surface (mm).
      at: Vec3;
      // The displacement vector there (mm).
      displacement: Vec3;
      // The plotted field there, interpolated from the nodal values the colour
      // map draws, in the field's unit (resultUnit).
      value: number;
    }
  | { kind: "unreadable"; reason: string };

export const probeLabel = (probe: { id: number }) => `P${probe.id}`;

// Barycentric weights of the point of triangle (a, b, c) nearest to p
// (Ericson, Real-Time Collision Detection, 5.1.5).
function closestWeights(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const sub = (u: Vec3, v: Vec3): Vec3 => [
    u[0] - v[0],
    u[1] - v[1],
    u[2] - v[2],
  ];
  const dot = (u: Vec3, v: Vec3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return [1, 0, 0];
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return [0, 1, 0];
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const alongAB = d1 / (d1 - d3);
    return [1 - alongAB, alongAB, 0];
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return [0, 0, 1];
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const alongAC = d2 / (d2 - d6);
    return [1 - alongAC, 0, alongAC];
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const alongBC = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return [0, 1 - alongBC, alongBC];
  }
  const denom = 1 / (va + vb + vc);
  const wb = vb * denom;
  const wc = vc * denom;
  return [1 - wb - wc, wb, wc];
}

const blend = (w: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 => [
  w[0] * a[0] + w[1] * b[0] + w[2] * c[0],
  w[0] * a[1] + w[1] * b[1] + w[2] * c[1],
  w[0] * a[2] + w[1] * b[2] + w[2] * c[2],
];

// The point of the undeformed triangle that a click on the deformed one
// stands for: the same barycentric weights, applied to the undeformed corners.
export function undeformedPoint(
  deformed: [Vec3, Vec3, Vec3],
  undeformed: [Vec3, Vec3, Vec3],
  clicked: Vec3,
): Vec3 {
  return blend(closestWeights(clicked, ...deformed), ...undeformed);
}

const sentence = (message: string) => {
  const text = message.charAt(0).toUpperCase() + message.slice(1);
  return text.endsWith(".") ? text : `${text}.`;
};

// The nodal values the colour map draws for `field`, by node index. Throws when
// the result does not belong to this mesh or lacks the field.
function nodalField(
  model: ProbeModel,
  field: ResultType,
  surface: ShellSurface,
): (i: number) => number {
  const { nodes, elements, result } = model;
  const disp = result.displacements;
  if (disp.length !== 3 * nodes.length)
    throw new Error(
      `The result has ${disp.length} displacement values for ${nodes.length} nodes; it belongs to a different mesh.`,
    );
  const values = nodalResultValues(result, field, nodes, elements, surface);
  if (!values)
    throw new Error(
      field === "Von Mises stress"
        ? "The result has no von Mises stress."
        : `The result has no ${field.toLowerCase()}; solve again to compute it.`,
    );
  return (i) => values[i];
}

// A probe anchor for a point given by its coordinates (KOF-447): the CAD face
// of the surface triangle nearest the point (or that triangle, where it has no
// CAD face), so the probe reads the point as one placed there by a click. A
// point on an edge between faces reads the same either way: the plotted field
// is continuous at the nodes.
export function anchorAtPoint(
  point: Vec3,
  model: CadFacedMesh & { nodes: Node[] },
): { point: Vec3 } & ({ cadFaceId: number } | { triangle: Tri }) {
  if (!point.every(Number.isFinite))
    throw new Error(`A probe point must be finite, got ${point.join(", ")}`);
  const { surfaceTriangles, surfaceFaceIds, nodes } = model;
  if (!surfaceTriangles || surfaceTriangles.length === 0)
    throw new Error("The mesh has no surface triangles to place a probe on");
  if (surfaceFaceIds && surfaceFaceIds.length !== surfaceTriangles.length)
    throw new Error(
      `the mesh has ${surfaceTriangles.length} surface triangles but ${surfaceFaceIds.length} CAD face ids`,
    );
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const position = (id: number): Vec3 => {
    const i = index.get(id);
    if (i === undefined)
      throw new Error(
        `A surface triangle refers to node ${id}, which is not in the mesh`,
      );
    return [nodes[i].x, nodes[i].y, nodes[i].z];
  };
  let best = -1;
  let bestDist = Infinity;
  surfaceTriangles.forEach((tri, t) => {
    const [a, b, c] = tri.map(position);
    const at = blend(closestWeights(point, a, b, c), a, b, c);
    const dist =
      (at[0] - point[0]) ** 2 +
      (at[1] - point[1]) ** 2 +
      (at[2] - point[2]) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = t;
    }
  });
  const cadFaceId = surfaceFaceIds?.[best];
  return cadFaceId !== undefined
    ? { point, cadFaceId }
    : { point, triangle: [...surfaceTriangles[best]] };
}

export interface ExtremeReading {
  nodeId: number;
  // The node, undeformed (mm), and its displacement vector (mm).
  at: Vec3;
  displacement: Vec3;
  value: number;
}

// The min/max probes: the nodes where the plotted field is lowest and highest
// (the first such node on a tie). Over every node, like the legend range and
// the panel's Min and max rows, so the probes show the same numbers.
export function fieldExtremes(
  model: ProbeModel,
  field: ResultType,
  surface: ShellSurface,
): { min: ExtremeReading; max: ExtremeReading } {
  const { nodes, result } = model;
  if (nodes.length === 0) throw new Error("The mesh has no nodes.");
  const nodal = nodalField(model, field, surface);
  let lo = 0;
  let hi = 0;
  for (let i = 1; i < nodes.length; i++) {
    const value = nodal(i);
    if (value < nodal(lo)) lo = i;
    if (value > nodal(hi)) hi = i;
  }
  const disp = result.displacements;
  const reading = (i: number): ExtremeReading => ({
    nodeId: nodes[i].id,
    at: [nodes[i].x, nodes[i].y, nodes[i].z],
    displacement: [disp[3 * i], disp[3 * i + 1], disp[3 * i + 2]],
    value: nodal(i),
  });
  return { min: reading(lo), max: reading(hi) };
}

// Reads every probe on the current mesh and result. A probe that cannot be
// read (its face is gone, the result belongs to another mesh) is reported as
// unreadable with the reason, without affecting the others.
export function readProbes(
  probes: readonly ResultProbe[],
  model: ProbeModel,
  field: ResultType,
  surface: ShellSurface,
): ProbeReading[] {
  const { nodes } = model;
  const disp = model.result.displacements;
  let nodal: (i: number) => number;
  try {
    nodal = nodalField(model, field, surface);
  } catch (err) {
    const reason = sentence(err instanceof Error ? err.message : String(err));
    return probes.map(() => ({ kind: "unreadable", reason }));
  }
  const index = new Map(nodes.map((node, i) => [node.id, i]));

  const nodeAt = (nodeId: number): number => {
    const i = index.get(nodeId);
    if (i === undefined)
      throw new Error(
        `Its triangle refers to node ${nodeId}, which is not in the mesh`,
      );
    return i;
  };
  const position = (i: number): Vec3 => [nodes[i].x, nodes[i].y, nodes[i].z];
  const displacement = (i: number): Vec3 => [
    disp[3 * i],
    disp[3 * i + 1],
    disp[3 * i + 2],
  ];

  return probes.map((probe): ProbeReading => {
    try {
      const candidates: Tri[] =
        probe.cadFaceId !== undefined
          ? meshCadFaceTriangles([probe.cadFaceId], model)
          : [probe.triangle];
      let best: { at: Vec3; weights: Vec3; corners: Vec3 } | null = null;
      let bestDist = Infinity;
      for (const tri of candidates) {
        const corners: Vec3 = [nodeAt(tri[0]), nodeAt(tri[1]), nodeAt(tri[2])];
        const [a, b, c] = corners.map(position);
        const weights = closestWeights(probe.point, a, b, c);
        const at = blend(weights, a, b, c);
        const dist =
          (at[0] - probe.point[0]) ** 2 +
          (at[1] - probe.point[1]) ** 2 +
          (at[2] - probe.point[2]) ** 2;
        if (dist < bestDist) {
          bestDist = dist;
          best = { at, weights, corners };
        }
      }
      if (!best) throw new Error("Its CAD face has no triangles on this mesh");
      const { at, weights, corners } = best;
      const [i, j, k] = corners;
      return {
        kind: "value",
        at,
        displacement: blend(
          weights,
          displacement(i),
          displacement(j),
          displacement(k),
        ),
        value:
          weights[0] * nodal(i) + weights[1] * nodal(j) + weights[2] * nodal(k),
      };
    } catch (err) {
      return {
        kind: "unreadable",
        reason: sentence(err instanceof Error ? err.message : String(err)),
      };
    }
  });
}
