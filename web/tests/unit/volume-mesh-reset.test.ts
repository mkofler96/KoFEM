// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// After Netgen ran, the next engine call gets a fresh worker, whether the mesh
// succeeded or failed (KOF-418). A mesh that ran out of memory leaves the
// engine module holding the leaked Netgen mesh and OCC geometry; kept, it
// fails every retry, first out of memory again and then with Aborted() (an
// engine_crash), until the page is reloaded.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MeshSizes } from "../../src/store/geometrySlice";

// Just enough of a Worker for sharedWorker: it records what the page posts and
// lets the test answer as solver.worker would.
class FakeWorker {
  static all: FakeWorker[] = [];
  posted: { id: number; type: string }[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  terminated = false;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(message: { id: number; type: string }) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: unknown) {
    if (!this.onmessage) throw new Error("sharedWorker set no onmessage");
    this.onmessage({ data });
  }
}

function liveWorker(): FakeWorker {
  const live = FakeWorker.all.filter((w) => !w.terminated);
  if (live.length !== 1)
    throw new Error(`expected one live worker, found ${live.length}`);
  return live[0];
}

function meshRequest(worker: FakeWorker): { id: number } {
  const request = worker.posted.findLast((m) => m.type === "volume_mesh");
  if (!request) throw new Error("the mesh request never reached the worker");
  return request;
}

const sizes: MeshSizes = { max: 3, min: 0.3, regions: {}, faces: {} };
const input = {
  stepBytes: new Uint8Array([1, 2, 3]),
  geometryFormat: "step" as const,
  properties: [],
  sizes,
};

describe("runVolumeMesh worker lifecycle", () => {
  const scope = globalThis as { Worker?: unknown };
  const previousWorker = scope.Worker;
  beforeAll(async () => {
    scope.Worker = FakeWorker;
    // sharedWorker is one module for every test file: start from a worker of
    // this file's FakeWorker, not one another file left behind.
    const { resetWorker } = await import("../../src/workers/sharedWorker.ts");
    resetWorker();
  });
  afterAll(() => {
    scope.Worker = previousWorker;
  });

  test("a failed mesh replaces the worker before the retry", async () => {
    const { runVolumeMesh } = await import("../../src/lib/volumeMesh.ts");
    const task = runVolumeMesh(input);
    const meshing = liveWorker();
    meshing.reply({
      id: meshRequest(meshing).id,
      ok: false,
      error: "std::bad_alloc: std::bad_alloc",
      stage: "meshing",
    });
    expect(task).rejects.toThrow("std::bad_alloc");
    await task.catch(() => undefined);
    expect(meshing.terminated).toBe(true);
    expect(liveWorker()).not.toBe(meshing);
  });

  test("a cancelled mesh does not reset the worker the cancel started", async () => {
    const { runVolumeMesh } = await import("../../src/lib/volumeMesh.ts");
    const { resetWorker } = await import("../../src/workers/sharedWorker.ts");
    const task = runVolumeMesh(input);
    // New model while meshing: the app resets the worker itself.
    resetWorker();
    const fresh = liveWorker();
    await task.catch(() => undefined);
    expect(fresh.terminated).toBe(false);
  });
});
