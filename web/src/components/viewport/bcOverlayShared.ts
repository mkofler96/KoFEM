// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Shared by the boundary-condition overlay layers: the pick-session colour and
// the node lookups the BC marker and load-arrow glyphs are built from.

import * as THREE from "three";
import type { Node } from "../../store/modelStore";
import type { NodeMap } from "./useMeshTopology";

// The orange every live pick session uses for what is currently selected.
export const SELECTION_COLOR = "#e05533";

// Model centroid (mean of all node coordinates) — orients face normals and
// pressure arrows. Callers check `nodes.length > 0` first.
export function modelCentroid(nodes: readonly Node[]): THREE.Vector3 {
  let mx = 0,
    my = 0,
    mz = 0;
  for (const n of nodes) {
    mx += n.x;
    my += n.y;
    mz += n.z;
  }
  mx /= nodes.length;
  my /= nodes.length;
  mz /= nodes.length;
  return new THREE.Vector3(mx, my, mz);
}

// Position of a mesh node, or null when the id is not in the mesh.
export function nodePosition(
  nodeMap: NodeMap,
  id: number,
): THREE.Vector3 | null {
  const entry = nodeMap.get(id);
  return entry ? new THREE.Vector3(entry.n.x, entry.n.y, entry.n.z) : null;
}
