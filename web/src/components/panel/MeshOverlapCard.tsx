// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useModelStore } from "../../store/modelStore";
import { useGeometryEdit } from "../../hooks/useGeometryEdit";
import {
  coneTipFaces,
  hingeRepairs,
  defaultRepairWidth,
  narrowestUnmeshedWidth,
  removableUnmeshedFaces,
  unmeshedFaces,
} from "../../lib/meshOverlaps";
import type { RepairHingesOptions } from "../../wasm/pkg/kofem_wasm";
import styles from "./Panel.module.css";

// What the last mesh attempt found wrong with the geometry, highlighted in the
// viewport, and the repairs on offer. A repair is a geometry edit: it can be
// undone, and the next mesh runs on the repaired file.
export function MeshOverlapCard({
  maxElementSize,
  minElementSize,
}: {
  maxElementSize: string;
  minElementSize: string;
}) {
  const overlaps = useModelStore((s) => s.meshOverlaps);
  const isRunning = useModelStore((s) => s.isRunning);
  const isMeshing = useModelStore((s) => s.isMeshing);
  const {
    repairHinges,
    splitConeTips,
    removeFaces,
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
  const unmeshed = unmeshedFaces(overlaps).length;
  const removable = removableUnmeshedFaces(overlaps, minElementSize);
  const narrowest = narrowestUnmeshedWidth(overlaps);
  const others = overlaps.filter(
    (overlap) => overlap.kind === "surface",
  ).length;
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
      {unmeshed > 0 && (
        <>
          <div className={styles.errorBanner} data-testid="unmeshed-warning">
            <span>
              The mesher couldn&apos;t mesh {unmeshed}{" "}
              {unmeshed === 1 ? "face" : "faces"}, highlighted in the view
              {narrowest !== null &&
                ` (${unmeshed === 1 ? "" : "narrowest "}${formatWidth(narrowest)} mm wide)`}
              .{" "}
              {removable.length === unmeshed
                ? `${unmeshed === 1 ? "It is" : "They are"} narrower than the minimum element size.`
                : "Try a smaller element size."}
            </span>
          </div>
          {removable.length > 0 && (
            <>
              <div className={styles.formBtns}>
                <button
                  className={styles.outlineBtn}
                  data-testid="unmeshed-remove"
                  disabled={busy}
                  title="Extend the surrounding faces to close the gap."
                  onClick={() => removeFaces(removable)}
                >
                  Remove{" "}
                  {removable.length === 1
                    ? "narrow face"
                    : `${removable.length} narrow faces`}
                </button>
              </div>
              <div className={styles.hint} data-testid="unmeshed-remove-note">
                Changes the shape by about the face width, which can affect
                results right next to it. If that detail matters, fix it in CAD.
              </div>
            </>
          )}
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

// A face width for the message: enough digits to tell 0.001 mm from 0.01 mm.
function formatWidth(width: number): string {
  return String(Number(width.toPrecision(2)));
}
