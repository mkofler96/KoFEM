// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure math: convert a moment applied over faces into equivalent nodal forces.
// No Zustand dependency — unit-testable without any store setup (issue #202).

import type { Node } from "./geometrySlice";
import type { Load } from "./boundaryRebuild";

export interface MomentFace {
  nodeIds: number[];
}

// Equivalent nodal forces of a moment vector [Mx, My, Mz] (N·mm) applied over
// the given faces. Each non-zero axis is converted independently and its nodal
// forces summed (superposition). For each face, find the centroid, then apply
// tangential forces F_i = M/S·(n̂×r_i) where S = Σ|r_i⊥|² (`sumPerpSq`, the
// summed perpendicular distance squared from the moment axis). This satisfies
// Σ(r_i × F_i) = M exactly with zero net force. A face that lies along the
// moment axis (a shell edge, or one node) takes it as nodal moments instead.
export function momentToNodalForces(
  moment: [number, number, number],
  faces: MomentFace[],
  nodeById: Map<number, Node>,
  groupName: string,
): Load[] {
  const result: Load[] = [];
  for (let momentAxis = 0; momentAxis < 3; momentAxis++) {
    const momentMag = moment[momentAxis]; // about x (0), y (1) or z (2)
    if (momentMag === 0) continue;
    for (const f of faces) {
      let cx = 0,
        cy = 0,
        cz = 0,
        count = 0;
      for (const nodeId of f.nodeIds) {
        const n = nodeById.get(nodeId);
        if (n) {
          cx += n.x;
          cy += n.y;
          cz += n.z;
          count++;
        }
      }
      if (count === 0) continue;
      cx /= count;
      cy /= count;
      cz /= count;

      let sumPerpSq = 0;
      let sumSq = 0;
      for (const nodeId of f.nodeIds) {
        const n = nodeById.get(nodeId);
        if (!n) continue;
        const rx = n.x - cx,
          ry = n.y - cy,
          rz = n.z - cz;
        sumSq += rx * rx + ry * ry + rz * rz;
        if (momentAxis === 0) sumPerpSq += ry * ry + rz * rz;
        else if (momentAxis === 1) sumPerpSq += rx * rx + rz * rz;
        else sumPerpSq += rx * rx + ry * ry;
      }
      // A face within 1e-3 of its size of the axis counts as on it: a shell
      // edge's mid-surface nodes stray from the straight line by a few
      // hundredths of a millimetre, and lever arms that small would turn the
      // moment into enormous forces.
      if (sumPerpSq <= 1e-6 * sumSq) {
        // Every node lies on the moment axis: the face is a line along it (a
        // shell edge) or a single node, and a ring of forces has no lever arm.
        // It takes the moment on the rotational DOF about the axis instead,
        // spread by each node's share of the line's length. A shell node
        // carries it; on a solid node the solve refuses it.
        result.push(
          ...lineMoment(f.nodeIds, momentAxis, momentMag, nodeById, groupName),
        );
        continue;
      }

      const scale = momentMag / sumPerpSq;
      for (const nodeId of f.nodeIds) {
        const n = nodeById.get(nodeId);
        if (!n) continue;
        const rx = n.x - cx,
          ry = n.y - cy,
          rz = n.z - cz;
        if (momentAxis === 0) {
          // Mx → F = scale·(0, −rz, ry)
          result.push({ nodeId, dof: 1, value: -scale * rz });
          result.push({ nodeId, dof: 2, value: scale * ry });
        } else if (momentAxis === 1) {
          // My → F = scale·(rz, 0, −rx)
          result.push({ nodeId, dof: 0, value: scale * rz });
          result.push({ nodeId, dof: 2, value: -scale * rx });
        } else {
          // Mz → F = scale·(−ry, rx, 0)
          result.push({ nodeId, dof: 0, value: -scale * ry });
          result.push({ nodeId, dof: 1, value: scale * rx });
        }
      }
    }
  }
  return result;
}

// The moment `value` about `axis` on the nodes of a line along that axis,
// shared in proportion to each node's tributary length: half the gap to each
// neighbour along the line. A lone node takes the whole moment.
function lineMoment(
  nodeIds: number[],
  axis: number,
  value: number,
  nodeById: Map<number, Node>,
  groupName: string,
): Load[] {
  const along = nodeIds
    .filter((id) => nodeById.has(id))
    .map((id) => {
      const n = nodeById.get(id) as Node;
      return { id, t: [n.x, n.y, n.z][axis] };
    })
    .sort((a, b) => a.t - b.t);
  if (along.length === 1)
    return [{ nodeId: along[0].id, dof: 3 + axis, value }];
  const length = along[along.length - 1].t - along[0].t;
  if (!(length > 0))
    throw new Error(
      `moment load "${groupName}": its face's nodes all coincide, so there is no length to spread the moment over`,
    );
  return along.map(({ id }, i) => {
    const before = i > 0 ? along[i].t - along[i - 1].t : 0;
    const after = i < along.length - 1 ? along[i + 1].t - along[i].t : 0;
    return {
      nodeId: id,
      dof: 3 + axis,
      value: (value * (before + after)) / 2 / length,
    };
  });
}
