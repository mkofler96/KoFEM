// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A failed worker task says which step failed (KOF-311): the worker wraps a
// step's error with inStage, reports the step next to the message, and the
// page rejects with a WorkerTaskError carrying it, so analytics can name the
// step even when the message itself matches no category.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  inStage,
  splitStage,
  WorkerTaskError,
} from "../../src/lib/workerError.ts";

describe("inStage and splitStage (worker side)", () => {
  test("a step that succeeds returns its value", () => {
    expect(inStage("meshing", () => 42)).toBe(42);
  });

  test("a failed step keeps the original error and names the step", () => {
    const original = new RangeError("Ng_OCC_GenerateEdgeMesh failed (code 1)");
    let caught: unknown;
    try {
      inStage("meshing", () => {
        throw original;
      });
    } catch (err) {
      caught = err;
    }
    expect(splitStage(caught)).toEqual({ stage: "meshing", error: original });
  });

  // Emscripten throws a C++ exception as a bare pointer; describeError must
  // still receive the number to decode it.
  test("a thrown non-Error survives the wrap unchanged", () => {
    let caught: unknown;
    try {
      inStage("geometry_reload", () => {
        throw 1234;
      });
    } catch (err) {
      caught = err;
    }
    expect(splitStage(caught)).toEqual({
      stage: "geometry_reload",
      error: 1234,
    });
  });

  test("an error outside any step has no step", () => {
    const err = new Error("The solver worker is busy with another operation");
    expect(splitStage(err)).toEqual({ stage: null, error: err });
  });
});

// Just enough of a Worker for sharedWorker: it records what the page posts and
// lets the test answer as solver.worker would.
class FakeWorker {
  static last: FakeWorker | null = null;
  posted: { id: number; type: string }[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(message: { id: number; type: string }) {
    this.posted.push(message);
  }
  terminate() {}
  reply(data: unknown) {
    if (!this.onmessage) throw new Error("sharedWorker set no onmessage");
    this.onmessage({ data });
  }
}

describe("sendToWorker (page side)", () => {
  const scope = globalThis as { Worker?: unknown };
  const previousWorker = scope.Worker;
  beforeAll(() => {
    scope.Worker = FakeWorker;
  });
  afterAll(() => {
    scope.Worker = previousWorker;
  });

  async function failedTask(answer: Record<string, unknown>) {
    const { sendToWorker } = await import("../../src/workers/sharedWorker.ts");
    const task = sendToWorker("volume_mesh", {});
    const worker = FakeWorker.last;
    if (!worker) throw new Error("sharedWorker created no worker");
    const request = worker.posted.findLast((m) => m.type === "volume_mesh");
    if (!request) throw new Error("the request never reached the worker");
    worker.reply({ id: request.id, ok: false, ...answer });
    return task.then(
      () => {
        throw new Error(
          "the task resolved although the worker reported a failure",
        );
      },
      (err: unknown) => err,
    );
  }

  test("the step the worker reports reaches the rejection", async () => {
    const err = await failedTask({
      error: "Standard_Failure: BRep_API: command not done",
      stage: "shell_idealisation",
    });
    expect(err).toBeInstanceOf(WorkerTaskError);
    expect((err as WorkerTaskError).message).toBe(
      "Standard_Failure: BRep_API: command not done",
    );
    expect((err as WorkerTaskError).stage).toBe("shell_idealisation");
  });

  test("a failure outside any step has no step", async () => {
    const err = await failedTask({ error: "busy" });
    expect(err).toBeInstanceOf(WorkerTaskError);
    expect((err as WorkerTaskError).stage).toBeNull();
  });

  test("a step the page does not know is an explicit protocol error", async () => {
    const err = await failedTask({ error: "boom", stage: "teleport" });
    expect((err as WorkerTaskError).stage).toBeNull();
    expect((err as WorkerTaskError).message).toContain(
      'unknown step "teleport"',
    );
    expect((err as WorkerTaskError).message).toContain("boom");
  });
});
