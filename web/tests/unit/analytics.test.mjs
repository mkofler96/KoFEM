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
  setWorkflow,
  track,
  trackOnce,
  trackSolveCompleted,
  workflowParams,
} from "../../src/lib/analytics.ts";
import {
  shellCouplingRefusal,
  shellOrderRefusal,
  shellTieRefusal,
  solidModelRefusal,
  topOptTieRefusal,
} from "../../src/lib/solve/refusals.ts";
import { WorkerTaskError } from "../../src/lib/workerError.ts";
import { tr, useLocaleStore } from "../../src/i18n/useLocale.ts";
import { solveMessages } from "../../src/i18n/messages/solve.ts";

// A window with just what the loader and the utility touch.
const sent = [];
const win = new EventTarget();
// The tab's sessionStorage: emptied for a new tab, kept across a reload.
const tabStorage = new Map();
win.sessionStorage = {
  getItem: (key) => (tabStorage.has(key) ? tabStorage.get(key) : null),
  setItem: (key, value) => tabStorage.set(key, String(value)),
};
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
  tabStorage.clear();
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

describe("first solve of a session", () => {
  const solved = {
    workflow: "example",
    example_id: "axial-bar",
    analysis_type: "static",
    duration_bucket: "lt_1s",
  };
  const names = () => sent.map((event) => event.name);

  test("the first solve sends solve_completed and first_solve_completed", () => {
    fresh("granted");
    trackSolveCompleted(solved);
    expect(names()).toEqual(["solve_completed", "first_solve_completed"]);
    expect(sent[1].params).toEqual(sent[0].params);
  });

  test("a second and third solve send solve_completed only", () => {
    fresh("granted");
    trackSolveCompleted(solved);
    trackSolveCompleted({ ...solved, analysis_type: "topology" });
    trackSolveCompleted(solved);
    expect(names()).toEqual([
      "solve_completed",
      "first_solve_completed",
      "solve_completed",
      "solve_completed",
    ]);
  });

  test("a reload in the same tab is the same session", () => {
    fresh("granted");
    trackSolveCompleted(solved);
    resetAnalyticsForTests();
    sent.length = 0;
    trackSolveCompleted(solved);
    expect(names()).toEqual(["solve_completed"]);
  });

  test("a new tab is a new session", () => {
    fresh("granted");
    trackSolveCompleted(solved);
    fresh("granted");
    trackSolveCompleted(solved);
    expect(names()).toEqual(["solve_completed", "first_solve_completed"]);
  });

  test("without consent neither event is sent and nothing is stored", () => {
    fresh("denied");
    trackSolveCompleted(solved);
    trackSolveCompleted(solved);
    expect(sent).toHaveLength(0);
    expect(tabStorage.size).toBe(0);
  });

  test("declined, then accepted in the same tab: the next solve is the first sent", () => {
    fresh(undefined);
    trackSolveCompleted(solved);
    setConsent("denied");
    expect(tabStorage.size).toBe(0);
    setConsent("granted");
    trackSolveCompleted(solved);
    expect(names()).toEqual(["solve_completed", "first_solve_completed"]);
  });

  test("without sessionStorage the key event is withheld, not repeated", () => {
    fresh("granted");
    const storage = win.sessionStorage;
    const errors = [];
    const original = console.error;
    win.sessionStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
    };
    console.error = (message) => errors.push(message);
    try {
      trackSolveCompleted(solved);
    } finally {
      win.sessionStorage = storage;
      console.error = original;
    }
    expect(names()).toEqual(["solve_completed"]);
    expect(errors).toHaveLength(1);
  });

  test("pending: solves while the banner waits queue one first solve", () => {
    fresh(undefined);
    trackSolveCompleted(solved);
    trackSolveCompleted(solved);
    expect(sent).toHaveLength(0);
    expect(tabStorage.size).toBe(0);
    setConsent("granted");
    trackSolveCompleted(solved);
    expect(names()).toEqual([
      "solve_completed",
      "first_solve_completed",
      "solve_completed",
      "solve_completed",
    ]);
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
    // The file claims to be STEP or IGES, but the reader rejects it (KOF-347).
    [
      "std::runtime_error: STEPControl_Reader::ReadFile failed — invalid STEP file",
      "parse_error",
    ],
    ["IGESControl_Reader::ReadFile failed — invalid IGES file", "parse_error"],
    // The file reads, but holds nothing to show or mesh.
    [
      "std::runtime_error: STEP file contains no transferable shapes",
      "empty_geometry",
    ],
    [
      "IGES file contains no transferable shapes. IGES often stores only free surfaces; a closed solid is required for volume meshing.",
      "empty_geometry",
    ],
    [
      "CAD file contains no geometry with a measurable extent (empty bounding box)",
      "empty_geometry",
    ],
    ["No geometry found.", "empty_geometry"],
    // A STEP of only a tessellated mesh has no CAD solid to mesh (KOF-361).
    [
      "std::runtime_error: This STEP file contains only a tessellated mesh, no CAD solid. Re-export it with exact (BRep) geometry.",
      "empty_geometry",
    ],
    // Bodies of an assembly overlap, so they cannot be bonded on import.
    [
      "BOPAlgo_MakeConnected failed to imprint the assembly's touching faces — the bodies cannot be bonded for meshing. Check the CAD model for overlapping (interpenetrating) solids and re-export.",
      "geometry_defect",
    ],
    [
      "BOPAlgo_MakeConnected produced no solids from a multibody assembly — the imported geometry is inconsistent",
      "geometry_defect",
    ],
    // The browser could not read the picked file (moved, or a cloud placeholder).
    [
      "NotReadableError: The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.",
      "file_unreadable",
    ],
    [
      "NotFoundError: A requested file or directory could not be found at the time an operation was processed.",
      "file_unreadable",
    ],
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
    ["mixed solve: the model has no shell element", "invalid_input"],
    // Stopping at the CG prompt ends the solve on purpose (KOF-418).
    ["Solve stopped by user. The partial result was discarded.", "cancelled"],
    // A solve path that does not take the model refuses it by name (KOF-418).
    [
      "Topology optimization: the level-set method supports solid models only, but this model has 12 shell (CTRIA3) element(s) — use SIMP for shell and coupled models.",
      "unsupported_model",
    ],
    [
      "Topology optimization: the level-set method does not support couplings yet, but this model has 1 — remove them or use SIMP.",
      "unsupported_model",
    ],
    [
      'Bodies 1, 2 are all marked "Shell", but one body per model can be idealised as shells today. Keep one of them Shell and set the others to Solid.',
      "unsupported_model",
    ],
    [
      'Body 1 is marked "Shell", but the mesh has 40 hexahedral element(s), and shell idealisation works on tetrahedral meshes only. Mesh with tetrahedra, or set the body to Solid.',
      "unsupported_model",
    ],
    [
      'Shell idealisation failed: body 1 is marked "Shell" but no thin walls were found in it. Switch it to Solid, or check that it is genuinely thin-walled.',
      "shell_idealisation_failure",
    ],
    // The rigid-body check refuses a loose body before the solve (KOF-388).
    [
      "Body 2 can still move along X and rotate about Z. Add a support or connect it to another body.",
      "unheld_body",
    ],
    [
      "Bodies 1 and 3 can still rotate about (0.71, 0.71, 0). Add supports or connect them to other bodies.",
      "unheld_body",
    ],
    // A body only contact holds that its load lifts off (KOF-501).
    [
      "Body 1 is held only by contact, which cannot stop it: its load would make it move along Z.",
      "unheld_body",
    ],
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
    ["geometry_import", "import_failure"],
    // A Rust solver or optimizer error no rule knows (KOF-418).
    ["solving", "solver_failure"],
  ])("an unrecognised failure in step %s is %s", (stage, category) => {
    const err = new WorkerTaskError(
      "Standard_Failure: BRep_API: command not done",
      stage,
      "Standard_Failure: BRep_API: command not done",
      null,
    );
    expect(categorizeError(err)).toBe(category);
  });

  // Every refusal a solve path raises is a model it does not take yet, not an
  // unknown failure (KOF-418).
  test.each([
    ["tie", shellTieRefusal([{ name: "Tie1" }])],
    ["topology tie", topOptTieRefusal([{ name: "Tie1" }, { name: "Pin" }])],
    ["element order", shellOrderRefusal(2)],
    ["shell coupling", shellCouplingRefusal(1)],
    [
      "solid model",
      solidModelRefusal("it supports tetrahedral and hexahedral meshes only"),
    ],
    [
      "solid model, shells",
      solidModelRefusal("it does not support shell-only models"),
    ],
  ])("the %s refusal is unsupported_model", (_name, message) => {
    expect(
      categorizeError(new WorkerTaskError(message, "solving", message, null)),
    ).toBe("unsupported_model");
  });

  // The rules read English (KOF-468). An error a user reads in German is
  // categorised by the English it was translated from.
  describe("in another language", () => {
    beforeAll(() => useLocaleStore.setState({ locale: "de" }));
    afterAll(() => useLocaleStore.setState({ locale: "en" }));

    test("a translated refusal is unsupported_model", () => {
      const refusal = shellTieRefusal([{ name: "Tie1" }]);
      expect(refusal).not.toContain("does not support");
      expect(categorizeError(new Error(refusal))).toBe("unsupported_model");
    });

    test("a translated fixed message keeps its category", () => {
      expect(categorizeError(new Error(tr(solveMessages).stoppedByUser))).toBe(
        "cancelled",
      );
      expect(categorizeError(new Error(tr(solveMessages).outOfMemory))).toBe(
        "resource_limit",
      );
    });

    test("a worker failure is categorised by the English the worker sent", () => {
      const err = new WorkerTaskError(
        "Der Speicher ist voll",
        "solving",
        "The solver ran out of memory.",
        null,
      );
      expect(categorizeError(err)).toBe("resource_limit");
    });
  });

  test("a recognised message wins over the step it failed in", () => {
    const err = new WorkerTaskError(
      "std::bad_alloc: std::bad_alloc",
      "meshing",
      "std::bad_alloc: std::bad_alloc",
      null,
    );
    expect(categorizeError(err)).toBe("resource_limit");
  });

  test("without a step, unrecognised text stays unknown", () => {
    const err = new WorkerTaskError(
      "Standard_Failure: BRep_API: command not done",
      null,
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

// Mesh and solve events name the example they ran on, so a failing example can
// be found (KOF-418). A CAD import or a saved file has no example id to send.
describe("workflow parameters", () => {
  test("an example's workflow carries its id", () => {
    fresh("granted");
    setWorkflow("example", "wall-bracket");
    expect(workflowParams()).toEqual({
      workflow: "example",
      example_id: "wall-bracket",
    });
  });

  test("a later CAD import drops the example id", () => {
    fresh("granted");
    setWorkflow("example", "wall-bracket");
    setWorkflow("cad_import");
    expect(workflowParams()).toEqual({ workflow: "cad_import" });
  });

  test("a mesh failure on an example reaches gtag with the example id", () => {
    fresh("granted");
    setWorkflow("example", "plate-with-hole");
    track("mesh_failed", {
      ...workflowParams(),
      model_type: "solid",
      duration_bucket: "5_15s",
      error_category: "engine_crash",
    });
    expect(sent.at(-1)?.params).toEqual({
      workflow: "example",
      example_id: "plate-with-hole",
      model_type: "solid",
      duration_bucket: "5_15s",
      error_category: "engine_crash",
    });
  });

  test("the example workflow without an id is refused", () => {
    fresh("granted");
    expect(() => setWorkflow("example", "")).toThrow(/example id/);
  });
});
