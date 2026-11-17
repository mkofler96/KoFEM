// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import {
  assessConvergence,
  CONVERGED_TOLERANCE,
  REFINEMENT_LEVELS,
  sizeLabel,
  type StudyLevel,
} from "../../lib/refinementStudy";
import type { RefinementStudyRun, Study } from "../../store/studySlice";
import { useEngineGate } from "../../store/engineStore";
import { useSolver } from "../../hooks/useSolver";
import { useRefinementStudy } from "../../hooks/useRefinementStudy";
import { LogSection } from "./LogSection";
import { PreflightChecks } from "./PreflightChecks";
import styles from "./Panel.module.css";
import own from "./RefinementStudy.module.css";

// Mesh refinement study (KOF-401): the study's panel under Studies, which runs
// it, and its result under Results — the levels and the convergence verdict.

// "25, 17.7 and 12.5"
function listSizes(sizes: number[]): string {
  const labels = sizes.map(sizeLabel);
  return labels.length < 2
    ? labels.join("")
    : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

function percent(fraction: number): string {
  const pct = fraction * 100;
  return `${pct > 0 ? "+" : pct < 0 ? "−" : "±"}${Math.abs(pct).toFixed(1)} %`;
}

function Change({ value }: { value: number | null }) {
  if (value === null) return null;
  return <span className={own.change}>{percent(value)}</span>;
}

function LevelTable({ levels }: { levels: StudyLevel[] }) {
  const changes =
    levels.length >= 2
      ? assessConvergence(levels)
      : { displacementChanges: [null], stressChanges: [null] };
  return (
    <table className={own.table} data-testid="refinement-study-table">
      <thead>
        <tr>
          <th>Size mm</th>
          <th>Elements</th>
          <th>Max |U| mm</th>
          <th>Max σ_vm MPa</th>
        </tr>
      </thead>
      <tbody>
        {levels.map((l, i) => (
          <tr
            key={i}
            data-testid="refinement-study-level"
            data-size={l.sizes.max}
            data-elements={l.elements}
            data-max-displacement={l.maxDisplacement}
          >
            <td>{sizeLabel(l.sizes.max)}</td>
            <td>{l.elements.toLocaleString("en-US")}</td>
            <td>
              {l.maxDisplacement.toExponential(3)}
              <Change value={changes.displacementChanges[i]} />
            </td>
            <td>
              {l.maxVonMises === null ? "—" : l.maxVonMises.toPrecision(4)}
              <Change value={changes.stressChanges[i]} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Verdict({ levels }: { levels: StudyLevel[] }) {
  const assessment = assessConvergence(levels);
  // One decimal: an error below 0.1 % reads as "within 0.1 %", a true bound.
  const error = `${Math.max(assessment.estimatedError * 100, 0.1).toFixed(1)} %`;
  const how =
    assessment.method === "richardson"
      ? "estimated error of the finest mesh"
      : "change on the last refinement";
  return (
    <>
      <div
        className={assessment.converged ? own.converged : own.notConverged}
        data-testid="refinement-study-verdict"
      >
        {assessment.converged
          ? `Converged: max displacement within ${error} (${how}).`
          : `Not converged: max displacement ${error} off (${how}, target ${(CONVERGED_TOLERANCE * 100).toFixed(0)} %). Refine further or use quadratic elements.`}
      </div>
      {assessment.stressRising && (
        <div className={own.note} data-testid="refinement-study-stress-note">
          The peak stress keeps rising as the mesh refines: it likely sits at a
          sharp corner, a support or a point load, where the exact stress is
          infinite. Judge the stress away from that spot.
        </div>
      )}
    </>
  );
}

// The study under Studies: the static case's readiness, the plan and the one
// button. While it runs it shows each level as it lands; when it is done the
// app opens the result under Results.
export function RefinementStudyPanel({
  staticCase,
  header,
  footer,
}: {
  staticCase: Study | null;
  header: ReactNode;
  footer: ReactNode;
}) {
  const { isRunning, allOk, checks, elementOrder, logs } = useSolver();
  const { run, refusal, plannedSizes, start } = useRefinementStudy();
  const engine = useEngineGate();
  const running = run?.status === "running";
  const blocked =
    staticCase === null ? "Pick the static study to refine." : refusal;

  return (
    <div className={styles.panel}>
      <div className={styles.tabContent}>
        {header}
        <PreflightChecks checks={checks} />

        <div className={styles.sectionLabel} style={{ marginTop: 16 }}>
          Study settings
        </div>
        <div className={styles.statRow}>
          <span className={styles.statKey}>Levels</span>
          <span className={styles.statVal}>
            {REFINEMENT_LEVELS} · each √2 finer
          </span>
        </div>
        <div className={styles.statRow}>
          <span className={styles.statKey}>Element order</span>
          <span className={styles.statVal}>
            {elementOrder === 2
              ? "Quadratic (2nd order)"
              : "Linear (1st order)"}
          </span>
        </div>

        <button
          className={styles.solveBtn}
          data-testid="refinement-study-run"
          disabled={!allOk || isRunning || engine.blocked || blocked !== null}
          title={engine.reason}
          onClick={() => void start()}
        >
          {running ? "Running study…" : "▶  Run mesh refinement study"}
        </button>
        {blocked !== null ? (
          <div className={own.note} data-testid="refinement-study-refusal">
            {blocked}
          </div>
        ) : (
          plannedSizes !== null &&
          !running && (
            <div className={own.hint}>
              Solves at {listSizes(plannedSizes)} mm and checks that the result
              settles.
            </div>
          )
        )}
        {run?.step && (
          <div className={own.hint} data-testid="refinement-study-step">
            {run.step}
          </div>
        )}
        {run?.error && (
          <div
            className={styles.errorBanner}
            data-testid="refinement-study-error"
          >
            <span>{run.error}</span>
          </div>
        )}
        {running && run.levels.length > 0 && <LevelTable levels={run.levels} />}

        <LogSection logs={logs} busy={isRunning} />
        {footer}
      </div>
    </div>
  );
}

// The study's result under Results: each level, the verdict, and what the
// model shows now.
export function RefinementResult({ run }: { run: RefinementStudyRun }) {
  return (
    <div className={own.card}>
      {run.levels.length > 0 && <LevelTable levels={run.levels} />}
      {run.status === "done" && run.levels.length >= 2 && (
        <Verdict levels={run.levels} />
      )}
      {run.stopNote && <div className={own.note}>{run.stopNote}</div>}
      {run.status === "done" && (
        <div className={own.hint}>
          The model now shows the finest mesh and its solve. Generate the mesh
          again to return to your settings.
        </div>
      )}
    </div>
  );
}
