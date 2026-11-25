// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, type ReactNode } from "react";
import { useModelStore } from "../../store/modelStore";
import {
  addSelection,
  type TreeGroup,
  type TreeItemKind,
} from "../../store/viewSlice";
import { useTreeItems } from "./modelTreeItems";
import { EYE_ICON, EYE_OFF_ICON } from "./bodyIcons";
import { requestDelete } from "../../store/confirmDelete";
import { useT } from "../../i18n/useLocale";
import { shellMessages } from "../../i18n/messages/shell";
import styles from "./ModelTree.module.css";

// The dividers in order; each lists its objects and ends in "+ Add". No label
// the app generates for an object may contain a divider label (tests select
// tree buttons by text).
export const TREE_GROUPS: TreeGroup[] = [
  "geometry",
  "materials",
  "mesh",
  "boundary",
  "studies",
  "results",
];

type ShellText = (typeof shellMessages)["en"];

export function treeGroupLabel(text: ShellText, group: TreeGroup): string {
  return {
    geometry: text.groupGeometry,
    materials: text.groupMaterials,
    mesh: text.groupMesh,
    boundary: text.groupBoundary,
    studies: text.groupStudies,
    results: text.groupResults,
  }[group];
}

const KIND_DOT: Partial<Record<TreeItemKind, string>> = {
  bc: styles.kindBc,
  load: styles.kindLoad,
  tie: styles.kindTie,
  coupling: styles.kindCoupling,
  interface: styles.kindInterface,
};

// Groups that hold at most one object: a model has one mesh, so once it exists
// it is regenerated from its own entry and "+ Add" goes.
const SINGLE_ITEM_GROUPS: TreeGroup[] = ["mesh"];

// Boundary objects the user made, so the tree offers to delete them on hover
// (KOF-423). Interfaces come from the geometry and stay.
type DeletableKind = "bc" | "load" | "tie" | "coupling";
const DELETABLE_KINDS: TreeItemKind[] = ["bc", "load", "tie", "coupling"];
const isDeletable = (kind: TreeItemKind): kind is DeletableKind =>
  DELETABLE_KINDS.includes(kind);

// Analysis objects carry the hollow square instead of a dot.
const SQUARE_KINDS: TreeItemKind[] = [
  "mesh",
  "study",
  "plot",
  "section",
  "reactions",
];

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

