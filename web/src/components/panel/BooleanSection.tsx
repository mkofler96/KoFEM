// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useModelStore } from "../../store/modelStore";
import { isCadBody } from "../../store/geometrySlice";
import { useGeometryEdit, type BooleanOp } from "../../hooks/useGeometryEdit";
import styles from "./Panel.module.css";

const OPS: { op: BooleanOp; label: string; hint: string }[] = [
  {
    op: "union",
    label: "Union",
    hint: "Fuse the bodies into one. They must touch or overlap.",
  },
  {
    op: "subtract",
    label: "Subtract",
    hint: "Cut the tool bodies out of the target body.",
  },
  {
    op: "intersect",
    label: "Intersect",
    hint: "Keep only the volume the bodies share.",
  },
];

// Geometry → + Add → From boolean: combine bodies of the model into a new one.
// The result takes the target's place; like a split it is a geometry edit, so
// it clears the mesh and can be undone.
export function BooleanSection() {
  const properties = useModelStore((s) => s.properties);
  const stepBytes = useModelStore((s) => s.stepBytes);
  const hasMesh = useModelStore((s) => s.nodes.length > 0);
  const isRunning = useModelStore((s) => s.isRunning);
  const isMeshing = useModelStore((s) => s.isMeshing);
  const geometryHistory = useModelStore((s) => s.geometryHistory);
  const setHighlightBodyId = useModelStore((s) => s.setHighlightBodyId);
  const { combine, undo, isSplitting, splitError, setSplitError } =
    useGeometryEdit();

  // A suppressed body is as good as deleted — nothing to combine with.
  const bodies = properties
    .filter((p) => isCadBody(p) && !p.suppressed)
    .map((p) => p.id);
  const [op, setOp] = useState<BooleanOp>("union");
  // eslint-disable-next-line kofem/no-silent-fallback -- initial form selection; the form itself only renders with at least two bodies
  const [target, setTarget] = useState(bodies[0] ?? 1);
  const [tools, setTools] = useState<number[]>([]);
  const [keepTools, setKeepTools] = useState(false);

  const editable = stepBytes !== null;
  const busy = isSplitting || isRunning || isMeshing;

  const undoButton = geometryHistory.length > 0 && (
    <button
      className={styles.cancelBtn}
      data-testid="boolean-undo"
      disabled={busy}
      onClick={undo}
    >
      ↶ Undo
    </button>
  );

  // A union leaves one body; the Undo that brings the others back stays.
  if (bodies.length < 2)
    return (
      <>
        <div className={styles.empty} data-testid="boolean-needs-bodies">
          A Boolean combines bodies — the model needs at least two.
        </div>
        {undoButton && <div className={styles.formBtns}>{undoButton}</div>}
      </>
    );
  // Tools are every picked body but the target (re-picking the target as a
  // tool would combine it with itself).
  const activeTools = tools.filter(
    (id) => id !== target && bodies.includes(id),
  );

  function toggleTool(id: number) {
    setTools((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  }

  async function apply() {
    const ok = await combine(op, target, activeTools, keepTools);
    // Body ids are renumbered by the edit; start the next one from scratch.
    if (ok) {
      setTools([]);
      setTarget(1);
    }
  }

  return (
    <>
      {splitError && (
        <div className={styles.errorBanner} data-testid="boolean-error">
          <span>{splitError}</span>
          <button onClick={() => setSplitError(null)}>×</button>
        </div>
      )}
      <div className={styles.segToggle} role="group" aria-label="Operation">
        {OPS.map((o) => (
          <button
            key={o.op}
            type="button"
            data-testid={`boolean-op-${o.op}`}
            className={`${styles.segBtn} ${op === o.op ? styles.segBtnActive : ""}`}
            aria-pressed={op === o.op}
            onClick={() => setOp(o.op)}
          >
            {o.label}
          </button>
        ))}
      </div>
      <div className={styles.pickHint}>
        {OPS.find((o) => o.op === op)?.hint}
      </div>

      <div className={styles.formRow}>
        <span className={styles.formLabel}>
          {op === "subtract" ? "Cut from" : "Target"}
        </span>
        <select
          className={styles.formSelect}
          data-testid="boolean-target"
          value={target}
          onChange={(e) => setTarget(Number(e.target.value))}
          onFocus={() => setHighlightBodyId(target)}
          onBlur={() => setHighlightBodyId(null)}
        >
          {bodies.map((id) => (
            <option key={id} value={id}>
              Body {id}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.sectionLabel}>
        {op === "subtract" ? "Tool bodies" : "Combine with"}
      </div>
      {bodies
        .filter((id) => id !== target)
        .map((id) => (
          <label
            key={id}
            className={styles.formRow}
            onMouseEnter={() => setHighlightBodyId(id)}
            onMouseLeave={() => setHighlightBodyId(null)}
          >
            <input
              type="checkbox"
              data-testid={`boolean-tool-${id}`}
              checked={tools.includes(id)}
              onChange={() => toggleTool(id)}
            />
            <span className={styles.bodyLabel}>Body {id}</span>
          </label>
        ))}

      {op === "subtract" && (
        <label
          className={styles.formRow}
          title="Keep the tool bodies after the cut — they stay in the pocket they made and are bonded to the cut body, like an insert."
        >
          <input
            type="checkbox"
            data-testid="boolean-keep-tools"
            checked={keepTools}
            onChange={(e) => setKeepTools(e.target.checked)}
          />
          <span className={styles.bodyLabel}>Keep tool bodies</span>
        </label>
      )}

      {hasMesh && (
        <div className={styles.hint}>
          A Boolean changes the geometry: the mesh and its supports, loads and
          results are cleared.
        </div>
      )}
      <div className={styles.formBtns}>
        {undoButton}
        <button
          className={styles.primaryBtn}
          data-testid="boolean-apply"
          disabled={!editable || busy || activeTools.length === 0}
          title={
            editable
              ? undefined
              : "Re-import the CAD file to edit its geometry — a saved analysis does not carry it."
          }
          onClick={apply}
        >
          {isSplitting ? "Combining…" : OPS.find((o) => o.op === op)?.label}
        </button>
      </div>
    </>
  );
}
