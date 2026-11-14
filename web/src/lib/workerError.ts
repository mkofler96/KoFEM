// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Which step of a worker task failed (KOF-311). The worker's error text crosses
// to the page as a plain string, and much of it — a Netgen exception, an OCCT
// Standard_Failure, a Rust shellize error — matches no analytics category. The
// step it happened in does: solver.worker wraps a step with inStage, reports
// the step next to the message, and sharedWorker rejects with a
// WorkerTaskError that carries it.

export const FAILURE_STAGES = [
  // Reloading the CAD shape from the original bytes before meshing.
  "geometry_reload",
  // Netgen's surface and volume meshing.
  "meshing",
  // Collapsing Shell bodies to a mid-surface mesh after meshing.
  "shell_idealisation",
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

/** The step an error was thrown in (null outside any step), and the error. */
export function splitStage(err: unknown): {
  stage: FailureStage | null;
  error: unknown;
} {
  return err instanceof StageFailure
    ? { stage: err.stage, error: err.error }
    : { stage: null, error: err };
}

/** Page side: a worker task's failure, with the step the worker reported. */
export class WorkerTaskError extends Error {
  constructor(
    message: string,
    readonly stage: FailureStage | null,
  ) {
    super(message);
  }
}
