// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, type ReactNode } from "react";
import { useModelStore } from "../../store/modelStore";
import {
  addSelection,
  viewSelection,
  type TreeGroup,
  type TreeItemKind,
  type TreeView,
} from "../../store/viewSlice";
import { useTreeItems } from "./modelTreeItems";
import { EYE_ICON, EYE_OFF_ICON } from "./bodyIcons";
import styles from "./ModelTree.module.css";

// The dividers in order, the fixed entries each one holds, and whether it ends
// in "+ Add". No label the app generates for an object may contain a divider
// or entry label (tests select tree buttons by text).
export const TREE_GROUPS: {
  id: TreeGroup;
  label: string;
  views: { view: TreeView; label: string }[];
  addable: boolean;
}[] = [
  {
    id: "geometry",
    label: "Geometry",
    views: [{ view: "split", label: "Split tool" }],
    addable: true,
  },
  { id: "materials", label: "Materials", views: [], addable: true },
  {
    id: "mesh",
    label: "Mesh",
    views: [{ view: "mesh", label: "Volume mesh" }],
    addable: false,
  },
  { id: "boundary", label: "Boundary conditions", views: [], addable: true },
  {
    id: "studies",
    label: "Studies",
    views: [
      { view: "static", label: "Static solve" },
      { view: "topopt", label: "Topology optimization" },
    ],
    addable: false,
  },
  {
    id: "results",
    label: "Results",
    views: [{ view: "results", label: "Result plots" }],
    addable: false,
  },
];

export const VIEW_LABEL = Object.fromEntries(
  TREE_GROUPS.flatMap((g) => g.views.map((v) => [v.view, v.label])),
) as Record<TreeView, string>;

const KIND_DOT: Partial<Record<TreeItemKind, string>> = {
  bc: styles.kindBc,
  load: styles.kindLoad,
  tie: styles.kindTie,
  coupling: styles.kindCoupling,
};

const CHECK = (
  <svg viewBox="0 0 8 8" width="5" height="5">
    <path
      d="M1.5 4L3 5.5L6.5 2"
      stroke="currentColor"
      strokeWidth="1.8"
      fill="none"
      strokeLinecap="round"
    />
  </svg>
);

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 10 10"
      width="9"
      height="9"
      className={open ? styles.chevronOpen : undefined}
    >
      <path
        d="M3.5 2l3 3-3 3"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Vertical model tree: collapsible dividers (Geometry, Materials, …), each
