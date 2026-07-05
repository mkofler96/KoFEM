// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useModelStore } from "../../store/modelStore";
import type { AppMode } from "../../store/modelStore";
import styles from "./LeftPanel.module.css";

const MODES: { id: AppMode; label: string }[] = [
  { id: "geometry", label: "Geometry" },
  { id: "constraints", label: "Constraints" },
  { id: "solve", label: "Solve" },
  { id: "results", label: "Results" },
];

export function PanelNav() {
  const mode = useModelStore((s) => s.mode);
  const setMode = useModelStore((s) => s.setMode);
  const nodes = useModelStore((s) => s.nodes);
  const constraints = useModelStore((s) => s.constraints);
  const loads = useModelStore((s) => s.loads);
  const result = useModelStore((s) => s.result);
  const setSidebarOpen = useModelStore((s) => s.setSidebarOpen);

  function isValid(m: AppMode): boolean {
    if (m === "geometry") return nodes.length > 0;
    if (m === "constraints") return constraints.length > 0 || loads.length > 0;
    if (m === "solve" || m === "results") return result !== null;
    return false;
  }

  return (
    <nav className={styles.modeNav}>
      {MODES.map(({ id, label }) => {
        const active = id === mode;
        const valid = isValid(id);
        return (
          <button
            key={id}
            className={`${styles.navTab} ${active ? styles.navTabActive : styles.navTabFuture}`}
            onClick={() => setMode(id)}
          >
            {valid ? (
              <span className={`${styles.navDot} ${styles.navDotDone}`}>
                <svg viewBox="0 0 8 8" width="5" height="5">
                  <path
                    d="M1.5 4L3 5.5L6.5 2"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    fill="none"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
            ) : (
              <span className={styles.navDot} />
            )}
            <span className={styles.navTabLabel}>{label}</span>
          </button>
        );
      })}
      <button
        className={styles.collapseBtn}
        title="Hide panel"
        aria-label="Hide panel"
        onClick={() => setSidebarOpen(false)}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
          <path
            d="M10 3L5.5 8 10 13"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </nav>
  );
}
