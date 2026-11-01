// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Physical shell footprint: where a shell edge ends on a through-thickness solid
// section, the section's solid nodes follow the interpolated shell edge
// (coupling kind 3) instead of a search-ball tie.

import type { CouplingSet } from "./couplingSet.js";
import { pt, tetMeshBoundary, type Vec3 } from "./geometry.js";

export interface ShellBoundaryEdge {
  first: number;
  second: number;
  thickness: number;
  normal: Vec3;
  inward: Vec3;
}

// The free edges of a shell triangle set (used by exactly one facet), each with
// its facet's unit normal and the in-plane unit direction pointing into it.
export function shellBoundaryEdges(
  vertices: number[],
  triangles: number[],
  thicknesses: number[],
): ShellBoundaryEdge[] {
  const edges = new Map<string, { count: number; edge: ShellBoundaryEdge }>();
  for (let triangle = 0; triangle < triangles.length / 3; triangle++) {
    const nodes = triangles.slice(3 * triangle, 3 * triangle + 3),
      points = nodes.map((index) => pt(vertices, index));
    const side = points[1].map((value, axis) => value - points[0][axis]);
    const other = points[2].map((value, axis) => value - points[0][axis]);
    const raw = [
      side[1] * other[2] - side[2] * other[1],
      side[2] * other[0] - side[0] * other[2],
      side[0] * other[1] - side[1] * other[0],
    ];
    const length = Math.hypot(...raw);
    if (length === 0)
      throw new Error("Degenerate shell triangle at transition");
    const normal = raw.map((value) => value / length) as Vec3;
    for (let corner = 0; corner < 3; corner++) {
      const first = nodes[corner],
        second = nodes[(corner + 1) % 3];
      const key = [first, second].sort((left, right) => left - right).join(",");
      const existing = edges.get(key);
      if (existing) {
        existing.count++;
        continue;
      }
      const tangent = points[(corner + 1) % 3].map(
        (value, axis) => value - points[corner][axis],
      );
      const inwardRaw = [
        normal[1] * tangent[2] - normal[2] * tangent[1],
        normal[2] * tangent[0] - normal[0] * tangent[2],
        normal[0] * tangent[1] - normal[1] * tangent[0],
      ];
      const inward = inwardRaw.map(
        (value) => value / Math.hypot(...inwardRaw),
      ) as Vec3;
      edges.set(key, {
        count: 1,
        edge: {
          first,
          second,
          thickness: thicknesses[triangle],
          normal,
          inward,
        },
      });
    }
  }
  return [...edges.values()]
    .filter((entry) => entry.count === 1)
    .map((entry) => entry.edge);
}

