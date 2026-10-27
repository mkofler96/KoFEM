// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useModelStore } from "../../store/modelStore";
import {
  SAMPLE_EXAMPLE_ID,
  openExample,
  useExampleLoad,
} from "../../lib/examples";
import styles from "./EmptyState.module.css";

// An empty workspace offers the ready-to-run sample (KOF-261), so a first
// simulation needs no CAD file. Gone as soon as there is a model.
export function EmptyState() {
  const hasStarted = useModelStore((s) => s.hasStarted);
  const importing = useModelStore((s) => s.isRunning);
  const loading = useExampleLoad((s) => s.loading);
  if (hasStarted) return null;
  return (
    <div className={styles.overlay}>
      <div className={styles.entry} data-testid="empty-state">
        <button
          className={styles.sampleBtn}
          disabled={importing || loading !== null}
          onClick={() => openExample(SAMPLE_EXAMPLE_ID)}
        >
          {loading !== null ? "Opening…" : "Try a sample simulation"}
        </button>
        <p className={styles.note}>
          A ready-to-run steel cantilever — no CAD file needed.
        </p>
      </div>
    </div>
  );
}
