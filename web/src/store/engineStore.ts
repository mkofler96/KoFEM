// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Readiness of the WASM solver engine in the shared worker (KOF-263): what the
// status bar shows while the ~35 MB engine downloads and compiles, and why an
// import, mesh or solve has to wait. Separate from the model store on purpose —
// the engine outlives "New analysis", and a model reset must not touch it.

import { create } from "zustand";
import { tr } from "../i18n/useLocale";
import { solveMessages } from "../i18n/messages/solve";

export type EnginePhase =
  "idle" | "downloading" | "compiling" | "starting" | "ready" | "failed";

/** The step that failed: the three of the WASM loader, or the worker itself. */
export type EngineFailureStage =
  "download" | "compile" | "instantiate" | "worker";

export interface EngineFailure {
  stage: EngineFailureStage;
  /** What failed, in the loader's or the browser's own words. */
  detail: string;
  /** The likely cause and what the visitor can do about it. */
  hint: string;
}

export interface EngineStatus {
  phase: EnginePhase;
  /** Uncompressed bytes received so far, and the engine's uncompressed size. */
  loaded: number;
  total: number;
  failure: EngineFailure | null;
  /** The engine was ready at least once on this page. A later start is the
   *  restart every mesh triggers (sharedWorker.resetWorker), read from cache. */
  wasReady: boolean;
}

export const useEngineStatus = create<EngineStatus>(() => ({
  phase: "idle",
  loaded: 0,
  total: 0,
  failure: null,
  wasReady: false,
}));

/** The likely cause of a failed engine start, in a few words. */
export function failureHint(
  stage: EngineFailureStage,
  detail: string,
  online: boolean,
): string {
  const text = tr(solveMessages);
  if (stage === "download") {
    if (!online) return text.hintOffline;
    const status = /HTTP (\d{3})/.exec(detail);
    if (status && (status[1] === "404" || status[1] === "410"))
      return text.hintEngineMissing;
    if (status) return text.hintHttp(status[1]);
    return text.hintDownloadBlocked;
  }
  if (stage === "compile") return text.hintCorrupted;
  if (stage === "instantiate")
    return /memory|allocat/i.test(detail)
      ? text.hintMemory
      : text.hintEngineDidNotStart;
  return text.hintWorkerDidNotStart;
}

/**
 * Whether an action that runs in the engine (import, mesh, solve) can start.
 * While the engine loads an action may still be requested (it waits in the
 * worker's queue); a failed engine blocks it until Retry succeeds.
 */
export function engineGate(phase: EnginePhase): {
  blocked: boolean;
  waiting: boolean;
  reason: string | undefined;
} {
  if (phase === "failed")
    return {
      blocked: true,
      waiting: false,
      reason: tr(solveMessages).engineFailed,
    };
  if (phase === "ready")
    return { blocked: false, waiting: false, reason: undefined };
  return {
    blocked: false,
    waiting: true,
    reason: tr(solveMessages).engineLoading,
  };
}

/** The import/mesh/solve gate; re-renders only when the phase changes. */
export function useEngineGate() {
  return engineGate(useEngineStatus((s) => s.phase));
}
