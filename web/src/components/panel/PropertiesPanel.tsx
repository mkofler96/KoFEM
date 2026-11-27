// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useModelStore } from "../../store/modelStore";
import type { TreeItemKind, TreeSelection } from "../../store/viewSlice";
import { GeometryPanel } from "./GeometryPanel";
import { MaterialsPanel } from "./MaterialsPanel";
import { MeshPanel } from "./MeshPanel";
import { BoundaryConditionsPanel } from "./BoundaryConditionsPanel";
import { StudiesPanel } from "./StudiesPanel";
import { ResultsPanel } from "./ResultsPanel";
import { treeGroupLabel } from "./ModelTree";
import { useT } from "../../i18n/useLocale";
import { shellMessages } from "../../i18n/messages/shell";
import { useTreeItems } from "./modelTreeItems";
import styles from "./Panel.module.css";

type ShellText = (typeof shellMessages)["en"];

function kindLabel(text: ShellText, kind: TreeItemKind): string {
  return {
    body: text.kindBody,
    region: text.kindRegion,
    interface: text.kindInterface,
    material: text.kindMaterial,
    mesh: text.kindMesh,
    bc: text.kindSupport,
    load: text.kindLoad,
    tie: text.kindTie,
    contact: text.kindContact,
    coupling: text.kindCoupling,
    temperature: text.kindTemperature,
    study: text.kindStudy,
    plot: text.kindPlot,
    section: text.kindSection,
    reactions: text.kindReactions,
  }[kind];
}

function addTitle(text: ShellText, { group, target }: TreeSelection): string {
  if (group === "geometry") return text.addGeometry;
  if (group === "materials") return text.newMaterial;
  if (group === "mesh") return text.newMesh;
  if (group === "studies") return text.newStudy;
  if (group === "results") return text.newResultPlot;
  if (target.type === "add" && target.kind !== null)
    return {
      bc: text.newSupport,
      load: text.newLoad,
      tie: text.newTie,
      contact: text.newContact,
      coupling: text.newCoupling,
      temperature: text.newTemperature,
    }[target.kind];
  return text.addBoundary;
}

// Thin orchestrator: the per-step panels own their state and worker calls
// (see hooks/useGeometry, useMesh, useSolver) — this component only maps the
// model-tree selection to a panel.
export function PropertiesPanel() {
  const selection = useModelStore((s) => s.treeSelection);
  const items = useTreeItems();
  const text = useT(shellMessages);
  const { group, target } = selection;
  const groupLabel = treeGroupLabel(text, group);

  let crumb = groupLabel;
  let title: string | undefined;
  if (target.type === "item") {
    crumb = `${groupLabel} / ${kindLabel(text, target.kind)}`;
    title = items[group].find(
      (i) => i.kind === target.kind && i.id === target.id,
    )?.label;
  } else {
    title = addTitle(text, selection);
  }

  // Keyed by the selection so each object opens with fresh form state.
  const key = JSON.stringify(selection);
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
      {group === "mesh" && (
        <div className={styles.panel}>
          <div className={styles.tabContent}>
            <MeshPanel />
          </div>
        </div>
      )}
      {group === "boundary" && (
        <BoundaryConditionsPanel key={key} target={target} />
      )}
      {group === "studies" && <StudiesPanel key={key} target={target} />}
      {group === "results" && <ResultsPanel key={key} target={target} />}
    </aside>
  );
}
