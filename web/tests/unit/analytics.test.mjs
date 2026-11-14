// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for src/lib/analytics.ts — product events only ever reach gtag
// with consent, wait in memory while the banner is unanswered, carry no free
// text, and errors map to fixed categories. The consent loader itself is
// exercised in the browser by tests/analytics-consent.spec.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CONSENT_EVENT,
  categorizeError,
  durationBucket,
  modelType,
  resetAnalyticsForTests,
  track,
  trackOnce,
} from "../../src/lib/analytics.ts";
import { WorkerTaskError } from "../../src/lib/workerError.ts";

// A window with just what the loader and the utility touch.
const sent = [];
const win = new EventTarget();
const hadWindow = "window" in globalThis;
const previousWindow = globalThis.window;
beforeAll(() => {
  globalThis.window = win;
});
afterAll(() => {
  if (hadWindow) globalThis.window = previousWindow;
  else delete globalThis.window;
});

function setConsent(state) {
  if (state === undefined) delete win.__kofemAnalyticsConsent;
  else win.__kofemAnalyticsConsent = state;
  if (state === "granted")
    win.gtag = (command, name, params) => sent.push({ command, name, params });
  win.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: state }));
}
function fresh(state) {
  resetAnalyticsForTests();
  delete win.gtag;
  sent.length = 0;
  setConsent(state);
}
const opened = { entry: "direct", duration_bucket: "1_5s" };

describe("consent gating", () => {
  test("granted: the event reaches gtag with its parameters", () => {
    fresh("granted");
    track("solver_opened", opened);
    expect(sent).toHaveLength(1);
    expect(sent[0].command).toBe("event");
    expect(sent[0].name).toBe("solver_opened");
    expect(sent[0].params.entry).toBe("direct");
  });

  test("denied: nothing is sent and gtag is never defined", () => {
    fresh("denied");
    track("solver_opened", opened);
    expect(sent).toHaveLength(0);
    expect(win.gtag).toBeUndefined();
  });

  test("disabled (no measurement ID): nothing is sent", () => {
    fresh("disabled");
    track("solver_opened", opened);
    expect(sent).toHaveLength(0);
  });

  test("pending: nothing is sent while the banner is unanswered", () => {
    fresh(undefined);
    track("solver_opened", opened);
    track("geometry_import_success", {
      format: "step",
      duration_bucket: "lt_1s",
    });
    expect(sent).toHaveLength(0);
    expect(win.gtag).toBeUndefined();
  });

  test("pending → granted: queued events are sent in order", () => {
    fresh(undefined);
    track("solver_opened", opened);
    track("geometry_import_success", {
      format: "step",
      duration_bucket: "lt_1s",
    });
    setConsent("granted");
    expect(sent.map((event) => event.name)).toEqual([
      "solver_opened",
      "geometry_import_success",
    ]);
  });

  test("pending → denied: queued events are discarded, not sent on a later accept", () => {
    fresh(undefined);
    track("solver_opened", opened);
    setConsent("denied");
    setConsent("granted");
    expect(sent).toHaveLength(0);
  });

  test("pending queue is bounded", () => {
    fresh(undefined);
    for (let count = 0; count < 40; count++)
      track("results_viewed", { workflow: "example" });
    setConsent("granted");
    expect(sent, `${sent.length} events`).toHaveLength(25);
  });

  test("withdrawn: events after the withdrawal are not sent", () => {
    fresh("granted");
    track("solver_opened", opened);
    setConsent("denied");
    track("solve_started", { workflow: "cad_import", analysis_type: "static" });
    expect(sent.map((event) => event.name)).toEqual(["solver_opened"]);
  });

  test("trackOnce sends once per page", () => {
    fresh("granted");
    trackOnce("solver_opened", opened);
    trackOnce("solver_opened", opened);
    expect(sent).toHaveLength(1);
  });
});

describe("no free text leaves the page", () => {
  test("a parameter with spaces, paths or excess length is refused", () => {
    fresh("granted");
    const errors = [];
    const original = console.error;
    console.error = (message) => errors.push(message);
    try {
      track("example_loaded", {
        example_id: "C:\\Users\\me\\bracket v2.step",
        duration_bucket: "lt_1s",
      });
      track("example_load_failed", {
        example_id: "x".repeat(65),
        error_category: "unknown",
      });
    } finally {
      console.error = original;
    }
    expect(sent).toHaveLength(0);
    expect(errors).toHaveLength(2);
  });

  test("the refusal names the parameter but not its value", () => {
    fresh("granted");
    const errors = [];
    const original = console.error;
    console.error = (message) => errors.push(message);
    try {
      track("example_loaded", {
        example_id: "C:\\Users\\me\\bracket v2.step",
        duration_bucket: "lt_1s",
      });
      track("example_load_failed", {
        example_id: "x".repeat(65),
        error_category: "unknown",
      });
    } finally {
      console.error = original;
    }
    expect(errors).toHaveLength(2);
    for (const message of errors) {
      expect(message).toContain("example_id");
      expect(message).not.toContain("bracket");
    }
  });

  test("a gallery id passes", () => {
    fresh("granted");
    track("example_loaded", {
      example_id: "mbb-beam-topopt",
      duration_bucket: "1_5s",
    });
    expect(sent).toHaveLength(1);
  });
});

