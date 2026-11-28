// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Which step of a worker task failed (KOF-311). The worker's error text crosses
// to the page as a plain string, and much of it — a Netgen exception, an OCCT
// Standard_Failure, a Rust shellize error — matches no analytics category. The
// step it happened in does: solver.worker wraps a step with inStage, reports
// the step next to the message, and sharedWorker rejects with a
// WorkerTaskError that carries it.

export const FAILURE_STAGES = [
  // Reading, repairing and tessellating a CAD file on import (KOF-347).
  "geometry_import",
  // Reloading the CAD shape from the original bytes before meshing.
  "geometry_reload",
  // Netgen's surface and volume meshing.
  "meshing",
  // Collapsing Shell bodies to a mid-surface mesh after meshing.
  "shell_idealisation",
  // A static solve or a topology optimization, from routing to result (KOF-418).
  "solving",
] as const;
export type FailureStage = (typeof FAILURE_STAGES)[number];

export function isFailureStage(value: unknown): value is FailureStage {
  return (FAILURE_STAGES as readonly unknown[]).includes(value);
}

/** Worker side: an error thrown inside `stage`, kept unchanged in `error`. */
class StageFailure extends Error {
  constructor(
    readonly stage: FailureStage,
    readonly error: unknown,
  ) {
    super(`${stage} failed`);
  }
}

/** Run one step of a worker task; a throw from it is tagged with the step. */
export function inStage<T>(stage: FailureStage, run: () => T): T {
  try {
    return run();
  } catch (err) {
    throw new StageFailure(stage, err);
  }
}

/** `inStage` for an asynchronous step: a rejection is tagged with the step. */
export async function inStageAsync<T>(
  stage: FailureStage,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw new StageFailure(stage, err);
  }
}

/** The step an error was thrown in (null outside any step), and the error. */
export function splitStage(err: unknown): {
  stage: FailureStage | null;
  error: unknown;
} {
  return err instanceof StageFailure
    ? { stage: err.stage, error: err.error }
    : { stage: null, error: err };
}

// The class the Rust module sets on a FemError it raises
// (crates/kofem-fem/src/failure_class.rs, KOF-490), and cgRun on its own
// stalled solve. Validated where it is classified (lib/analytics.ts).
export interface RustFailureClass {
  category: string;
  reason: string | null;
}

/** The class set on `err`, or null when it carries none. */
export function rustFailureClass(err: unknown): RustFailureClass | null {
  if (typeof err !== "object" || err === null || !("failureClass" in err))
    return null;
  const reason = "numericalReason" in err ? err.numericalReason : null;
  if (
    typeof err.failureClass !== "string" ||
    (reason !== null && typeof reason !== "string")
  )
    throw new Error(
      `an error carries a failure class that is not text: ${String(err.failureClass)}, ${String(reason)}`,
    );
  return { category: err.failureClass, reason };
}

/** An error thrown in TypeScript that the Rust module would class `rust`. */
export class ClassifiedError extends Error {
  readonly failureClass: string;
  readonly numericalReason: string | null;
  constructor(message: string, rust: RustFailureClass) {
    super(message);
    this.failureClass = rust.category;
    this.numericalReason = rust.reason;
  }
}

/**
 * Page side: a worker task's failure, with the step the worker reported, the
 * English of its message (the message is in the user's language;
 * src/i18n/english.ts) and the class the Rust module gave it.
 */
export class WorkerTaskError extends Error {
  constructor(
    message: string,
    readonly stage: FailureStage | null,
    readonly english: string,
    readonly rustClass: RustFailureClass | null,
  ) {
    super(message);
  }
}

/** What a request in flight rejects with when the worker dies mid-task. */
export class WorkerCrashError extends Error {}
