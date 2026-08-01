// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { useModelStore } from "../store/modelStore";
import { tiedNodePairs } from "../lib/tie";
import type { TiePair, TieReport } from "../lib/tie";

// The node pairs the model's tie connections weld, and what each connection
// found. Derived rather than stored: the same pairing the solve applies
// (lib/tie.ts) is what the viewport draws and what the panel counts, so there
// is one definition of "these two nodes are tied" and no way for the picture to
// drift from the solved model.
export function useTiePairs(): { pairs: TiePair[]; reports: TieReport[] } {
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const tieGroups = useModelStore((s) => s.tieGroups);
  return useMemo(
    () => tiedNodePairs(nodes, elements, tieGroups),
    [nodes, elements, tieGroups],
  );
}
