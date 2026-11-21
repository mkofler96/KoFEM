// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import { useModelStore } from "../../store/modelStore";
import type { DensityResult, TopOptView } from "../../store/modelStore";
import { useTopOpt } from "../../hooks/useTopOpt";
import { resultUnit } from "../../lib/resultField";
import {
  buildDensityStl,
  buildSmoothDensityStl,
  densityStlFileName,
  levelSetField,
  nodalDensity,
} from "../../lib/densityField";
import { DensityThresholdControl } from "./DensityThresholdControl";
import { NotConvergedNotice } from "./NotConvergedNotice";
import styles from "./Panel.module.css";
import own from "./RefinementStudy.module.css";

// Results → Density: the topology optimization's result, laid out like the
// mesh refinement study's (KOF-401). A run comes here as it starts. The list
// switches the centre between the density in 3D — live while the run goes —
// and the convergence chart (TopOptChart), drawn in place of the 3D view. A
// run that stopped at its iteration limit says so first (KOF-412).
export function TopOptResult({ footer }: { footer: ReactNode }) {
  // Holds the optimizer's log stream while the run goes, and starts a "Run
  // again" request.
  const { cancel, error, setError } = useTopOpt();
  const densityResult = useModelStore((s) => s.densityResult);
  const isOptimizing = useModelStore((s) => s.isOptimizing);
  const liveDensity = useModelStore((s) => s.liveDensity);
  const maxIterations = useModelStore((s) => s.topOpt.maxIterations);
  const view = useModelStore((s) => s.topOptView);
  const setView = useModelStore((s) => s.setTopOptView);
  const rerun = useModelStore((s) => s.rerunTopOptWithMoreIterations);
  const live = isOptimizing ? liveDensity : null;
  // The density the threshold filters: the finished run's, or the live one.
  const shown =
    densityResult !== null
      ? densityResult.density
      : live !== null
        ? live.density
        : null;

  const row = (target: TopOptView, label: string, sub: string | null) => (
    <button
      className={`${own.row} ${view === target ? own.rowShown : ""}`}
      data-testid={`topopt-view-${target}`}
      aria-current={view === target}
      onClick={() => setView(target)}
    >
      <span className={own.rowMain}>
        {label}
        {sub !== null && <span className={own.rowSub}>{sub}</span>}
      </span>
    </button>
  );

  return (
    <div className={styles.panel}>
      <div className={styles.tabContent}>
        <div className={own.result}>
          {error && (
            <div className={styles.errorBanner}>
              <span>{error}</span>
              <button onClick={() => setError(null)}>×</button>
            </div>
          )}
          {isOptimizing ? (
            <div className={own.hint} data-testid="topopt-run-status">
              {live === null
                ? "Optimizing · starting"
                : `Optimizing · iteration ${live.it} of ${maxIterations}`}
            </div>
          ) : densityResult?.converged ? (
            <div className={own.converged} data-testid="topopt-converged">
              Converged after {densityResult.iterations} iterations
            </div>
          ) : (
            densityResult && (
              <NotConvergedNotice run={densityResult} onRerun={rerun} />
            )
          )}

          {(densityResult !== null || isOptimizing) && (
            <div className={own.list}>
              {row(
                "density",
                "Density in 3D",
                isOptimizing ? "Live, as the run goes" : null,
              )}
              {row("chart", "Convergence chart", null)}
            </div>
          )}

          {isOptimizing && (
            <button
              className={styles.cancelBtn}
              style={{ width: "100%" }}
              onClick={cancel}
            >
              Cancel
            </button>
          )}
        </div>

        {view === "density" && shown !== null && (
          <div style={{ marginTop: 16 }}>
            <DensityThresholdControl density={shown} />
          </div>
        )}
        {densityResult && <TopOptSummary {...densityResult} />}
        {footer}
      </div>
    </div>
  );
}

