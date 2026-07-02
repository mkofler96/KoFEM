// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useRef, useEffect } from "react";
import { useModelStore } from "../../store/modelStore";
import { useMesh } from "../../hooks/useMesh";
import styles from "./LeftPanel.module.css";

// Mesh sizing controls, the mesh/re-mesh action and the meshing log — rendered
// inside the Geometry tab below the import cards.
export function MeshPanel() {
  const hasMesh = useModelStore((s) => s.nodes.length > 0);
  const {
    stepSurface,
    isMeshing,
    elementOrder,
    setElementOrder,
    maxElementSize,
    setMaxElementSize,
    minElementSize,
    setMinElementSize,
    meshError,
    setMeshError,
    logs,
    meshVolume,
  } = useMesh();

  const [logsOpen, setLogsOpen] = useState(true);
  const logsEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const showLogs = logs.length > 0 || isMeshing;

  return (
    <>
      {meshError && (
        <div className={styles.errorBanner} data-testid="meshing-error">
          <span>{meshError}</span>
          <button onClick={() => setMeshError(null)}>×</button>
        </div>
      )}

      {stepSurface ? (
        <>
          <div className={styles.sectionLabel}>Mesh controls</div>
          <div className={styles.formRow}>
            <span className={styles.formLabel}>Max element size</span>
            <input
              className={styles.formInput}
              type="number"
              min={0.5}
              max={500}
              step={0.5}
              value={maxElementSize}
              disabled={isMeshing}
              onChange={(e) =>
                setMaxElementSize(Math.max(0.5, Number(e.target.value)))
              }
            />
            <span className={styles.toleranceUnit}>mm</span>
          </div>
          <div className={styles.formRow}>
            <span className={styles.formLabel}>Min element size</span>
            <input
              className={styles.formInput}
              type="number"
              min={0}
              max={500}
              step={0.5}
              value={minElementSize}
              disabled={isMeshing}
              onChange={(e) =>
                setMinElementSize(Math.max(0, Number(e.target.value)))
              }
            />
            <span className={styles.toleranceUnit}>mm</span>
          </div>
          <div className={styles.formRow}>
            <span className={styles.formLabel}>Element order</span>
            <select
              className={styles.formSelect}
              value={elementOrder}
              onChange={(e) => setElementOrder(Number(e.target.value))}
            >
              <option value={1}>Linear (1st order)</option>
              <option value={2}>Quadratic (2nd order)</option>
            </select>
          </div>
          <button
            className={hasMesh ? styles.outlineBtn : styles.meshVolBtn}
            disabled={isMeshing}
            onClick={meshVolume}
          >
            {isMeshing
              ? "Meshing…"
              : hasMesh
                ? "⟳ Re-mesh STEP volume"
                : "▶  Mesh STEP volume"}
          </button>
        </>
      ) : (
        !hasMesh && (
          <div className={styles.empty}>
            No mesh — import a STEP file to mesh.
          </div>
        )
      )}

      {/* VSCode-style collapsable log panel */}
      {showLogs && (
        <div className={styles.logSection}>
          <button
            className={styles.logHeader}
            onClick={() => setLogsOpen((v) => !v)}
          >
            <span
              className={`${styles.logChevron} ${logsOpen ? styles.logChevronOpen : ""}`}
            >
              ▶
            </span>
            <span>LOGS</span>
            {isMeshing && <span className={styles.logSpinner}>●</span>}
            {logs.length > 0 && (
              <span className={styles.logBadge}>{logs.length}</span>
            )}
          </button>
          {logsOpen && (
            <div className={styles.logBody}>
              {logs.length === 0 ? (
                <div className={styles.logEmpty}>Waiting…</div>
              ) : (
                logs.map((line, i) => (
                  <div
                    key={i}
                    className={`${styles.logLine} ${i === logs.length - 1 ? styles.logLineLast : ""}`}
                  >
                    {line}
                  </div>
                ))
              )}
              <div ref={logsEndRef} />
            </div>
          )}
        </div>
      )}
    </>
  );
}
