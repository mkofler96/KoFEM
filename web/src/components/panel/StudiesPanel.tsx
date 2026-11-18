// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useModelStore } from "../../store/modelStore";
import type { TreeTarget } from "../../store/viewSlice";
import type { DerivedStudyKind } from "../../store/studySlice";
import { SolvePanel } from "./SolvePanel";
import { OptimizePanel } from "./OptimizePanel";
import { RefinementStudyPanel } from "./RefinementStudy";
import styles from "./Panel.module.css";

// Studies → + Add: a static solve, or a topology optimization or a mesh
// refinement study of a static case.
function AddStudy() {
  const studies = useModelStore((s) => s.studies);
  const addStudy = useModelStore((s) => s.addStudy);
  const statics = studies.filter((st) => st.kind === "static");
  // The kind of study built on a static case whose case picker is open.
  const [derived, setDerived] = useState<DerivedStudyKind | null>(null);
  // eslint-disable-next-line kofem/no-silent-fallback -- preselects the first static case in the picker; with none the optimization choice is disabled and this is never read
  const [staticId, setStaticId] = useState(statics[0]?.id ?? 0);

  return (
    <div className={styles.addChooser}>
      <button
        className={styles.addChoice}
        data-testid="add-study-static"
        onClick={() => addStudy("static")}
      >
        <span className={styles.addChoiceLabel}>Static</span>
        <span className={styles.addChoiceHint}>
          Linear-elastic response to the supports and loads
        </span>
      </button>
      <button
        className={`${styles.addChoice} ${derived === "topopt" ? styles.addChoiceActive : ""}`}
        data-testid="add-study-topopt"
        disabled={statics.length === 0}
        aria-expanded={derived === "topopt"}
        onClick={() => setDerived("topopt")}
      >
        <span className={styles.addChoiceLabel}>Topology optimization</span>
        <span className={styles.addChoiceHint}>
          {statics.length === 0
            ? "Add a static study first — an optimization works on a static case"
            : "Material layout that best carries a static case"}
        </span>
      </button>
      <button
        className={`${styles.addChoice} ${derived === "refinement" ? styles.addChoiceActive : ""}`}
        data-testid="add-study-refinement"
        disabled={statics.length === 0}
        aria-expanded={derived === "refinement"}
        onClick={() => setDerived("refinement")}
      >
        <span className={styles.addChoiceLabel}>Mesh refinement</span>
        <span className={styles.addChoiceHint}>
          {statics.length === 0
            ? "Add a static study first — a refinement study checks a static case"
            : "Solve a static case on finer meshes to check the result settles"}
        </span>
      </button>
      {derived !== null && statics.length > 0 && (
        <div className={styles.inlineForm}>
          <div className={styles.formRow}>
            <span className={styles.formLabel}>Static case</span>
            <select
              className={styles.formSelect}
              data-testid="add-study-static-case"
              value={staticId}
              onChange={(e) => setStaticId(Number(e.target.value))}
            >
              {statics.map((st) => (
                <option key={st.id} value={st.id}>
                  {st.name}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.formBtns}>
            <button
              className={styles.cancelBtn}
              onClick={() => setDerived(null)}
            >
              Cancel
            </button>
            <button
              className={styles.primaryBtn}
              data-testid="add-study-create"
              onClick={() => addStudy(derived, staticId)}
            >
              {derived === "topopt"
                ? "Add optimization"
                : "Add refinement study"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// One study, opened from the tree: its solver panel, plus — for an
// optimization or a refinement study — the static case it works on.
function StudyDetail({ id }: { id: number }) {
  const studies = useModelStore((s) => s.studies);
  const setStudyStatic = useModelStore((s) => s.setStudyStatic);
  const deleteStudy = useModelStore((s) => s.deleteStudy);
  const study = studies.find((st) => st.id === id);
  if (!study) return null;

  const footer = (
    <button
      className={styles.dangerBtn}
      data-testid="delete-study"
      onClick={() => deleteStudy(study.id)}
    >
      Delete study
    </button>
  );
  if (study.kind === "static")
    return <SolvePanel study={study} header={null} footer={footer} />;

  const statics = studies.filter((st) => st.kind === "static");
  const staticCase = statics.find((st) => st.id === study.staticId) ?? null;
  const header = (
    <div className={styles.formRow}>
      <span className={styles.formLabel}>Static case</span>
      <select
        className={styles.formSelect}
        data-testid="study-static-case"
        value={staticCase?.id ?? ""}
        onChange={(e) => setStudyStatic(study.id, Number(e.target.value))}
      >
        {!staticCase && <option value="">— pick a static study —</option>}
        {statics.map((st) => (
          <option key={st.id} value={st.id}>
            {st.name}
          </option>
        ))}
      </select>
    </div>
  );
  if (study.kind === "refinement")
    return (
      <RefinementStudyPanel
        staticCase={staticCase}
        header={header}
        footer={footer}
      />
    );
  return (
    <OptimizePanel staticCase={staticCase} header={header} footer={footer} />
  );
}

export function StudiesPanel({ target }: { target: TreeTarget }) {
  if (target.type === "item") return <StudyDetail id={target.id} />;
  return (
    <div className={styles.panel}>
      <div className={styles.tabContent}>
        <AddStudy />
      </div>
    </div>
  );
}
