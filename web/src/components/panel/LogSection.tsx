// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useRef, useEffect } from "react";
import type { WorkerLogEntry } from "../../hooks/useWorkerLogs";
import styles from "./LeftPanel.module.css";

// VSCode-style collapsable log panel showing the worker's log stream — used
// by both the mesher (Geometry tab) and the solver (Solve tab) so long-running
// WASM operations report live progress the same way. Renders nothing until
// the operation starts or produces its first line.
export function LogSection({
  logs,
  busy,
}: {
  logs: WorkerLogEntry[];
  busy: boolean;
}) {
  const [open, setOpen] = useState(true);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  if (logs.length === 0 && !busy) return null;

  return (
    <div className={styles.logSection}>
      <button className={styles.logHeader} onClick={() => setOpen((v) => !v)}>
        <span
          className={`${styles.logChevron} ${open ? styles.logChevronOpen : ""}`}
        >
          ▶
        </span>
        <span>LOGS</span>
        {busy && <span className={styles.logSpinner}>●</span>}
        {logs.length > 0 && (
          <span className={styles.logBadge}>{logs.length}</span>
        )}
      </button>
      {open && (
        <div className={styles.logBody}>
          {logs.length === 0 ? (
            <div className={styles.logEmpty}>Waiting…</div>
          ) : (
            logs.map((entry, i) => (
              <div
                key={entry.id}
                className={`${styles.logLine} ${i === logs.length - 1 ? styles.logLineLast : ""}`}
              >
                {entry.text}
              </div>
            ))
          )}
          <div ref={endRef} />
        </div>
      )}
    </div>
  );
}
