// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useRef, useState } from "react";
import { useModelStore } from "../../store/modelStore";
import type { SplitMode } from "../../store/modelStore";
import { useGeometryEdit } from "../../hooks/useGeometryEdit";
import type { SplitAxis } from "../../hooks/useGeometryEdit";
import { tessellationBounds } from "../../lib/cadFaces";
import styles from "./LeftPanel.module.css";

const AXES: SplitAxis[] = ["x", "y", "z"];

const SPLIT_TIP =
  "Cut the geometry with a plane. Split faces to apply a support or a load to " +
  "part of a face — a bearing pad, a load patch: the cut becomes an edge and " +
  "each piece is a face of its own, pickable in one click. Split bodies to cut " +
  "a part into bodies that can take different materials; the pieces stay " +
  "bonded at the cut.";

const MODE_HINT: Record<SplitMode, string> = {
  faces:
    "Click the faces to split in the viewport, then Split. The part stays one body.",
  bodies:
    "Cuts every body the plane crosses into two bodies, bonded at the cut.",
};

// Plane position typed as text, like the mesh sizes: there is no range to clamp
// it to, and it is validated when the split runs.
function formatMm(value: number): string {
  return String(Number(value.toPrecision(6)));
}

// The split tool: cut faces or bodies of the imported geometry with an
// axis-aligned plane. Closed, it is one button; open, it draws the cutting
// plane in the viewport and (in face mode) lets the user pick the faces to cut.
export function SplitSection() {
  const stepSurface = useModelStore((s) => s.stepSurface);
  const stepBytes = useModelStore((s) => s.stepBytes);
  const hasMesh = useModelStore((s) => s.nodes.length > 0);
  const isRunning = useModelStore((s) => s.isRunning);
  const isMeshing = useModelStore((s) => s.isMeshing);
  const geometryHistory = useModelStore((s) => s.geometryHistory);
  const splitPicking = useModelStore((s) => s.splitPicking);
  const setSplitPicking = useModelStore((s) => s.setSplitPicking);
  const splitFaceIds = useModelStore((s) => s.splitFaceIds);
  const toggleSplitFace = useModelStore((s) => s.toggleSplitFace);
  const clearSplitFaces = useModelStore((s) => s.clearSplitFaces);
  const setSplitDraft = useModelStore((s) => s.setSplitDraft);
  const setViewRepr = useModelStore((s) => s.setViewRepr);
  const { split, undo, isSplitting, splitError, setSplitError } =
    useGeometryEdit();

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<SplitMode>("faces");
  const [axis, setAxis] = useState<SplitAxis>("x");
  const bounds = useMemo(
    () => (stepSurface ? tessellationBounds(stepSurface.points) : null),
    [stepSurface],
  );
  // The plane starts through the middle of the model on the chosen axis — a
  // visible cut to move from, rather than one at the origin, outside the part.
  const centre = (k: number) =>
    bounds ? formatMm((bounds.min[k] + bounds.max[k]) / 2) : "0";
  const [position, setPosition] = useState(() => centre(0));
  const axisIndex = AXES.indexOf(axis) as 0 | 1 | 2;
  const parsed = parseFloat(position);

  // Draw the plane while the tool is open and the position is a number.
  useEffect(() => {
    setSplitDraft(
      open && Number.isFinite(parsed)
        ? { axis: axisIndex, position: parsed }
        : null,
    );
  }, [open, axisIndex, parsed, setSplitDraft]);

  // The tool as it is NOW, for a split's continuation: the worker answers after
  // an await, by which time the user may have closed the tool, switched to
  // Bodies or left the Geometry step. The open/mode the split started with
  // would turn picking back on behind a closed form.
  const liveTool = useRef({ open, mode });
  useEffect(() => {
    liveTool.current = { open, mode };
  }, [open, mode]);

  // Leaving the Geometry step (unmount) ends the tool, picks and plane included.
  useEffect(
    () => () => {
      liveTool.current = { ...liveTool.current, open: false };
      setSplitPicking(false);
      clearSplitFaces();
      setSplitDraft(null);
    },
    [setSplitPicking, clearSplitFaces, setSplitDraft],
  );

  if (!stepSurface) return null;
  // A saved analysis carries the tessellation but neither the file nor face
  // ids; there is nothing to cut until the CAD file is imported again.
  const editable = stepBytes !== null && stepSurface.faceIds !== undefined;
  const busy = isSplitting || isRunning || isMeshing;

  function openTool() {
    setOpen(true);
    setSplitError(null);
    // The panel mounts before any import, so start each session's plane at the
    // middle of the geometry it will cut.
    setPosition(centre(axisIndex));
    // Faces are picked on the CAD geometry, not on a mesh.
    setViewRepr("geometry");
    if (mode === "faces") setSplitPicking(true);
  }

  function closeTool() {
    setOpen(false);
    setSplitError(null);
    setSplitPicking(false);
    clearSplitFaces();
  }

  function chooseMode(next: SplitMode) {
    setMode(next);
    setSplitError(null);
    setSplitPicking(next === "faces");
    if (next === "bodies") clearSplitFaces();
  }

  function chooseAxis(next: SplitAxis) {
    setAxis(next);
    setPosition(centre(AXES.indexOf(next)));
  }

  // The undone geometry has its own face ids; resume picking on it.
  function undoSplit() {
    undo();
    if (open && mode === "faces") setSplitPicking(true);
  }

  async function applySplit() {
    const ok = await split(mode, axis, parsed, splitFaceIds);
    // The edit replaced every face id, so the old picks are gone; keep picking
    // so a run of cuts (both pads of a beam, say) needs no extra clicks.
    if (ok && liveTool.current.open && liveTool.current.mode === "faces")
      setSplitPicking(true);
  }

  return (
    <>
      <div className={styles.sectionLabel} title={SPLIT_TIP}>
        Split geometry
      </div>
      {!open ? (
        <>
          <button
            className={styles.outlineBtn}
            data-testid="split-open"
            disabled={!editable || busy}
            title={
              editable
                ? SPLIT_TIP
                : "Re-import the CAD file to edit its geometry — a saved analysis does not carry it."
            }
            onClick={openTool}
          >
            ✂ Split faces or bodies with a plane…
          </button>
          {geometryHistory.length > 0 && (
            <button
              className={styles.outlineBtn}
              data-testid="split-undo"
              disabled={busy}
              onClick={undoSplit}
            >
              ↶ Undo last split
            </button>
          )}
        </>
      ) : (
        <div className={styles.inlineForm} data-testid="split-form">
          {splitError && (
            <div className={styles.errorBanner} data-testid="split-error">
              <span>{splitError}</span>
              <button onClick={() => setSplitError(null)}>×</button>
            </div>
          )}
          <div className={styles.segToggle} role="group" aria-label="Split">
            {(["faces", "bodies"] as SplitMode[]).map((m) => (
              <button
                key={m}
                type="button"
                data-testid={`split-mode-${m}`}
                className={`${styles.segBtn} ${mode === m ? styles.segBtnActive : ""}`}
                aria-pressed={mode === m}
                onClick={() => chooseMode(m)}
              >
                {m === "faces" ? "Faces" : "Bodies"}
              </button>
            ))}
          </div>
          <div className={styles.formRow}>
            <span className={styles.formLabel}>Cut plane</span>
            <select
              className={`${styles.formSelect} ${styles.planeAxis}`}
              data-testid="split-axis"
              value={axis}
              onChange={(e) => chooseAxis(e.target.value as SplitAxis)}
            >
              {AXES.map((a) => (
                <option key={a} value={a}>
                  {a} =
                </option>
              ))}
            </select>
            <input
              className={`${styles.formInput} ${styles.planePosition}`}
              data-testid="split-position"
              type="number"
              step="any"
              value={position}
              onChange={(e) => setPosition(e.target.value)}
              title="Position of the cutting plane along the chosen axis, in mm"
            />
            <span className={styles.toleranceUnit}>mm</span>
          </div>
          <div className={styles.pickHint}>{MODE_HINT[mode]}</div>
          {mode === "faces" &&
            splitFaceIds.map((id) => (
              <div
                key={id}
                className={styles.bcFaceRow}
                data-testid={`split-face-${id}`}
              >
                <span className={styles.bcFaceName}>Face {id}</span>
                <button
                  className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                  title="Remove face"
                  onClick={() => toggleSplitFace(id)}
                >
                  ×
                </button>
              </div>
            ))}
          {mode === "faces" && !splitPicking && (
            <button
              className={styles.outlineBtn}
              data-testid="split-pick"
              onClick={() => setSplitPicking(true)}
            >
              Pick faces
            </button>
          )}
          {hasMesh && (
            <div className={styles.hint}>
              Splitting changes the geometry: the mesh and its supports, loads
              and results are cleared.
            </div>
          )}
          <div className={styles.formBtns}>
            <button className={styles.cancelBtn} onClick={closeTool}>
              Close
            </button>
            {geometryHistory.length > 0 && (
              <button
                className={styles.cancelBtn}
                data-testid="split-undo"
                disabled={busy}
                onClick={undoSplit}
              >
                ↶ Undo
              </button>
            )}
            <button
              className={styles.primaryBtn}
              data-testid="split-apply"
              disabled={
                busy ||
                !Number.isFinite(parsed) ||
                (mode === "faces" && splitFaceIds.length === 0)
              }
              onClick={applySplit}
            >
              {isSplitting ? "Splitting…" : "Split"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
