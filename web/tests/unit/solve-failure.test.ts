// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KOF-490: a failed solve is sent with a category, and a numerical failure
// with its reason, from the class the Rust module sets on a FemError
// (crates/kofem-fem/src/failure_class.rs). Failures that reach the page
// without a step have a category too, and the user reads what to change.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  categorizeError,
  classifyFailure,
  NUMERICAL_REASONS,
  resetAnalyticsForTests,
  track,
  type FailureClass,
} from "../../src/lib/analytics.ts";
import { failureNotice } from "../../src/lib/solve/failureAdvice.ts";
import {
  ClassifiedError,
  rustFailureClass,
  WorkerCrashError,
  WorkerTaskError,
  type RustFailureClass,
} from "../../src/lib/workerError.ts";

// A failure of the solve step as the worker sends it.
const solving = (message: string, rust: RustFailureClass | null) =>
  new WorkerTaskError(message, "solving", message, rust);

describe("the Rust module's class decides the category", () => {
  test.each<[RustFailureClass, FailureClass]>([
    [
      { category: "numerical", reason: "singular_matrix" },
      {
        error_category: "numerical_failure",
        numerical_reason: "singular_matrix",
      },
    ],
    [
      { category: "numerical", reason: "unstable_tangent" },
      {
        error_category: "numerical_failure",
        numerical_reason: "unstable_tangent",
      },
    ],
    [
      { category: "invalid_input", reason: null },
      { error_category: "invalid_input" },
    ],
    [
      { category: "degenerate_element", reason: null },
      { error_category: "degenerate_element" },
    ],
    [
      { category: "resource_limit", reason: null },
      { error_category: "resource_limit" },
    ],
    [
      { category: "unsupported_model", reason: null },
      { error_category: "unsupported_model" },
    ],
    // A malformed payload from the app.
    [
      { category: "internal", reason: null },
      { error_category: "solver_failure" },
    ],
  ])("%p is %p", (rust, expected) => {
    expect(classifyFailure(solving("Error: any words", rust))).toEqual(
      expected,
    );
  });

  test("the class wins over words a text rule would match", () => {
    expect(
      categorizeError(
        solving("Error: Young's modulus must be positive", {
          category: "numerical",
          reason: "non_finite_result",
        }),
      ),
    ).toBe("numerical_failure");
  });

  test("an error thrown on the page carries its class too", () => {
    const err = new ClassifiedError("CG did not converge", {
      category: "numerical",
      reason: "not_converged",
    });
    expect(rustFailureClass(err)).toEqual({
      category: "numerical",
      reason: "not_converged",
    });
    expect(classifyFailure(err)).toEqual({
      error_category: "numerical_failure",
      numerical_reason: "not_converged",
    });
  });

  test("a class the page does not know is reported, and unknown", () => {
    const logged = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(
        classifyFailure(
          solving("Error: x", { category: "numerical", reason: "melted" }),
        ),
      ).toEqual({ error_category: "unknown" });
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });

  test("a failure class that is not text is refused", () => {
    const err = Object.assign(new Error("x"), { failureClass: 3 });
    expect(() => rustFailureClass(err)).toThrow(/not text/);
  });
});

// No stage fallback catches these, so without a category they were "unknown".
describe("failures outside the solve step have a category", () => {
  test("the worker dying mid-solve is worker_failure", () => {
    const err = new WorkerCrashError(
      "Uncaught TypeError: Cannot read properties of undefined (reading 'length')",
    );
    expect(categorizeError(err)).toBe("worker_failure");
  });

  test("a worker that dies of memory is still resource_limit", () => {
    const err = new WorkerCrashError(
      "Uncaught RangeError: Array buffer allocation failed",
    );
    expect(categorizeError(err)).toBe("resource_limit");
  });

  test("a request the busy worker refuses is worker_failure", () => {
    const message = "Error: The solver worker is busy with another operation";
    expect(
      categorizeError(new WorkerTaskError(message, null, message, null)),
    ).toBe("worker_failure");
  });

  test("a language whose text did not load is app_load_failure", () => {
    const message =
      "Error: The Deutsch text of KoFEM could not be loaded: Failed to fetch dynamically imported module";
    expect(
      categorizeError(new WorkerTaskError(message, null, message, null)),
    ).toBe("app_load_failure");
  });
});

describe("the solve_failed event", () => {
  const sent: { name: string; params: object }[] = [];
  const hadWindow = "window" in globalThis;
  const previousWindow = globalThis.window;
  beforeAll(() => {
    Reflect.set(
      globalThis,
      "window",
      Object.assign(new EventTarget(), {
        __kofemAnalyticsConsent: "granted",
        gtag: (_command: "event", name: string, params: object) =>
          sent.push({ name, params }),
      }),
    );
  });
  afterAll(() => {
    resetAnalyticsForTests();
    if (hadWindow) Reflect.set(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });

  test("a numerical failure is sent with its reason and nothing else", () => {
    const failure = classifyFailure(
      solving("Error: the coarsest multigrid matrix is not positive definite", {
        category: "numerical",
        reason: "singular_matrix",
      }),
    );
    track("solve_failed", {
      workflow: "cad_import",
      analysis_type: "static",
      duration_bucket: "lt_1s",
      ...failure,
    });
    expect(sent.at(-1)).toEqual({
      name: "solve_failed",
      params: {
        workflow: "cad_import",
        analysis_type: "static",
        duration_bucket: "lt_1s",
        error_category: "numerical_failure",
        numerical_reason: "singular_matrix",
      },
    });
  });
});

describe("the user reads what to change", () => {
  const adviceFor = (reason: (typeof NUMERICAL_REASONS)[number]) =>
    failureNotice(
      { error_category: "numerical_failure", numerical_reason: reason },
      "Solver error: …",
    ).advice;

  test("each reason has advice of its own", () => {
    const advice = NUMERICAL_REASONS.map(adviceFor);
    expect(advice).not.toContain(null);
    expect(new Set(advice).size).toBe(NUMERICAL_REASONS.length);
  });

  test("a singular matrix asks to hold every part", () => {
    expect(
      failureNotice(
        {
          error_category: "numerical_failure",
          numerical_reason: "singular_matrix",
        },
        "Solver error: the stiffness matrix …",
      ),
    ).toEqual({
      advice:
        "Hold every part: support it, or join it to the rest over a face, not only at an edge or a point.",
      detail: "Solver error: the stiffness matrix …",
    });
  });

  test("other failures keep the solver's words alone", () => {
    expect(
      failureNotice({ error_category: "invalid_input" }, "Solver error: x"),
    ).toEqual({ advice: null, detail: "Solver error: x" });
  });
});
