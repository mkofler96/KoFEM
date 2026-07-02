// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useModelStore } from "../../store/modelStore";
import { PanelNav } from "./PanelNav";
import { GeometryPanel } from "./GeometryPanel";
import { BoundaryConditionsPanel } from "./BoundaryConditionsPanel";
import { SolvePanel } from "./SolvePanel";
import { ResultsPanel } from "./ResultsPanel";
import styles from "./LeftPanel.module.css";

// Thin orchestrator: the per-mode panels own their state and worker calls
// (see hooks/useGeometry, useMesh, useSolver) — this component only maps the
// active mode to a panel.
export function LeftPanel() {
  const mode = useModelStore((s) => s.mode);
  return (
    <aside className={styles.aside}>
      <PanelNav />
      {mode === "geometry" && <GeometryPanel />}
      {mode === "constraints" && <BoundaryConditionsPanel />}
      {mode === "solve" && <SolvePanel />}
      {mode === "results" && <ResultsPanel />}
    </aside>
  );
}