describe("session continuity", () => {
  test("an event after 30 min of silence is preceded by a page_view", () => {
    fresh("granted");
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      track("solver_opened", opened);
      now += 10 * 60 * 1000;
      track("solve_started", { workflow: "example", analysis_type: "static" });
      now += 31 * 60 * 1000;
      track("solve_completed", {
        workflow: "example",
        analysis_type: "static",
        duration_bucket: "gt_5min",
      });
    } finally {
      Date.now = realNow;
    }
    expect(sent.map((event) => event.name)).toEqual([
      "solver_opened",
      "solve_started",
      "page_view",
      "solve_completed",
    ]);
  });
});

describe("buckets and categories", () => {
  test.each([
    [0, "lt_1s"],
    [999, "lt_1s"],
    [1_000, "1_5s"],
    [14_999, "5_15s"],
    [59_999, "15_60s"],
    [60_000, "1_5min"],
    [300_000, "gt_5min"],
  ])("duration bucket of %i ms is %s", (milliseconds, bucket) => {
    expect(durationBucket(milliseconds)).toBe(bucket);
  });

  test.each([
    [
      "STEPControl_Reader::ReadFile failed — invalid STEP file",
      "unsupported_format",
    ],
    [
      "IGESControl_Reader::ReadFile failed — invalid IGES file",
      "unsupported_format",
    ],
    [
      "CG solver did not converge: relative residual 1e-2 after 5000 iterations",
      "numerical_failure",
    ],
    ["shell: singular 3×3 matrix", "numerical_failure"],
    ["RuntimeError: Aborted(OOM)", "resource_limit"],
    ["Cannot enlarge memory arrays to size 2147483648 bytes", "resource_limit"],
    // Allocation failure inside the C++ engine, decoded by describeError.
    ["std::bad_alloc: std::bad_alloc", "resource_limit"],
    // A trap is a code bug in the engine; the worker survives it.
    [
      "WASM trap (code bug, not OOM): RuntimeError: memory access out of bounds",
      "engine_crash",
    ],
    ["Uncaught RuntimeError: unreachable", "engine_crash"],
    ["RuntimeError: Aborted(Assertion failed)", "engine_crash"],
    ["Worker crashed", "worker_failure"],
    // New model while meshing ends the task: the user stopped it.
    ["Worker reset — restart your operation", "cancelled"],
    [
      "The solver engine failed to load: Failed to fetch Retry from the status bar.",
      "engine_unavailable",
    ],
    // Netgen gave up on the shape.
    ["Ng_OCC_GenerateSurfaceMesh failed (code 1)", "mesher_failure"],
    ["Ng_GenerateVolumeMesh failed (code 1)", "mesher_failure"],
    [
      "netgen::NgException: illegal hash-position in Geomsearch",
      "mesher_failure",
    ],
    [
      "OCCGeometry construction failed — check STEP geometry validity",
      "mesher_failure",
    ],
    // The geometry itself cannot make a valid volume mesh.
    [
      "Ng_GenerateVolumeMesh failed (code 1). The boundary mesh contains overlapping or self-intersecting elements that geometry healing could not repair",
      "geometry_defect",
    ],
    [
      "Volume meshing produced 0 tetrahedra: the geometry has surfaces but no closed solid to fill.",
      "geometry_defect",
    ],
    // OCCT could not triangulate the shape.
    ["BRepMesh_IncrementalMesh failed", "tessellation_failure"],
    [
      "shape produced no triangles — try a smaller deflection_relative",
      "tessellation_failure",
    ],
    ["No geometry found.", "invalid_input"],
    ["mixed solve: the model has no shell element", "invalid_input"],
    ["something nobody anticipated", "unknown"],
  ])("error category of %p is %s", (message, category) => {
    expect(categorizeError(new Error(message))).toBe(category);
  });

  test("non-Error rejections are categorised too", () => {
    expect(categorizeError("Worker error")).toBe("worker_failure");
  });

  // Text no rule knows still says which step of the task failed (KOF-311).
  test.each([
    ["geometry_reload", "tessellation_failure"],
    ["meshing", "mesher_failure"],
    ["shell_idealisation", "shell_idealisation_failure"],
  ])("an unrecognised failure in step %s is %s", (stage, category) => {
    const err = new WorkerTaskError(
      "Standard_Failure: BRep_API: command not done",
      stage,
    );
    expect(categorizeError(err)).toBe(category);
  });

  test("a recognised message wins over the step it failed in", () => {
    const err = new WorkerTaskError(
      "std::bad_alloc: std::bad_alloc",
      "meshing",
    );
    expect(categorizeError(err)).toBe("resource_limit");
  });

  test("without a step, unrecognised text stays unknown", () => {
    const err = new WorkerTaskError(
      "Standard_Failure: BRep_API: command not done",
      null,
    );
    expect(categorizeError(err)).toBe("unknown");
  });

  test("model type from element types", () => {
    expect(modelType([{ type: "CTETRA" }])).toBe("solid");
    expect(modelType([{ type: "CTRIA3" }])).toBe("shell");
    expect(modelType([{ type: "CTRIA3" }, { type: "CTETRA" }])).toBe("mixed");
  });
});