// listing the objects it holds, its fixed entries and a "+ Add" entry. Picking
// an entry opens its editor in the properties panel on the right.
export function ModelTree() {
  const selection = useModelStore((s) => s.treeSelection);
  const selectTreeNode = useModelStore((s) => s.selectTreeNode);
  const setHighlightBodyId = useModelStore((s) => s.setHighlightBodyId);
  const hiddenBodyIds = useModelStore((s) => s.hiddenBodyIds);
  const properties = useModelStore((s) => s.properties);
  const suppressedIds = new Set(
    properties.filter((p) => p.suppressed).map((p) => p.id),
  );
  const toggleBodyVisibility = useModelStore((s) => s.toggleBodyVisibility);
  const items = useTreeItems();
  const nodeCount = useModelStore((s) => s.nodes.length);
  const hasGeometry = useModelStore(
    (s) => s.stepSurface !== null || s.nodes.length > 0,
  );
  const hasBoundary = useModelStore(
    (s) => s.constraints.length > 0 || s.loads.length > 0,
  );
  const result = useModelStore((s) => s.result);
  const densityResult = useModelStore((s) => s.densityResult);

  const [collapsed, setCollapsed] = useState<TreeGroup[]>([]);

  function isDone(group: TreeGroup): boolean {
    switch (group) {
      case "geometry":
        return hasGeometry;
      case "materials":
        return items.materials.length > 0;
      case "mesh":
        return nodeCount > 0;
      case "boundary":
        return hasBoundary;
      case "studies":
      case "results":
        // Reached by either pipeline — a static solve or an optimization.
        return result !== null || densityResult !== null;
    }
  }

  function toggle(id: TreeGroup) {
    setCollapsed((c) =>
      c.includes(id) ? c.filter((x) => x !== id) : [...c, id],
    );
  }

  const target = selection.target;
  const isItem = (group: TreeGroup, kind: TreeItemKind, id: number) =>
    selection.group === group &&
    target.type === "item" &&
    target.kind === kind &&
    target.id === id;
  const isView = (view: TreeView) =>
    target.type === "view" && target.view === view;
  const isAdd = (group: TreeGroup) =>
    selection.group === group && target.type === "add";

  function entry({
    key,
    active,
    testId,
    onClick,
    marker,
    label,
    detail,
    onHover,
    dimmed,
    trailing,
  }: {
    key: string;
    active: boolean;
    testId: string;
    onClick: () => void;
    marker: ReactNode;
    label: string;
    detail?: string;
    onHover?: (on: boolean) => void;
    dimmed?: boolean;
    // A control at the row's end (the body eye) — a sibling of the entry
    // button, since a button may not contain another.
    trailing?: ReactNode;
  }) {
    return (
      <li
        key={key}
        className={styles.entryRow}
        onMouseEnter={onHover && (() => onHover(true))}
        onMouseLeave={onHover && (() => onHover(false))}
      >
        <button
          className={`${styles.node} ${active ? styles.nodeActive : ""} ${dimmed ? styles.nodeDimmed : ""}`}
          aria-current={active ? "true" : undefined}
          data-testid={testId}
          onClick={onClick}
        >
          {marker}
          <span className={styles.label}>{label}</span>
          {detail && <span className={styles.detail}>{detail}</span>}
        </button>
        {trailing}
      </li>
    );
  }

  return (
    <nav className={styles.tree} aria-label="Model tree">
      <div className={styles.header}>Model</div>
      {TREE_GROUPS.map(({ id, label, views, addable }) => {
        const open = !collapsed.includes(id);
        return (
          <section key={id} className={styles.group}>
            <button
              className={`${styles.divider} ${selection.group === id ? styles.dividerCurrent : ""}`}
              aria-expanded={open}
              data-testid={`tree-group-${id}`}
              onClick={() => toggle(id)}
            >
              <Chevron open={open} />
              <span className={styles.label}>{label}</span>
              {isDone(id) && <span className={styles.done}>{CHECK}</span>}
            </button>
            {open && (
              <ul className={styles.list}>
                {items[id].map((item) => {
                  const isBody = item.kind === "body";
                  const hidden = isBody && hiddenBodyIds.includes(item.id);
                  // Suppressed: as good as deleted, so no eye — it is brought
                  // back from its panel (Suppressed), not shown.
                  const suppressed = isBody && suppressedIds.has(item.id);
                  return entry({
                    key: `${item.kind}:${item.id}`,
                    active: isItem(id, item.kind, item.id),
                    testId: `tree-${item.kind}-${item.id}`,
                    onClick: () =>
                      selectTreeNode({
                        group: id,
                        target: { type: "item", kind: item.kind, id: item.id },
                      }),
                    marker: item.color ? (
                      <span
                        className={styles.swatch}
                        style={{ background: item.color }}
                      />
                    ) : (
                      <span
                        className={`${styles.kindDot} ${KIND_DOT[item.kind] ?? ""}`}
                      />
                    ),
                    label: item.label,
                    // Hovering a body highlights it in the viewport (#353).
                    onHover:
                      isBody && !suppressed
                        ? (on) => setHighlightBodyId(on ? item.id : null)
                        : undefined,
                    detail: suppressed ? "suppressed" : undefined,
                    dimmed: hidden || suppressed,
                    trailing: isBody && !suppressed && (
                      <button
                        className={`${styles.eye} ${hidden ? styles.eyeOff : ""}`}
                        data-testid={`tree-eye-body-${item.id}`}
                        title={hidden ? "Show body" : "Hide body"}
                        aria-label={`${hidden ? "Show" : "Hide"} ${item.label}`}
                        aria-pressed={hidden}
                        onClick={() => toggleBodyVisibility(item.id)}
                      >
                        {hidden ? EYE_OFF_ICON : EYE_ICON}
                      </button>
                    ),
                  });
                })}
                {views.map(({ view, label: viewLabel }) =>
                  entry({
                    key: view,
                    active: isView(view),
                    testId: `tree-view-${view}`,
                    onClick: () => selectTreeNode(viewSelection(id, view)),
                    marker: <span className={styles.viewMark} />,
                    label: viewLabel,
                    detail:
                      view === "mesh" && nodeCount > 0
                        ? `${nodeCount.toLocaleString("en-US")} nodes`
                        : undefined,
                  }),
                )}
                {addable &&
                  entry({
                    key: "add",
                    active: isAdd(id),
                    testId: `tree-add-${id}`,
                    onClick: () => selectTreeNode(addSelection(id)),
                    marker: <span className={styles.addIcon}>+</span>,
                    label: "Add",
                  })}
              </ul>
            )}
          </section>
        );
      })}
    </nav>
  );
}
