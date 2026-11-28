// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The load each node carries, for the per-node load glyphs
// (loadDisplay === "nodal"). Derived from the same selections the solver
// builds (rebuildSurfaceLoads), so the arrows show where the solver applies the
// load.

import { faceAreaScales } from "./solveLoads";
import type { MidSurfaceLinks } from "./cadShell";
import type { Element, Node } from "../store/geometrySlice";
import type { CouplingGroup } from "../store/couplingSlice";
import { referencePointIds } from "./coupling";
import {
  loadComponents,
  loadKind,
  type NamedLoadGroup,
} from "../store/boundaryGroups";
import {
  HEX_FACE_INDICES,
  TET_FACE_INDICES,
  rebuildLoads,
  rebuildSurfaceLoads,
} from "../store/boundaryRebuild";

type Vec3 = [number, number, number];

// Load direction (unit) and magnitude (N) carried by one node.
export interface NodalLoadVector {
  dir: Vec3;
  mag: number;
}

export interface NodalLoadInput {
  loadGroups: readonly NamedLoadGroup[];
  nodes: readonly Node[];
  // The elements on screen; loads on hidden bodies get no glyphs.
  elements: readonly Element[];
  couplingGroups: readonly CouplingGroup[];
  // A CAD mid-surface's links: a load on a shell's bottom face points the
  // other way (rebuildSurfaceLoads). Absent without a CAD mid-surface.
  midSurfaceLinks?: MidSurfaceLinks | null;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scaled = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

// Area-weighted normal of a triangle or quad (via its diagonals): length = area,
// direction from the corner order.
function areaNormal(c: readonly Vec3[]): Vec3 {
  const n =
    c.length === 3
      ? cross(sub(c[1], c[0]), sub(c[2], c[0]))
      : cross(sub(c[2], c[0]), sub(c[3], c[1]));
  return [n[0] / 2, n[1] / 2, n[2] / 2];
}

const faceKey = (ids: readonly number[]) =>
  [...ids].sort((a, b) => a - b).join(",");

// The faces a load can act on, by vertex-set key: a solid's boundary faces
// (owned by one element) and every shell facet.
interface MeshSurface {
  solid: ReadonlySet<string>;
  shell: ReadonlySet<string>;
  // Nodes of the elements on screen, and the couplings' reference points.
  visibleNodes: ReadonlySet<number>;
  refPoints: ReadonlySet<number>;
}

function meshSurface(
  elements: readonly Element[],
  couplingGroups: readonly CouplingGroup[],
): MeshSurface {
  const solidCount = new Map<string, number>();
  const shell = new Set<string>();
  const visibleNodes = new Set<number>();
  for (const el of elements) {
    for (const id of el.nodeIds) visibleNodes.add(id);
    if (el.type === "CTRIA3") {
      shell.add(faceKey(el.nodeIds));
      continue;
    }
    const local = el.type === "CTETRA" ? TET_FACE_INDICES : HEX_FACE_INDICES;
    for (const lf of local) {
      const key = faceKey(lf.map((i) => el.nodeIds[i]));
      solidCount.set(key, (solidCount.get(key) ?? 0) + 1);
    }
  }
  const solid = new Set<string>();
  for (const [key, n] of solidCount) if (n === 1) solid.add(key);
  return {
    solid,
    shell,
    visibleNodes,
    refPoints: referencePointIds([...couplingGroups]),
  };
}

// The work-equivalent force vector at every node of one force or pressure
// group, as the solver applies it:
//   point pick — the node takes its share of the total (rebuildLoads)
//   facets     — a total force by tributary area (F·Aᵢ/ΣA), a pressure as
//                p·A/k per corner: on a shell facet against its winding normal
//                (lib/solveLoads), on a solid face into the body
//   edges      — a shell edge selection (a plate's rim) takes a total force as
//                a uniform line load, q·L/2 per edge end
function groupNodalForces(
  g: NamedLoadGroup,
  input: NodalLoadInput,
  surface: MeshSurface,
  posOf: (id: number) => Vec3 | null,
  centroid: Vec3,
): Map<number, Vec3> {
  const forces = new Map<number, Vec3>();
  const kind = loadKind(g);
  if (kind === "moment") return forces;
  const add = (id: number, f: Vec3) => {
    const acc = forces.get(id);
    forces.set(
      id,
      acc === undefined
        ? [...f]
        : [acc[0] + f[0], acc[1] + f[1], acc[2] + f[2]],
    );
  };

  for (const l of rebuildLoads(
    [g],
    [...input.nodes],
    [...input.couplingGroups],
  )) {
    // A point on a hidden body has nothing on screen to sit on; a coupling's
    // reference point belongs to no element and is always drawn.
    if (!surface.visibleNodes.has(l.nodeId) && !surface.refPoints.has(l.nodeId))
      continue;
    const pointForce: Vec3 = [0, 0, 0];
    pointForce[l.dof] = l.value;
    add(l.nodeId, pointForce);
  }

  const [surfaceLoad] = rebuildSurfaceLoads(
    [g],
    [...input.elements],
    [...input.couplingGroups],
    input.midSurfaceLinks,
  );
  if (surfaceLoad === undefined) return forces;
  const facets: { ids: number[]; corners: Vec3[]; scale: number }[] = [];
  const edges: { ids: number[]; corners: Vec3[] }[] = [];
  const scales = faceAreaScales(surfaceLoad);
  for (const [index, ids] of surfaceLoad.faces.entries()) {
    // The solver's face match ignores a solid's interior faces; so do glyphs.
    const key = faceKey(ids);
    if (ids.length > 2 && !surface.solid.has(key) && !surface.shell.has(key))
      continue;
    const pts = ids.map(posOf);
    if (pts.some((p) => p === null)) continue;
    const corners = pts as Vec3[];
    // The area the facet stands for (SurfaceLoad.areaScales), as the solve
    // applies it.
    if (ids.length === 2) edges.push({ ids, corners });
    else
      facets.push({
        ids,
        corners,
        scale: scales[index],
      });
  }
  const vector = loadComponents(g);

  // rebuildSurfaceLoads returns edges only when the selection spans no facet.
  if (edges.length > 0) {
    // A pressure on an edge has no area to act on; the solver refuses it.
    if (kind !== "force") return forces;
    const lengths = edges.map((e) => norm(sub(e.corners[1], e.corners[0])));
    const totalLength = lengths.reduce((s, l) => s + l, 0);
    if (totalLength < 1e-30) return forces;
    edges.forEach(({ ids }, i) => {
      const share = lengths[i] / totalLength / 2; // q·L/2 per end
      for (const id of ids) add(id, scaled(vector, share));
    });
    return forces;
  }

  const areas = facets.map((f) => norm(areaNormal(f.corners)) * f.scale);
  const totalArea = areas.reduce((s, a) => s + a, 0);
  if (totalArea < 1e-30) return forces;
  facets.forEach(({ ids, corners, scale }, i) => {
    if (areas[i] < 1e-30) return;
    let cornerForce: Vec3;
    if (kind === "force") {
      cornerForce = scaled(vector, areas[i] / totalArea / ids.length);
    } else {
      // n has length A. A shell has no inside: positive pressure pushes
      // against the winding normal. A solid face is pushed into the body.
      const n = scaled(areaNormal(corners), scale);
      let sign = -1;
      if (!surface.shell.has(faceKey(ids))) {
        const fc: Vec3 = [0, 0, 0];
        for (const c of corners) for (let d = 0; d < 3; d++) fc[d] += c[d];
        for (let d = 0; d < 3; d++) fc[d] /= corners.length;
        sign = dot(n, sub(centroid, fc)) < 0 ? -1 : 1;
      }
      cornerForce = scaled(n, (sign * g.totalForce) / ids.length); // p·A/k
    }
    for (const id of ids) add(id, cornerForce);
  });
  return forces;
}

// Per node across all groups: the direction and magnitude of its load. A node
// loaded by two groups shows the larger. Moments have no per-node form (their
// glyph is the group's double-headed axis arrow) and yield no entries.
export function nodalLoadVectors(
  input: NodalLoadInput,
): Map<number, NodalLoadVector> {
  const out = new Map<number, NodalLoadVector>();
  if (input.loadGroups.length === 0 || input.nodes.length === 0) return out;
  const byId = new Map<number, Vec3>();
  const centroid: Vec3 = [0, 0, 0];
  for (const n of input.nodes) {
    byId.set(n.id, [n.x, n.y, n.z]);
    centroid[0] += n.x;
    centroid[1] += n.y;
    centroid[2] += n.z;
  }
  for (let d = 0; d < 3; d++) centroid[d] /= input.nodes.length;
  const posOf = (id: number) => byId.get(id) ?? null;
  const surface = meshSurface(input.elements, input.couplingGroups);

  for (const g of input.loadGroups) {
    for (const [id, f] of groupNodalForces(
      g,
      input,
      surface,
      posOf,
      centroid,
    )) {
      const mag = norm(f);
      if (mag < 1e-30) continue;
      const prev = out.get(id);
      if (prev && prev.mag >= mag) continue;
      out.set(id, { dir: [f[0] / mag, f[1] / mag, f[2] / mag], mag });
    }
  }
  return out;
}