// The finished run: its numbers and the shape's export.
function TopOptSummary({ density, levelSet, history }: DensityResult) {
  // Changing any TO setting clears the density result, so the store's settings
  // are the ones this run used — including its σ_allow (KOF-236).
  const stressConstraint = useModelStore((s) => s.topOpt.stressConstraint);
  const maxStressText = useModelStore((s) => s.topOpt.maxStress);
  const stressLimit = stressConstraint ? Number(maxStressText) : NaN;
  const threshold = useModelStore((s) => s.densityThreshold);
  const smooth = useModelStore((s) => s.densitySmooth);
  // Something to export at this threshold: a level-set run has material where
  // its mapped φ reaches the cutoff; otherwise some element density must.
  const anyKept =
    smooth && levelSet
      ? levelSetField(levelSet).some((v) => v >= threshold)
      : density.some((d) => d >= threshold);
  let min = Infinity;
  let max = -Infinity;
  for (const d of density) {
    if (d < min) min = d;
    if (d > max) max = d;
  }
  const last = history[history.length - 1];

  return (
    <>
      <div className={styles.sectionLabel} style={{ marginTop: 16 }}>
        Run summary
      </div>
      <div className={styles.statRow}>
        <span className={styles.statKey}>Iterations</span>
        <span className={styles.statVal}>{history.length}</span>
      </div>
      {last && (
        <>
          <div className={styles.statRow}>
            <span className={styles.statKey}>Final volume frac.</span>
            <span className={styles.statVal}>{last.volume.toFixed(3)}</span>
          </div>
          <div className={styles.statRow}>
            <span className={styles.statKey}>Final compliance</span>
            {/* data-value: the unrounded number, which the examples' GUI
                test compares with the published one (KOF-322). */}
            <span
              className={styles.statVal}
              data-testid="topopt-final-compliance"
              data-value={last.compliance}
            >
              {last.compliance.toExponential(3)}
            </span>
          </div>
          {last.max_stress !== undefined && (
            <div className={styles.statRow}>
              <span className={styles.statKey}>Max von Mises</span>
              <span
                className={styles.statVal}
                data-testid="topopt-final-max-stress"
              >
                {last.max_stress.toExponential(3)}{" "}
                {resultUnit("Von Mises stress")}
                {Number.isFinite(stressLimit)
                  ? ` (limit ${stressLimit.toExponential(3)})`
                  : ""}
              </span>
            </div>
          )}
        </>
      )}
      <div className={styles.statRow}>
        <span className={styles.statKey}>Density range</span>
        <span className={styles.statVal}>
          {min.toFixed(3)} – {max.toFixed(3)}
        </span>
      </div>

      <div className={styles.sectionLabel} style={{ marginTop: 16 }}>
        Export
      </div>
      <button
        className={styles.outlineBtn}
        onClick={() => downloadDensityStl(density, levelSet, threshold, smooth)}
        disabled={!anyKept}
      >
        Export shape as STL
      </button>
      <div className={styles.formNote} style={{ marginTop: 6 }}>
        {!anyKept
          ? "No material is kept at this threshold — lower it to export a shape."
          : smooth
            ? "The smooth surface shown at the current threshold, in model units."
            : "Faceted surface of the elements shown at the current threshold, in model units."}
      </div>
    </>
  );
}

// Writes the thresholded shape the viewport shows as a binary STL (KOF-239):
// the smooth surface in Smooth mode (the level set's own φ contour, or the
// node-averaged density for SIMP — the same field DensityField draws), the
// element boundary in Elements mode.
function downloadDensityStl(
  density: Float64Array,
  levelSet: Float64Array | undefined,
  threshold: number,
  smooth: boolean,
) {
  const { nodes, elements, modelName } = useModelStore.getState();
  let stl: ArrayBuffer | null;
  if (!smooth) stl = buildDensityStl(nodes, elements, density, threshold);
  else {
    const field = levelSet
      ? levelSetField(levelSet)
      : nodalDensity(nodes, elements, density);
    stl = field
      ? buildSmoothDensityStl(
          nodes,
          elements,
          field,
          threshold,
          levelSet ? "level set" : "density",
        )
      : null;
  }
  if (!stl)
    throw new Error(
      `STL export: no surface at threshold ${threshold} — the density (${density.length} values) does not match the current mesh or keeps no element`,
    );
  const url = URL.createObjectURL(new Blob([stl], { type: "model/stl" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = densityStlFileName(modelName, threshold);
  anchor.click();
  URL.revokeObjectURL(url);
}
