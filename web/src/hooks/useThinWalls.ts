// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { useModelStore } from "../store/modelStore";
import {
  underResolvedWalls,
  type UnderResolvedWall,
} from "../lib/thinWallCheck";

// Solid-body walls with too few linear elements through their thickness
// (KOF-274), for the current mesh. Only computed while `enabled` (the caller
// passes "linear elements"): the check walks every tet, about 0.8 s at 200k
// tets, so it is memoised on the mesh and on which bodies are Solid, not on
// every property edit.
export function useUnderResolvedWalls(enabled: boolean): UnderResolvedWall[] {
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const surfaceTriangles = useModelStore((s) => s.surfaceTriangles);
  const surfaceFaceIds = useModelStore((s) => s.surfaceFaceIds);
  const properties = useModelStore((s) => s.properties);
  // Material changes do not move a wall; only the Solid/Shell/suppressed
  // choice decides which bodies are checked.
  const checkedBodies = properties
    .map((p) => `${p.id}:${p.discretization}:${p.suppressed === true}`)
    .join(",");
  return useMemo(
    () =>
      enabled
        ? underResolvedWalls({
            nodes,
            elements,
            surfaceTriangles,
            surfaceFaceIds,
            properties: useModelStore.getState().properties,
          })
        : [],
    // properties is read through getState: checkedBodies stands in for it.
    [enabled, nodes, elements, surfaceTriangles, surfaceFaceIds, checkedBodies],
  );
}