// The cross at a boundary object's row end: shown while the row is hovered or
// the cross has keyboard focus, and always on touch screens.
function DeleteButton({
  testId,
  label,
  onClick,
}: {
  testId: string;
  label: string;
  onClick: () => void;
}) {
  const text = useT(shellMessages);
  return (
    <button
      className={styles.rowDelete}
      data-testid={testId}
      title={text.delete}
      aria-label={text.deleteItem(label)}
      onClick={onClick}
    >
      <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
        <path
          d="M2.5 2.5l5 5M7.5 2.5l-5 5"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}

// Vertical model tree: collapsible dividers (Geometry, Materials, …), each
// listing the objects it holds and a "+ Add" entry. Picking
// an entry opens its editor in the properties panel on the right.
export function ModelTree() {
  const selection = useModelStore((s) => s.treeSelection);
  const selectTreeNode = useModelStore((s) => s.selectTreeNode);
  const setHighlightBodyId = useModelStore((s) => s.setHighlightBodyId);
  const setHighlightInterfaceId = useModelStore(
    (s) => s.setHighlightInterfaceId,
  );
  const hiddenBodyIds = useModelStore((s) => s.hiddenBodyIds);
  const properties = useModelStore((s) => s.properties);
  const suppressedIds = new Set(
    properties.filter((p) => p.suppressed).map((p) => p.id),
  );
  const toggleBodyVisibility = useModelStore((s) => s.toggleBodyVisibility);
  const setBodiesHidden = useModelStore((s) => s.setBodiesHidden);
  const deleteBcGroup = useModelStore((s) => s.deleteBcGroup);
  const deleteLoadGroup = useModelStore((s) => s.deleteLoadGroup);
  const deleteTieGroup = useModelStore((s) => s.deleteTieGroup);
  const deleteCouplingGroup = useModelStore((s) => s.deleteCouplingGroup);
  const items = useTreeItems();
  const text = useT(shellMessages);
  const [collapsed, setCollapsed] = useState<TreeGroup[]>([]);

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
  // Delete a boundary object, once the user confirms; the panel showing it
  // goes back to "+ Add".
  function deleteItem(kind: DeletableKind, itemId: number) {
    if (isItem("boundary", kind, itemId))
      selectTreeNode(addSelection("boundary"));
    const remove = {
      bc: deleteBcGroup,
      load: deleteLoadGroup,
      tie: deleteTieGroup,
      coupling: deleteCouplingGroup,
    }[kind];
    remove(itemId);
  }

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
    nested,
    rowClass,
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
    // A region under its body: indented.
    nested?: boolean;
    // The row's place in a body's subtree: the body over its regions, a
    // region, the last region.
    rowClass?: string;
  }) {
    return (
      <li
        key={key}
        className={`${styles.entryRow} ${rowClass ?? ""}`}
        onMouseEnter={onHover && (() => onHover(true))}
        onMouseLeave={onHover && (() => onHover(false))}
      >
        <button
          className={`${styles.node} ${active ? styles.nodeActive : ""} ${dimmed ? styles.nodeDimmed : ""} ${nested ? styles.nodeNested : ""}`}
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
    <nav className={styles.tree} aria-label={text.modelTree}>
      <div className={styles.header}>{text.model}</div>
      {TREE_GROUPS.map((id) => {
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
              <span className={styles.label}>{treeGroupLabel(text, id)}</span>
            </button>
            {open && (
              <ul className={styles.list}>
                {items[id].map((item, k, list) => {
                  // A body's regions follow it: the body opens its subtree,
                  // the last region closes it.
                  const next = list[k + 1];
                  const rowClass = item.nested
                    ? next?.nested
                      ? styles.regionRow
                      : `${styles.regionRow} ${styles.regionLast}`
                    : next?.nested
                      ? styles.bodyWithRegions
                      : undefined;
                  // A body or region stands for its CAD solids (KOF-257).
                  const solids = item.solidIds ?? [];
                  const isBody = solids.length > 0;
                  const isInterface = item.kind === "interface";
                  const inactive = item.inactive === true;
                  const hidden =
                    isBody && solids.every((s) => hiddenBodyIds.includes(s));
                  // Suppressed: as good as deleted, so no eye — it is brought
                  // back from its panel (Suppressed), not shown.
                  const suppressed =
                    isBody && solids.every((s) => suppressedIds.has(s));
                  return entry({
                    key: `${item.kind}:${item.id}`,
                    rowClass: isDeletable(item.kind)
                      ? styles.rowWithDelete
                      : rowClass,
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
                    ) : SQUARE_KINDS.includes(item.kind) ? (
                      <span className={styles.viewMark} />
                    ) : (
                      <span
                        className={`${styles.kindDot} ${KIND_DOT[item.kind] ?? ""}`}
                      />
                    ),
                    label: item.label,
                    // Hovering a single-solid body or a region highlights it in
                    // the viewport (#353), hovering an interface its faces.
                    onHover:
                      isBody && solids.length === 1 && !suppressed
                        ? (on) => setHighlightBodyId(on ? solids[0] : null)
                        : isInterface && !inactive
                          ? (on) => setHighlightInterfaceId(on ? item.id : null)
                          : undefined,
                    detail: suppressed ? text.suppressed : item.detail,
                    dimmed: hidden || suppressed || inactive,
                    nested: item.nested,
                    trailing: isDeletable(item.kind) ? (
                      <DeleteButton
                        testId={`tree-delete-${item.kind}-${item.id}`}
                        label={item.label}
                        onClick={() => {
                          const kind = item.kind;
                          if (isDeletable(kind))
                            requestDelete(item.label, () =>
                              deleteItem(kind, item.id),
                            );
                        }}
                      />
                    ) : (
                      isBody &&
                      !suppressed && (
                        <button
                          className={`${styles.eye} ${hidden ? styles.eyeOff : ""}`}
                          data-testid={`tree-eye-${item.kind}-${item.id}`}
                          title={hidden ? text.show : text.hide}
                          aria-label={
                            hidden
                              ? text.showItem(item.label)
                              : text.hideItem(item.label)
                          }
                          aria-pressed={hidden}
                          onClick={() =>
                            solids.length === 1
                              ? toggleBodyVisibility(solids[0])
                              : setBodiesHidden(solids, !hidden)
                          }
                        >
                          {hidden ? EYE_OFF_ICON : EYE_ICON}
                        </button>
                      )
                    ),
                  });
                })}
                {!(SINGLE_ITEM_GROUPS.includes(id) && items[id].length > 0) &&
                  entry({
                    key: "add",
                    active: isAdd(id),
                    testId: `tree-add-${id}`,
                    onClick: () => selectTreeNode(addSelection(id)),
                    marker: <span className={styles.addIcon}>+</span>,
                    label: text.add,
                  })}
              </ul>
            )}
          </section>
        );
      })}
    </nav>
  );
}
