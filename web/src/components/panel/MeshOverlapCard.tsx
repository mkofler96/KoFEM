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
import { useT } from "../../i18n/useLocale";
import { meshMessages } from "../../i18n/messages/mesh";
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
  const text = useT(meshMessages);

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
            <span>{text.hingeWarning(hinges.length)}</span>
          </div>
          <div className={styles.formRow}>
            <span className={styles.formLabel}>{text.repairWidth}</span>
            <input
              className={styles.formInput}
              data-testid="hinge-repair-width"
              type="number"
              step="any"
              value={width}
              disabled={busy}
              onChange={(e) => setTypedWidth(e.target.value)}
              title={text.repairWidthTip}
            />
            <span className={styles.toleranceUnit}>mm</span>
          </div>
          <div className={styles.formBtns}>
            <button
              className={styles.outlineBtn}
              data-testid="hinge-separate"
              disabled={busy}
              title={text.separateTip}
              onClick={() => repair("separate")}
            >
              {text.separate}
            </button>
            <button
              className={styles.outlineBtn}
              data-testid="hinge-connect"
              disabled={busy}
              title={text.connectTip}
              onClick={() => repair("connect")}
            >
              {text.connect}
            </button>
          </div>
        </>
      )}
      {cones > 0 && (
        <>
          <div className={styles.errorBanner} data-testid="cone-warning">
            <span>{text.coneWarning(cones)}</span>
          </div>
          <div className={styles.formBtns}>
            <button
              className={styles.outlineBtn}
              data-testid="cone-split"
              disabled={busy}
              onClick={() => splitConeTips(coneFaces)}
            >
              {text.splitFaces(cones)}
            </button>
          </div>
        </>
      )}
      {unmeshed > 0 && (
        <>
          <div className={styles.errorBanner} data-testid="unmeshed-warning">
            <span>
              {text.unmeshedFaces(unmeshed)}
              {narrowest !== null &&
                text.unmeshedWidth(unmeshed, formatWidth(narrowest))}
              .{" "}
              {removable.length === unmeshed
                ? text.narrowerThanMin(unmeshed)
                : text.trySmallerSize}
            </span>
          </div>
          {removable.length > 0 && (
            <>
              <div className={styles.formBtns}>
                <button
                  className={styles.outlineBtn}
                  data-testid="unmeshed-remove"
                  disabled={busy}
                  title={text.removeNarrowFacesTip}
                  onClick={() => removeFaces(removable)}
                >
                  {text.removeNarrowFaces(removable.length)}
                </button>
              </div>
              <div className={styles.hint} data-testid="unmeshed-remove-note">
                {text.removeNarrowFacesNote}
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
          <span>{text.surfaceOverlap(others)}</span>
        </div>
      )}
    </div>
  );
}

// A face width for the message: enough digits to tell 0.001 mm from 0.01 mm.
function formatWidth(width: number): string {
  return String(Number(width.toPrecision(2)));
}
