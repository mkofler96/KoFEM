// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useModelStore } from "../../store/modelStore";
import type { TreeItemKind, TreeSelection } from "../../store/viewSlice";
import { AutoShellSection, GeometryPanel } from "./GeometryPanel";
import { MaterialsPanel } from "./MaterialsPanel";
import { MeshPanel } from "./MeshPanel";
import {
  BOUNDARY_KINDS,
  BoundaryConditionsPanel,
} from "./BoundaryConditionsPanel";
import { SolvePanel } from "./SolvePanel";
import { OptimizePanel } from "./OptimizePanel";
import { ResultsPanel } from "./ResultsPanel";
import { TREE_GROUPS, VIEW_LABEL } from "./ModelTree";
import { useTreeItems } from "./modelTreeItems";
import styles from "./Panel.module.css";

const KIND_LABEL: Record<TreeItemKind, string> = {
  body: "Body",
  material: "Material",
  bc: "Support",
  load: "Load",
  tie: "Tie",
  coupling: "Coupling",
};

function addTitle({ group, target }: TreeSelection): string {
  if (group === "geometry") return "Add geometry";
  if (group === "materials") return "New material";
  if (target.type === "add" && target.kind !== null) {
    const kind = BOUNDARY_KINDS.find((k) => k.kind === target.kind);
    if (kind) return `New ${kind.label.toLowerCase()}`;
  }
  return "Add boundary condition";
}

// Thin orchestrator: the per-step panels own their state and worker calls
// (see hooks/useGeometry, useMesh, useSolver) — this component only maps the
// model-tree selection to a panel.
export function PropertiesPanel() {
  const selection = useModelStore((s) => s.treeSelection);
  const items = useTreeItems();
  const { group, target } = selection;
  const groupLabel = TREE_GROUPS.find((g) => g.id === group)?.label;

  let crumb = groupLabel;
  let title: string | undefined;
  if (target.type === "item") {
    crumb = `${groupLabel} / ${KIND_LABEL[target.kind]}`;
    title = items[group].find(
      (i) => i.kind === target.kind && i.id === target.id,
    )?.label;
  } else if (target.type === "add") {
    title = addTitle(selection);
  } else {
    title = VIEW_LABEL[target.view];
  }

  // Keyed by the selection so each object opens with fresh form state.
  const key = JSON.stringify(selection);
  const view = target.type === "view" ? target.view : null;
  return (
    <aside className={styles.aside}>
      <header className={styles.panelHeader}>
        <div className={styles.panelCrumb}>{crumb}</div>
        <div className={styles.panelTitle} data-testid="panel-title">
          {title}
        </div>
      </header>
      {group === "geometry" && <GeometryPanel key={key} target={target} />}
      {group === "materials" && <MaterialsPanel key={key} target={target} />}
      {view === "mesh" && (
        <div className={styles.panel}>
          <div className={styles.tabContent}>
            <MeshPanel />
            <AutoShellSection />
          </div>
        </div>
      )}
      {group === "boundary" && (
        <BoundaryConditionsPanel key={key} target={target} />
      )}
      {view === "static" && <SolvePanel />}
      {view === "topopt" && <OptimizePanel />}
      {view === "results" && <ResultsPanel />}
    </aside>
  );
}
