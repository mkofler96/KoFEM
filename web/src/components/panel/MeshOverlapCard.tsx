// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useModelStore } from "../../store/modelStore";
import { useGeometryEdit } from "../../hooks/useGeometryEdit";
import {
  coneTipFaces,
  hingeRepairs,
  defaultRepairWidth,
} from "../../lib/meshOverlaps";
import type { RepairHingesOptions } from "../../wasm/pkg/kofem_wasm";
import styles from "./Panel.module.css";

// What the last mesh attempt found wrong with the geometry, highlighted in the
// viewport, and the repairs on offer. A repair is a geometry edit: it can be
// undone, and the next mesh runs on the repaired file.
export function MeshOverlapCard({
  maxElementSize,
}: {
  maxElementSize: string;
}) {
  const overlaps = useModelStore((s) => s.meshOverlaps);
  const isRunning = useModelStore((s) => s.isRunning);
  const isMeshing = useModelStore((s) => s.isMeshing);
  const {
    repairHinges,
    splitConeTips,
    isSplitting,
    splitError,
    setSplitError,
  } = useGeometryEdit();
  // Null until typed: the default follows the element size.
  const [typedWidth, setTypedWidth] = useState<string | null>(null);

  if (overlaps.length === 0) return null;

  const hinges = hingeRepairs(overlaps);
  const coneFaces = coneTipFaces(overlaps);
  const cones = overlaps.filter((overlap) => overlap.kind === "cone").length;
  const others = overlaps.length - hinges.length - cones;
  const width = typedWidth ?? defaultRepairWidth(maxElementSize);
  const busy = isSplitting || isRunning || isMeshing;

  async function repair(op: RepairHingesOptions["op"]) {
    await repairHinges({ op, width: parseFloat(width), hinges });
  }

  return (
    <div className={styles.inlineForm} data-testid="mesh-overlap-card">
      {splitError && (
        <div className={styles.errorBanner} data-testid="mesh-overlap-error">
          <span>{splitError}</span>
          <button onClick={() => setSplitError(null)}>×</button>
        </div>
      )}
      {hinges.length > 0 && (
        <>
          <div className={styles.errorBanner} data-testid="hinge-warning">
            <span>
              Geometric singularity detected (hinge): the part pinches to zero
              thickness along{" "}
              {hinges.length === 1 ? "a line" : `${hinges.length} lines`}, so it
              can&apos;t be meshed. Highlighted in the view.
            </span>
          </div>
          <div className={styles.formRow}>
            <span className={styles.formLabel}>Repair width</span>
            <input
              className={styles.formInput}
              data-testid="hinge-repair-width"
              type="number"
              step="any"
              value={width}
              disabled={busy}
              onChange={(e) => setTypedWidth(e.target.value)}
              title="Width of the repair across the line, in mm."
            />
            <span className={styles.toleranceUnit}>mm</span>
          </div>
          <div className={styles.formBtns}>
            <button
              className={styles.outlineBtn}
              data-testid="hinge-separate"
              disabled={busy}
              title="Cut a small gap along the line. Removes a little material."
              onClick={() => repair("separate")}
            >
              Separate
            </button>
            <button
              className={styles.outlineBtn}
              data-testid="hinge-connect"
              disabled={busy}
              title="Weld the two sides along the line. Adds a little material."
              onClick={() => repair("connect")}
            >
              Connect
            </button>
          </div>
        </>
      )}
      {cones > 0 && (
        <>
          <div className={styles.errorBanner} data-testid="cone-warning">
            <span>
              The mesher can&apos;t handle {cones === 1 ? "a" : cones} sharp
              cone {cones === 1 ? "tip" : "tips"} here, highlighted in the view.
              Splitting the {cones === 1 ? "face" : "faces"} fixes this without
              changing the shape.
            </span>
          </div>
          <div className={styles.formBtns}>
            <button
              className={styles.outlineBtn}
              data-testid="cone-split"
              disabled={busy}
              onClick={() => splitConeTips(coneFaces)}
            >
              Split {cones === 1 ? "face" : "faces"}
            </button>
          </div>
        </>
      )}
      {others > 0 && (
        <div
          className={styles.errorBanner}
          data-testid="surface-overlap-warning"
        >
          <span>
            The surface mesh overlaps itself in {others}{" "}
            {others === 1 ? "place" : "places"}, highlighted in the view.
            Simplify the geometry there in CAD and re-import.
          </span>
        </div>
      )}
    </div>
  );
}
