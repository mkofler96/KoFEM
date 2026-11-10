// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef } from "react";
import {
  LOG_CHANNEL_LABELS,
  clearAllLogs,
  useAllLogs,
  useLogDrawer,
} from "../../hooks/useWorkerLogs";
import styles from "./LogDrawer.module.css";

// Right-hand drawer with every worker log — mesh, solve and optimize — in one
// chronological stream. Hidden by default; opened from the status bar.
export function LogDrawer() {
  const open = useLogDrawer((s) => s.open);
  const toggle = useLogDrawer((s) => s.toggle);
  const logs = useAllLogs();
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Follow the newest line. Scroll the log body itself: scrollIntoView would
  // also scroll the overflow-hidden ancestors and shift the whole layout.
  useEffect(() => {
    const body = bodyRef.current;
    if (open && body) body.scrollTop = body.scrollHeight;
  }, [logs, open]);

  if (!open) return null;

  return (
    <aside className={styles.drawer} aria-label="Logs" data-testid="log-drawer">
      <div className={styles.header}>
        <span className={styles.title}>Logs</span>
        <button
          className={styles.action}
          disabled={logs.length === 0}
          onClick={clearAllLogs}
        >
          Clear
        </button>
        <button
          className={styles.action}
          aria-label="Close logs"
          onClick={toggle}
        >
          ✕
        </button>
      </div>
      <div className={styles.body} ref={bodyRef}>
        {logs.length === 0 ? (
          <div className={styles.empty}>No log output yet.</div>
        ) : (
          logs.map((entry) => (
            <div key={entry.id} className={styles.line}>
              <span className={styles.tag}>
                {LOG_CHANNEL_LABELS[entry.channel]}
              </span>
              {entry.text}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
