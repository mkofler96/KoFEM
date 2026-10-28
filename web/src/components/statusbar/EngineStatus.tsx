// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEngineStatus } from "../../store/engineStore";
import { retryEngine } from "../../workers/sharedWorker";
import styles from "./StatusBar.module.css";

const mb = (bytes: number) => Math.round(bytes / 1e6);

// The solver engine's readiness (KOF-263). Import, mesh and solve wait on it.
export function EngineStatus() {
  const { phase, loaded, total, failure, wasReady } = useEngineStatus();

  if (phase === "idle") return null;

  if (phase === "failed" && failure)
    return (
      <span
        className={`${styles.engineChip} ${styles.engineFailed}`}
        data-testid="engine-error"
        data-phase={phase}
        role="alert"
        title={failure.detail}
      >
        <span className={styles.failDot} />
        <span>
          Engine failed
          <span className={styles.engineHint}>: {failure.hint}</span>
        </span>
        <button className={styles.engineRetry} onClick={retryEngine}>
          Retry
        </button>
      </span>
    );

  if (phase === "ready")
    return (
      <span
        className={styles.engineChip}
        data-testid="engine-status"
        data-phase={phase}
      >
        <span className={styles.okDot} />
        Engine ready
      </span>
    );

  // Every start after the first is the restart a mesh triggers, from cache.
  const downloading = phase === "downloading" && !wasReady && total > 0;
  const label = wasReady
    ? "Restarting engine…"
    : downloading
      ? `Loading engine… ${mb(loaded)}/${mb(total)} MB`
      : "Starting engine…";
  return (
    <span
      className={`${styles.engineChip} ${styles.engineLoading}`}
      data-testid="engine-status"
      data-phase={phase}
    >
      <span className={styles.engineTrack}>
        <span
          className={`${styles.engineFill} ${downloading ? "" : styles.engineFillBusy}`}
          style={{ width: downloading ? `${(100 * loaded) / total}%` : "100%" }}
        />
      </span>
      {label}
    </span>
  );
}
