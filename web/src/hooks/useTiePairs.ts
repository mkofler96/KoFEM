// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { useModelStore } from "../store/modelStore";
import { tieMethod, tiedNodePairs } from "../lib/tie";
import type { TiePair, TieReport } from "../lib/tie";
import { tieConstraints } from "../lib/tieConstraints";
import type { TieConstraint } from "../lib/tieConstraints";

// What the model's tie connections join: the node pairs the node-merge ties
// weld, the nodes the constraint ties tie to the opposite surface, and what
// each connection found (`reports`, one per tie group, in order). Derived
// rather than stored: the same functions the solve applies (lib/tie.ts,
// lib/tieConstraints.ts) are what the viewport draws and what the panel counts,
// so there is one definition of "these nodes are tied" and no way for the
// picture to drift from the solved model. Constraint ties are drawn by their
// projection onto the opposite surface: on linear elements the solve weighs
// them by dual mortar integrals in the Rust module, which the main thread
// does not load, and may leave out a node at the ragged edge of a partial
// contact (the solve log says how many it tied).
export function useTiePairs(): {
  pairs: TiePair[];
  constraints: TieConstraint[];
  reports: TieReport[];
} {
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const tieGroups = useModelStore((s) => s.tieGroups);
  return useMemo(() => {
    const isMerge = tieGroups.map((group) => tieMethod(group) === "merge");
    const merged = tiedNodePairs(
      nodes,
      elements,
      tieGroups.filter((_, index) => isMerge[index]),
    );
    const welded = new Set<number>();
    for (const pair of merged.pairs) welded.add(pair.aId).add(pair.bId);
    const constrained = tieConstraints(
      nodes,
      elements,
      tieGroups.filter((_, index) => !isMerge[index]),
      { kind: "projection" },
      welded,
    );
    // Back into tie-group order: each list holds its reports in that order.
    let nextMerged = 0;
    let nextConstrained = 0;
    const reports = isMerge.map((merge) =>
      merge
        ? merged.reports[nextMerged++]
        : constrained.reports[nextConstrained++],
    );
    return {
      pairs: merged.pairs,
      constraints: constrained.constraints,
      reports,
    };
  }, [nodes, elements, tieGroups]);
}
