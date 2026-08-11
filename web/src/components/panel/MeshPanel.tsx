// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useModelStore } from "../../store/modelStore";
import { useMesh } from "../../hooks/useMesh";
import { estimateElementCount } from "../../lib/meshSizing";
import type { GeometryMeasure } from "../../lib/meshSizing";
import { LogSection } from "./LogSection";
import styles from "./LeftPanel.module.css";

// Bounding box of the import, as "x × y × z". Three significant digits keep a
// 0.8 mm part and a 2400 mm weldment equally readable.
function formatExtent({ dx, dy, dz }: GeometryMeasure): string {
  const round = (value: number) => Number(value.toPrecision(3)).toString();
  return `${round(dx)} × ${round(dy)} × ${round(dz)}`;
}

// Rough element count the current max size implies, as "12K"/"1.2M" — the size
// fields are unbounded, so this is what tells the user a value is about to cost
// them minutes of meshing before they click.
function formatEstimate(measure: GeometryMeasure, size: string): string | null {
  const parsed = parseFloat(size);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const count = estimateElementCount(measure, parsed);
  if (!Number.isFinite(count)) return null;
  if (count >= 1e6) return `${(count / 1e6).toPrecision(2)}M`;
  if (count >= 1e3) return `${Math.round(count / 1e3)}K`;
  return `${Math.round(count)}`;
}

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
    geometryMeasure,
    meshError,
    setMeshError,
    logs,
    meshVolume,
  } = useMesh();

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
          {geometryMeasure && (
            <div className={styles.hint} data-testid="geometry-extent">
              Model extent {formatExtent(geometryMeasure)} mm
              {(() => {
                const estimate = formatEstimate(
                  geometryMeasure,
                  maxElementSize,
                );
                return estimate === null ? null : ` · ≈${estimate} elements`;
              })()}
            </div>
          )}
          <div className={styles.formRow}>
            <span className={styles.formLabel}>Max element size</span>
            <input
              className={styles.formInput}
              data-testid="max-element-size"
              type="number"
              step="any"
              value={maxElementSize}
              disabled={isMeshing}
              onChange={(e) => setMaxElementSize(e.target.value)}
              title="Upper bound on the element size, in mm. Any positive value is allowed — size it to the part, not to a fixed range."
            />
            <span className={styles.toleranceUnit}>mm</span>
          </div>
          <div className={styles.formRow}>
            <span className={styles.formLabel}>Min element size</span>
            <input
              className={styles.formInput}
              data-testid="min-element-size"
              type="number"
              step="any"
              value={minElementSize}
              disabled={isMeshing}
              onChange={(e) => setMinElementSize(e.target.value)}
              title="Floor for curvature-driven refinement, in mm. 0 lets Netgen refine fillets without limit."
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

      <LogSection logs={logs} busy={isMeshing} />
    </>
  );
}
