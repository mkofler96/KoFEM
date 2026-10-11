// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useRef } from "react";
import { useModelStore } from "../../store/modelStore";
import { isCadBody } from "../../store/geometrySlice";
import {
  addSelection,
  type TreeGroup,
  type TreeItemKind,
} from "../../store/viewSlice";

export interface TreeItem {
  kind: TreeItemKind;
  id: number;
  label: string;
  // Swatch colour (bodies and materials carry their material's colour).
  color?: string;
}

// The model objects listed under each tree group. Groups without objects map
// to an empty list.
export function useTreeItems(): Record<TreeGroup, TreeItem[]> {
  const hasGeometry = useModelStore(
    (s) => s.stepSurface !== null || s.nodes.length > 0,
  );
  const properties = useModelStore((s) => s.properties);
  const materials = useModelStore((s) => s.materials);
  const bcGroups = useModelStore((s) => s.bcGroups);
  const loadGroups = useModelStore((s) => s.loadGroups);
  const tieGroups = useModelStore((s) => s.tieGroups);
  const couplingGroups = useModelStore((s) => s.couplingGroups);

  return useMemo(() => {
    const colorOf = (materialId: number) =>
      materials.find((m) => m.id === materialId)?.color;
    return {
      // The store always carries a default body; it is only a body of the
      // model once there is geometry.
      geometry: hasGeometry
        ? properties.filter(isCadBody).map((p) => ({
            kind: "body" as const,
            id: p.id,
            label: `Body ${p.id}`,
            color: colorOf(p.materialId),
          }))
        : [],
      materials: materials.map((m) => ({
        kind: "material" as const,
        id: m.id,
        label: m.name,
        color: m.color,
      })),
      mesh: [],
      boundary: [
        ...bcGroups.map((g) => ({
          kind: "bc" as const,
          id: g.id,
          label: g.name,
        })),
        ...loadGroups.map((g) => ({
          kind: "load" as const,
          id: g.id,
          label: g.name,
        })),
        ...tieGroups.map((g) => ({
          kind: "tie" as const,
          id: g.id,
          label: g.name,
        })),
        ...couplingGroups.map((g) => ({
          kind: "coupling" as const,
          id: g.id,
          label: g.name,
        })),
      ],
      studies: [],
      results: [],
    };
  }, [
    hasGeometry,
    properties,
    materials,
    bcGroups,
    loadGroups,
    tieGroups,
    couplingGroups,
  ]);
}

// Keeps the tree selection pointing at something that exists: an object that
// was deleted falls back to its group's "+ Add", and a creation form that just created
// an object moves on to that object — "+ Add" → apply lands on the new item.
export function useTreeSelectionSync(): void {
  const items = useTreeItems();
  const selection = useModelStore((s) => s.treeSelection);
  const selectTreeNode = useModelStore((s) => s.selectTreeNode);
  const previous = useRef(items);

  useEffect(() => {
    const before = previous.current;
    previous.current = items;
    const { group, target } = selection;
    const list = items[group];
    if (
      target.type === "item" &&
      !list.some((i) => i.kind === target.kind && i.id === target.id)
    ) {
      selectTreeNode(addSelection(group));
      return;
    }
    if (target.type !== "add") return;
    const known = new Set(before[group].map((i) => `${i.kind}:${i.id}`));
    const created = list.find(
      (i) =>
        !known.has(`${i.kind}:${i.id}`) &&
        // A boundary "+ Add" creates its own kind; materials have one kind.
        (target.kind === null || i.kind === target.kind),
    );
    // Import replaces the bodies wholesale and moves on to Mesh by itself.
    if (created && group !== "geometry")
      selectTreeNode({
        group,
        target: { type: "item", kind: created.kind, id: created.id },
      });
  }, [items, selection, selectTreeNode]);
}