export function shellFootprintCouplings(
  vertices: number[],
  tets: number[],
  triangles: number[],
  thicknesses: number[],
  dependentSolidRefs: Set<number>,
  seamReach: number,
): { coupling: CouplingSet; shellNodes: Set<number> } {
  const coupling: CouplingSet = {
    ref: [],
    offsets: [0],
    solid: [],
    mpc: [],
    weights: [],
  };
  const shellNodes = new Set<number>();
  if (triangles.length === 0 || tets.length === 0)
    return { coupling, shellNodes };
  const boundary = [...new Set(tetMeshBoundary(tets))];
  const edges = shellBoundaryEdges(vertices, triangles, thicknesses);
  const tolerance = Math.max(...thicknesses) * 1e-6;
  const shellSet = new Set(triangles);
  const groups: {
    edge: ShellBoundaryEdge;
    minimum: number;
    maximum: number;
  }[] = [];
  const candidates: {
    solid: number;
    edge: ShellBoundaryEdge;
    ratio: number;
    distance: number;
    group: number;
  }[] = [];
  for (const solid of boundary) {
    if (shellSet.has(solid)) continue;
    const position = pt(vertices, solid);
    for (const edge of edges) {
      const first = pt(vertices, edge.first),
        second = pt(vertices, edge.second);
      const tangent = second.map((value, axis) => value - first[axis]);
      const offset = position.map((value, axis) => value - first[axis]);
      const fraction =
        tangent.reduce((sum, value, axis) => sum + value * offset[axis], 0) /
        tangent.reduce((sum, value) => sum + value * value, 0);
      if (fraction < -1e-7 || fraction > 1 + 1e-7) continue;
      const ratio = Math.max(0, Math.min(1, fraction));
      const remainder = offset.map(
        (value, axis) => value - ratio * tangent[axis],
      );
      const normalDistance = remainder.reduce(
        (sum, value, axis) => sum + value * edge.normal[axis],
        0,
      );
      const planeDistance = remainder.reduce(
        (sum, value, axis) => sum + value * edge.inward[axis],
        0,
      );
      if (
        Math.abs(planeDistance) > tolerance ||
        Math.abs(normalDistance) > edge.thickness / 2 + tolerance
      )
        continue;
      const distance = Math.hypot(...remainder);
      let group = groups.findIndex((entry) => {
        const delta = pt(vertices, entry.edge.first).map(
          (value, axis) => value - first[axis],
        );
        return (
          entry.edge.normal.every(
            (value, axis) => Math.abs(value - edge.normal[axis]) < 1e-7,
          ) &&
          entry.edge.inward.every(
            (value, axis) => Math.abs(value - edge.inward[axis]) < 1e-7,
          ) &&
          Math.abs(entry.edge.thickness - edge.thickness) < tolerance &&
          Math.abs(
            delta.reduce(
              (sum, value, axis) => sum + value * edge.inward[axis],
              0,
            ),
          ) < tolerance &&
          Math.abs(
            delta.reduce(
              (sum, value, axis) => sum + value * edge.normal[axis],
              0,
            ),
          ) < tolerance
        );
      });
      if (group < 0) {
        group = groups.length;
        groups.push({ edge, minimum: normalDistance, maximum: normalDistance });
      }
      groups[group].minimum = Math.min(groups[group].minimum, normalDistance);
      groups[group].maximum = Math.max(groups[group].maximum, normalDistance);
      candidates.push({ solid, edge, ratio, distance, group });
    }
  }
  const closestByNode = new Map<number, (typeof candidates)[number]>();
  for (const candidate of candidates) {
    const group = groups[candidate.group];
    // A section spans both wall faces. A shell lying above a solid surface
    // is not a through-thickness section and retains its existing coupling.
    if (
      group.minimum > -group.edge.thickness / 2 + tolerance ||
      group.maximum < group.edge.thickness / 2 - tolerance
    )
      continue;
    const closest = closestByNode.get(candidate.solid);
    if (!closest || candidate.distance < closest.distance)
      closestByNode.set(candidate.solid, candidate);
  }
  for (const [solid, closest] of closestByNode) {
    if (dependentSolidRefs.has(solid))
      throw new Error(
        "A tie connection overlaps the shell/solid transition. Reverse its master and slave surfaces or keep the body Solid.",
      );
    coupling.ref.push(solid);
    coupling.solid.push(closest.edge.first, closest.edge.second);
    coupling.offsets.push(coupling.solid.length);
    coupling.mpc?.push(3);
    coupling.weights?.push(1 - closest.ratio, closest.ratio);
    shellNodes.add(closest.edge.first);
    shellNodes.add(closest.edge.second);
  }
  // Exclude the old search-ball tie only near the physical footprint. A
  // different seam elsewhere on the same wall must keep its own connection.
  const activeEdges = [
    ...new Set([...closestByNode.values()].map((entry) => entry.edge)),
  ];
  for (const shellNode of shellSet) {
    const position = pt(vertices, shellNode);
    for (const edge of activeEdges) {
      const first = pt(vertices, edge.first),
        second = pt(vertices, edge.second);
      const tangent = second.map((value, axis) => value - first[axis]);
      const offset = position.map((value, axis) => value - first[axis]);
      const fraction = Math.max(
        0,
        Math.min(
          1,
          tangent.reduce((sum, value, axis) => sum + value * offset[axis], 0) /
            tangent.reduce((sum, value) => sum + value * value, 0),
        ),
      );
      const distance = offset.reduce(
        (sum, value, axis) => sum + (value - fraction * tangent[axis]) ** 2,
        0,
      );
      if (distance <= (seamReach + tolerance) ** 2) {
        shellNodes.add(shellNode);
        break;
      }
    }
  }
  return { coupling, shellNodes };
}
