// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from "react";
import { setLogCallback } from "../workers/sharedWorker";

// A worker log line with a monotonically increasing id, so log lists can use
// a stable React key even though the text itself may repeat.
export interface WorkerLogEntry {
  id: number;
  text: string;
}

// Collects the shared worker's log stream (WASM stdout/stderr plus the
// worker's own status lines) into React state for display in a log panel.
// LeftPanel mounts exactly one panel at a time, so the sharedWorker's single
// log-callback slot always belongs to whichever panel is active — the mesh
// log while meshing on the Geometry tab, the solver log while solving on the
// Solve tab.
export function useWorkerLogs() {
  const [logs, setLogs] = useState<WorkerLogEntry[]>([]);
  const nextLogId = useRef(0);

  useEffect(() => {
    setLogCallback((msg) => {
      setLogs((prev) => [...prev, { id: nextLogId.current++, text: msg }]);
    });
    return () => setLogCallback(null);
  }, []);

  const clearLogs = useCallback(() => setLogs([]), []);

  return { logs, clearLogs };
}
