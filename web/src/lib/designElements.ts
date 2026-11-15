// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Element } from "../store/geometrySlice";

// The design elements in the exact order the optimizer returns one density per
// element, so density[i] belongs to orderedDesignElements(elements)[i]. That
// order is: solid tets, then hexes, then shell facets (KOF-237) — matching how
// the solid entry packs its mesh (CTETRA then CHEXA), the coupled entry its
// design domain (tets then facets), and the pure-shell entry (facets only). A
// coupled model carries no hexes and a solid model no facets, so the single
// concatenation covers all three domains. Passive element indices (the regions
// kept solid or empty) count in the same order.
export function orderedDesignElements(elements: Element[]): Element[] {
  const tets = elements.filter((e) => e.type === "CTETRA");
  const hexes = elements.filter((e) => e.type === "CHEXA");
  const shells = elements.filter((e) => e.type === "CTRIA3");
  return [...tets, ...hexes, ...shells];
}
