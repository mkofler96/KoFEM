// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useRef } from "react";
import { useModelStore } from "../../store/modelStore";
import {
  MESH_KIND_LABEL,
  meshKind,
  meshSizesChanged,
  suppressionMismatch,
} from "../../store/geometrySlice";
import { plotLabel } from "../../store/studySlice";
import {
  INTERFACE_TYPE_LABELS,
  interfaceLabel,
  isInterfaceActive,
  isInternalInterface,
  unconnectedBodies,
} from "../../lib/interfaces";
import { bodyGroups } from "../../lib/regions";
import {
  addSelection,
  MESH_ITEM_ID,
  type TreeGroup,
  type TreeItemKind,
} from "../../store/viewSlice";

export interface TreeItem {
  kind: TreeItemKind;
  id: number;
  label: string;
  // Swatch colour (bodies and materials carry their material's colour).
  color?: string;
  // Muted text at the row's end (the mesh's node count, or that it is out of
  // date).
  detail?: string;
  // Out of the analysis (an interface of a suppressed body): drawn dimmed and
  // not highlighted on hover.
  inactive?: boolean;
  // Bodies and regions: the CAD solids the entry stands for — what hovering
  // highlights, the eye hides and suppression takes out.
  solidIds?: number[];
  // A region under its body: drawn indented.
  nested?: boolean;
}

// The model objects listed under each tree group. Groups without objects map
// to an empty list.
export function useTreeItems(): Record<TreeGroup, TreeItem[]> {
  const hasGeometry = useModelStore(
    (s) => s.stepSurface !== null || s.nodes.length > 0,
  );
  const properties = useModelStore((s) => s.properties);
  const interfaces = useModelStore((s) => s.interfaces);
  const materials = useModelStore((s) => s.materials);
  const bcGroups = useModelStore((s) => s.bcGroups);
  const loadGroups = useModelStore((s) => s.loadGroups);
  const tieGroups = useModelStore((s) => s.tieGroups);
  const couplingGroups = useModelStore((s) => s.couplingGroups);
  const nodeCount = useModelStore((s) => s.nodes.length);
  const meshLabel = useModelStore((s) =>
    s.nodes.length > 0 ? MESH_KIND_LABEL[meshKind(s.elements)] : null,
  );
  const meshOutOfDate = useMeshOutOfDate();
  const studies = useModelStore((s) => s.studies);
  const resultPlots = useModelStore((s) => s.resultPlots);

  return useMemo(() => {
    const colorOf = (materialId: number) =>
      materials.find((m) => m.id === materialId)?.color;
    const unbonded = new Set(unconnectedBodies(interfaces, properties));
    return {
      // The store always carries a default body; it is only a body of the
      // model once there is geometry.
      // A body is listed by its body number; one that a split cut into
      // regions lists them under it (KOF-257).
      geometry: hasGeometry
        ? bodyGroups(properties).flatMap(({ body, regions }): TreeItem[] => {
            const floating = regions.some((r) => unbonded.has(r.id));
            if (regions.length === 1)
              return [
                {
                  kind: "body",
                  id: body,
                  label: `Body ${body}`,
                  color: colorOf(regions[0].materialId),
                  detail: floating ? "unbonded" : undefined,
                  solidIds: [regions[0].id],
                },
              ];
            return [
              {
                kind: "body",
                id: body,
                label: `Body ${body}`,
                detail: floating ? "unbonded" : `${regions.length} regions`,
                solidIds: regions.map((r) => r.id),
              },
              ...regions.map((r, k): TreeItem => ({
                kind: "region",
                id: r.id,
                label: `Region ${k + 1}`,
                color: colorOf(r.materialId),
                solidIds: [r.id],
                nested: true,
              })),
            ];
          })
        : [],
      materials: materials.map((m) => ({
        kind: "material" as const,
        id: m.id,
        label: m.name,
        color: m.color,
      })),
      mesh:
        meshLabel !== null
          ? [
              {
                kind: "mesh" as const,
                id: MESH_ITEM_ID,
                label: meshLabel,
                detail: meshOutOfDate
                  ? "out of date"
                  : `${nodeCount.toLocaleString("en-US")} nodes`,
              },
            ]
          : [],
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
        // The interface conditions between bodies, detected from the geometry
        // and marked with their type.
        // The cut between two regions of one body is not an interface the user
        // sets up — the regions are connected there by construction.
        ...(interfaces ?? [])
          .filter((i) => !isInternalInterface(i, properties))
          .map((i) => {
            const active = isInterfaceActive(i, properties);
            return {
              kind: "interface" as const,
              id: i.id,
              label: interfaceLabel(i, properties),
              detail: active
                ? INTERFACE_TYPE_LABELS[i.type].toLowerCase()
                : "inactive",
              inactive: !active,
            };
          }),
      ],
      studies: studies.map((st) => ({
        kind: "study" as const,
        id: st.id,
        label: st.name,
      })),
      results: resultPlots.map((p) => ({
        kind: "plot" as const,
        id: p.id,
        label: plotLabel(p),
      })),
    };
  }, [
    hasGeometry,
    properties,
    interfaces,
    materials,
    bcGroups,
    loadGroups,
    tieGroups,
    couplingGroups,
    nodeCount,
    meshLabel,
    meshOutOfDate,
    studies,
    resultPlots,
  ]);
}

// Whether the current mesh no longer matches the model: the mesh settings have
// changed since it was made, or a body was suppressed or restored after it.
// Regenerating the mesh brings it back in line. False without a mesh.
export function useMeshOutOfDate(): boolean {
  return useModelStore((s) => {
    if (s.nodes.length === 0) return false;
    const bodies = suppressionMismatch(s.properties, s.meshSuppressedIds, true);
    return (
      meshSizesChanged(
        s.meshSizes,
        s.maxElementSize,
        s.minElementSize,
        s.properties,
      ) ||
      bodies.stillMeshed.length > 0 ||
      bodies.missing.length > 0
    );
  });
}

// Keeps the tree selection pointing at something that exists: an object that
// was deleted falls back to its group's "+ Add", and a creation form that just
// created an object moves on to that object — "+ Add" → apply lands on the new
// item, shown as saved (created) rather than with its editor open.
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
        // Interfaces are detected, never created by a form.
        i.kind !== "interface" &&
        (target.kind === null || i.kind === target.kind),
    );
    // Import replaces the bodies wholesale and moves on to Mesh by itself.
    if (created && group !== "geometry")
      selectTreeNode({
        group,
        target: {
          type: "item",
          kind: created.kind,
          id: created.id,
          created: true,
        },
      });
  }, [items, selection, selectTreeNode]);
}
