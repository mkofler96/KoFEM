// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Singleton WASM worker shared across all components.
// Each call gets a unique message ID; the onmessage handler routes
// responses back to the correct Promise via a pending-call map.

import { durationBucket, trackOnce } from "../lib/analytics";
import {
  failureHint,
  useEngineStatus,
  type EngineFailureStage,
} from "../store/engineStore";

let _worker: Worker | null = null;
let _msgId = 0;
const _pending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();
let _logCallback: ((message: string) => void) | null = null;

export function setLogCallback(cb: ((message: string) => void) | null) {
  _logCallback = cb;
}

// Intermediate results a long-running call streams before it resolves — today
// only the topology optimizer's per-iteration density (KOF-240).
export interface WorkerProgress {
  it: number;
  density: Float64Array;
}
let _progressCallback: ((progress: WorkerProgress) => void) | null = null;

export function setProgressCallback(
  cb: ((progress: WorkerProgress) => void) | null,
) {
  _progressCallback = cb;
}

// solver.worker's engine load progress (see its EngineStatusMessage).
type EngineStatusMessage =
  | { phase: "downloading" | "compiling"; loaded: number; total: number }
  | { phase: "starting" }
  | { phase: "ready"; initMs: number }
  | { phase: "failed"; stage: EngineFailureStage; detail: string };

function failEngine(stage: EngineFailureStage, detail: string) {
  useEngineStatus.setState({
    phase: "failed",
    failure: {
      stage,
      detail,
      hint: failureHint(stage, detail, navigator.onLine),
    },
  });
}

function applyEngineStatus(status: EngineStatusMessage) {
  if (status.phase === "ready") {
    // The worker is recreated after every mesh; only the first start, the
    // one a visitor waits for, is reported.
    trackOnce("engine_ready", {
      duration_bucket: durationBucket(status.initMs),
    });
    useEngineStatus.setState({ phase: "ready", wasReady: true });
  } else if (status.phase === "failed") {
    failEngine(status.stage, status.detail);
  } else if (status.phase === "starting") {
    useEngineStatus.setState({ phase: "starting" });
  } else {
    useEngineStatus.setState({
      phase: status.phase,
      loaded: status.loaded,
      total: status.total,
    });
  }
}

function createWorker(): Worker {
  const worker = new Worker(new URL("./solver.worker.ts", import.meta.url), {
    type: "module",
  });
  useEngineStatus.setState({ phase: "downloading", loaded: 0 });

  worker.onmessage = (e: MessageEvent) => {
    // Coverage counters shipped by the worker before it can be terminated
    // (see solver.worker's finally block). Stash them for the test fixture.
    const workerCov = (e.data as { __workerCoverage?: unknown })
      .__workerCoverage;
    if (workerCov !== undefined) {
      const scope = globalThis as { __workerCoverage__?: unknown[] };
      if (!scope.__workerCoverage__) scope.__workerCoverage__ = [];
      scope.__workerCoverage__.push(workerCov);
      return;
    }
    const { id, ok, log, progress, engineStatus, ...rest } = e.data as {
      id: number;
      ok?: boolean;
      log?: string;
      progress?: WorkerProgress;
      engineStatus?: EngineStatusMessage;
      [k: string]: unknown;
    };
    if (engineStatus !== undefined) {
      applyEngineStatus(engineStatus);
      return;
    }
    if (log !== undefined) {
      // Always emit to browser console so Playwright and DevTools see it
      // regardless of which panel is active (log callback may be null).
      console.log("[wasm]", log);
      _logCallback?.(log);
      return;
    }
    if (progress !== undefined) {
      // Progress does not settle the call. Drop it once the call is no longer
      // pending (resetWorker cleared it), so a cancelled run cannot repaint the
      // viewport after the fact.
      if (_pending.has(id)) _progressCallback?.(progress);
      return;
    }
    // The answer to startEngine()'s "init". Its outcome already arrived as an
    // engineStatus message.
    if (id === 0) return;
    const pending = _pending.get(id);
    if (!pending) {
      console.warn(
        `[worker] dropped response for unknown id ${id} — no pending request` +
          ` (pending ids: [${[..._pending.keys()].join(", ")}]).` +
          " Likely a response that arrived after resetWorker() or a duplicate resolution.",
      );
      return;
    }
    _pending.delete(id);
    if (ok) {
      pending.resolve(rest);
    } else {
      // eslint-disable-next-line kofem/no-silent-fallback -- fallback text for a failure that arrived without a message; this is the error path itself, not solver data
      const msg = (rest.error as string | undefined) ?? "Worker error";
      console.error("[worker] task failed:", msg);
      pending.reject(new Error(msg));
    }
  };

  worker.onerror = (e: ErrorEvent) => {
    console.error("[worker] crashed:", e.message, e);
    // eslint-disable-next-line kofem/no-silent-fallback -- fallback text for a worker that died without a message; this is the error path itself, not solver data
    const err = new Error(e.message ?? "Worker crashed");
    for (const p of _pending.values()) p.reject(err);
    _pending.clear();
    // An uncaught error does not end a worker by itself; end it, so the
    // replacement below is the only engine holding memory.
    worker.terminate();
    if (_worker === worker) _worker = null;
    // Dying before the engine was ready means the worker script itself did
    // not load or run (a module worker that fails to load reports a bare
    // Event, no message). A crash mid-task leaves a working engine behind:
    // start a fresh one for the next request.
    if (useEngineStatus.getState().phase !== "ready")
      failEngine(
        "worker",
        e.message
          ? `The solver worker failed: ${e.message}`
          : "The solver worker script did not load or run.",
      );
    else startEngine();
  };

  return worker;
}

function getWorker(): Worker {
  if (!_worker) _worker = createWorker();
  return _worker;
}

export function sendToWorker<T = unknown>(
  type: string,
  payload: unknown,
): Promise<T> {
  // A failed engine stays failed until retryEngine(); a request must not
  // silently start a second attempt behind the status bar's back.
  const { failure } = useEngineStatus.getState();
  if (failure)
    return Promise.reject(
      new Error(
        `The solver engine failed to load: ${failure.detail} Retry from the status bar.`,
      ),
    );
  return new Promise<T>((resolve, reject) => {
    const id = ++_msgId;
    _pending.set(id, { resolve: (v) => resolve(v as T), reject });
    getWorker().postMessage({ id, type, payload });
  });
}

/**
 * Start loading the engine now rather than on the first request: the ~35 MB
 * download and its compilation then overlap with the visitor finding their
 * file instead of following it (KOF-263). A no-op while a worker exists.
 */
export function startEngine(): void {
  if (_worker || useEngineStatus.getState().failure) return;
  getWorker().postMessage({ id: 0, type: "init" });
}

/** The status bar's Retry: a fresh worker and a fresh engine load. */
export function retryEngine(): void {
  useEngineStatus.setState({ failure: null });
  resetWorker();
}

// Terminate and recreate the worker.  Call this after volume meshing so that
// Netgen's Ng_Init() global C++ state does not contaminate the WASM runtime
// for the subsequent MFEM solve.  Any in-flight requests are rejected. The
// replacement starts loading at once, so the next request — the solve after a
// mesh — finds it compiled instead of waiting for it.
export function resetWorker(): void {
  if (_worker) {
    _worker.terminate();
    _worker = null;
  }
  for (const p of _pending.values())
    p.reject(new Error("Worker reset — restart your operation"));
  _pending.clear();
  startEngine();
}
