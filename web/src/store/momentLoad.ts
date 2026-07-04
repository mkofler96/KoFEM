// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure math: convert a moment applied over faces into equivalent nodal forces.
// No Zustand dependency — unit-testable without any store setup (issue #202).

import type { Node } from "./geometrySlice";
import type { Load } from "./boundarySlice";

export interface MomentFace {
  nodeIds: number[];
}

// Equivalent nodal forces of a moment vector [Mx, My, Mz] (N·mm) applied over
// the given faces. Each non-zero axis is converted independently and its nodal
// forces summed (superposition). For each face, find the centroid, then apply
// tangential forces F_i = M/S·(n̂×r_i) where S = Σ|r_i⊥|² (`sumPerpSq`, the
// summed perpendicular distance squared from the moment axis). This satisfies
// Σ(r_i × F_i) = M exactly with zero net force.
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
    let skippedFaces = 0;
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
      for (const nodeId of f.nodeIds) {
        const n = nodeById.get(nodeId);
        if (!n) continue;
        const rx = n.x - cx,
          ry = n.y - cy,
          rz = n.z - cz;
        if (momentAxis === 0) sumPerpSq += ry * ry + rz * rz;
        else if (momentAxis === 1) sumPerpSq += rx * rx + rz * rz;
        else sumPerpSq += rx * rx + ry * ry;
      }
      if (sumPerpSq === 0) {
        // All face nodes lie on the moment axis — the tangential force
        // direction is undefined, so this face contributes no moment.
        skippedFaces++;
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
    if (skippedFaces > 0) {
      const axisName = ["Mx", "My", "Mz"][momentAxis];
      console.warn(
        `[moment load] "${groupName}" (${axisName}): ${skippedFaces} of ` +
          `${faces.length} face(s) skipped — all of their nodes lie on the ` +
          "moment axis, so the applied moment is incomplete. Choose a " +
          "different moment axis or face selection.",
      );
    }
  }
  return result;
}
