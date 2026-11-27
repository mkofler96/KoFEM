// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KOF-490: a failed solve is sent with a category, and a numerical failure
// with the sub-reason the solver knows; the user reads what to change. Every
// FemError the Rust module can raise has a deliberate category, so none ends
// as "unknown" or in the solver_failure catch-all by accident.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  categorizeError,
  classifyFailure,
  NUMERICAL_REASONS,
  resetAnalyticsForTests,
  track,
  type FailureClass,
  type NumericalReason,
} from "../../src/lib/analytics.ts";
import {
  failureAdvice,
  withAdvice,
} from "../../src/lib/solve/failureAdvice.ts";
import { WorkerTaskError } from "../../src/lib/workerError.ts";
import { WorkerCrashError } from "../../src/workers/sharedWorker.ts";
import { tr, useLocaleStore } from "../../src/i18n/useLocale.ts";
import { solveMessages } from "../../src/i18n/messages/solve.ts";

// What the worker sends for a failure in the solve step.
const solving = (english: string) =>
  new WorkerTaskError(english, "solving", english);

describe("numerical failures carry the sub-reason the solver knows", () => {
  test.each<[string, NumericalReason]>([
    // FemError::NotPositiveDefinite, a CG breakdown.
    [
      "Error: the stiffness matrix is not positive definite (CG breakdown at iteration 115) — the model is probably not fully constrained",
      "singular_matrix",
    ],
    // FemError::CoarseNotPositiveDefinite, the AMG coarsest level.
    [
      "Error: the coarsest multigrid matrix (315 unknowns) is not positive definite — the model is probably not fully constrained",
      "singular_matrix",
    ],
    ["shell: singular 3×3 matrix", "singular_matrix"],
    // FemError::NotConverged, and the app's stalled-CG message (cgRun.ts).
    [
      "Error: CG did not converge: relative residual 3.2e-3 after 5000 iterations (target 1e-6)",
      "not_converged",
    ],
    [
      "Error: CG did not converge: relative residual 3.827e+0 after 1 iterations (target 1e-6) and is no longer improving. The partial result was discarded — check that the model is fully constrained, or refine the mesh.",
      "not_converged",
    ],
    // FemError::TangentSolve: the linear solve inside a Newton iteration.
    [
      "Error: Newton increment 2, iteration 4: the tangent solve failed: multigrid setup input is invalid: empty",
      "not_converged",
    ],
    // FemError::NewtonNotConverged.
    [
      "Error: Newton increment 1 of 1 did not converge: relative residual 1.72e-1 after 30 iterations (target 1e-6)",
      "newton_not_converged",
    ],
    // FemError::TangentNotPositiveDefinite.
    [
      "Error: Newton increment 3 of 4 (load factor 0.75): the tangent stiffness is not positive definite — the model loses stability (it buckles or snaps through) at or below this load, so a static solve cannot follow it further",
      "unstable_tangent",
    ],
    // FemError::InvertedElement.
    [
      "Error: element 0 is turned inside out (volume ratio J = -2.8e4): the deformation is too large for one load increment, or for the element — try more load increments",
      "inverted_element",
    ],
    // FemError::NonFiniteStress, and a non-finite internal force in Newton.
    [
      "Error: triangle 0: the recovered stress is NaN, not a finite number — the displacements it was recovered from are not finite or overflow",
      "non_finite_result",
    ],
    [
      "Error: a non-finite value (NaN) was given for an internal force component",
      "non_finite_result",
    ],
  ])("%p is numerical_failure / %s", (english, reason) => {
    expect(classifyFailure(solving(english))).toEqual({
      error_category: "numerical_failure",
      numerical_reason: reason,
    });
    expect(categorizeError(solving(english))).toBe("numerical_failure");
  });

  test("a failure that is not numerical carries no sub-reason", () => {
    expect(
      classifyFailure(
        solving("Error: the mesh has 9 nodes; at most 4 are supported"),
      ),
    ).toEqual({ error_category: "resource_limit" });
  });

  test("the rigid-body check's own input errors are not a numerical failure", () => {
    expect(
      categorizeError(
        solving(
          "Error: rigid-body check: offsets do not describe the node array",
        ),
      ),
    ).toBe("solver_failure");
  });

  // The rules read English: a German message is classified by the English
  // the worker sent along with it.
  test("a translated message keeps its sub-reason", () => {
    useLocaleStore.setState({ locale: "de" });
    try {
      const message = tr(solveMessages).cgNotConverged("1.0e-1", 3, "1e-6");
      expect(message).not.toContain("did not converge");
      expect(classifyFailure(new Error(message))).toEqual({
        error_category: "numerical_failure",
        numerical_reason: "not_converged",
      });
    } finally {
      useLocaleStore.setState({ locale: "en" });
    }
  });
});

// Every FemError variant, by name, with the category its message must get.
// solver_failure is for errors a malformed payload of the app raises, a bug
// in KoFEM rather than in the visitor's model; the user can change nothing.
const FEM_ERROR_CATEGORY: Record<string, FailureClass> = {
  VertexArrayLength: { error_category: "solver_failure" },
  TetArrayLength: { error_category: "solver_failure" },
  VertexOutOfRange: { error_category: "solver_failure" },
  DegenerateTet: { error_category: "degenerate_element" },
  MaterialIdCount: { error_category: "solver_failure" },
  MaterialOutOfRange: { error_category: "solver_failure" },
  HexArrayLength: { error_category: "solver_failure" },
  HexVertexOutOfRange: { error_category: "solver_failure" },
  DegenerateHex: { error_category: "degenerate_element" },
  HexMaterialOutOfRange: { error_category: "solver_failure" },
  YoungsModulus: { error_category: "invalid_input" },
  PoissonRatio: { error_category: "invalid_input" },
  TooManyNodes: { error_category: "resource_limit" },
  EmptyMesh: { error_category: "invalid_input" },
  ConnectivityLength: { error_category: "solver_failure" },
  ReactionInput: { error_category: "solver_failure" },
  ReportField: { error_category: "solver_failure" },
  ReducedSystem: { error_category: "solver_failure" },
  DofOutOfRange: { error_category: "solver_failure" },
  ConflictingConstraint: { error_category: "invalid_input" },
  ConstraintOnUnusedVertex: { error_category: "invalid_input" },
  LoadOnUnusedVertex: { error_category: "invalid_input" },
  ConstraintValueCount: { error_category: "solver_failure" },
  ForceLength: { error_category: "solver_failure" },
  NonFinite: { error_category: "invalid_input" },
  NotPositiveDefinite: {
    error_category: "numerical_failure",
    numerical_reason: "singular_matrix",
  },
  NotConverged: {
    error_category: "numerical_failure",
    numerical_reason: "not_converged",
  },
  InvalidSettings: { error_category: "invalid_input" },
  SurfaceLoadUnmatched: { error_category: "invalid_input" },
  SurfaceLoadArea: { error_category: "invalid_input" },
  NonFiniteStress: {
    error_category: "numerical_failure",
    numerical_reason: "non_finite_result",
  },
  DisplacementLength: { error_category: "solver_failure" },
  AmgInput: { error_category: "invalid_input" },
  CoarseNotPositiveDefinite: {
    error_category: "numerical_failure",
    numerical_reason: "singular_matrix",
  },
  SectionInput: { error_category: "solver_failure" },
  StatisticsInput: { error_category: "solver_failure" },
  Coupling: { error_category: "invalid_input" },
  CouplingInput: { error_category: "invalid_input" },
  Tie: { error_category: "invalid_input" },
  RigidBodyInput: { error_category: "solver_failure" },
  CouplingDofConflict: { error_category: "invalid_input" },
  CouplingCycle: { error_category: "invalid_input" },
  ConstraintOnCoupledDof: { error_category: "invalid_input" },
  RotationWithoutDof: { error_category: "invalid_input" },
  LoadWithoutStiffness: { error_category: "invalid_input" },
  ShellOnQuadraticMesh: { error_category: "unsupported_model" },
  TriangleArrayLength: { error_category: "solver_failure" },
  EmptyShellMesh: { error_category: "invalid_input" },
  TriangleVertexOutOfRange: { error_category: "solver_failure" },
  DegenerateTriangle: { error_category: "degenerate_element" },
  ThicknessCount: { error_category: "solver_failure" },
  Thickness: { error_category: "invalid_input" },
  ShellMaterialIdCount: { error_category: "solver_failure" },
  ShellMaterialOutOfRange: { error_category: "solver_failure" },
  ExpansionCoefficientCount: { error_category: "solver_failure" },
  TemperatureCount: { error_category: "solver_failure" },
  ElementOutOfRange: { error_category: "solver_failure" },
  TopologyInput: { error_category: "solver_failure" },
  Convergence: { error_category: "solver_failure" },
  NewtonNotConverged: {
    error_category: "numerical_failure",
    numerical_reason: "newton_not_converged",
  },
  TangentSolve: {
    error_category: "numerical_failure",
    numerical_reason: "not_converged",
  },
  TangentNotPositiveDefinite: {
    error_category: "numerical_failure",
    numerical_reason: "unstable_tangent",
  },
  InvertedElement: {
    error_category: "numerical_failure",
    numerical_reason: "inverted_element",
  },
  NewtonUnfinished: { error_category: "solver_failure" },
  NonlinearInput: { error_category: "solver_failure" },
  Contact: { error_category: "invalid_input" },
};

// Each FemError's message as the Rust module words it, read from its
// #[error(...)] attribute with sample values for the fields: a number for
// counts and indices, NaN for a value, a short free text for a reason.
function femErrorMessages(): [string, string][] {
  const source = readFileSync(
    new URL("../../../crates/kofem-fem/src/error.rs", import.meta.url),
    "utf8",
  );
  const attribute =
    /#\[error\(\s*((?:"(?:[^"\\]|\\[\s\S])*"\s*)+)\)\]\s*(\w+)/g;
  return [...source.matchAll(attribute)].map((match) => {
    const template = [...match[1].matchAll(/"((?:[^"\\]|\\[\s\S])*)"/g)]
      .map((part) => part[1].replace(/\\\n\s*/g, ""))
      .join("");
    const message = template.replace(/\{(\w+)(?::e)?\}/g, (_, field: string) =>
      field === "reason"
        ? "the input is inconsistent"
        : field === "what"
          ? "a force component"
          : field === "value"
            ? "NaN"
            : "7",
    );
    return [match[2], `Error: ${message}`];
  });
}

describe("every FemError has a deliberate category", () => {
  const messages = femErrorMessages();

  test("the table names every variant of error.rs, and only those", () => {
    expect(messages.map(([name]) => name).sort()).toEqual(
      Object.keys(FEM_ERROR_CATEGORY).sort(),
    );
  });

  test.each(messages)("%s", (name, message) => {
    expect(classifyFailure(solving(message))).toEqual(FEM_ERROR_CATEGORY[name]);
  });
});

// A failure that reaches the page without a step: no stage fallback catches
// it, so a rule must, or it would be sent as "unknown".
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
    expect(categorizeError(new WorkerTaskError(message, null, message))).toBe(
      "worker_failure",
    );
  });

  test("a language whose text did not load is app_load_failure", () => {
    const message =
      "Error: The Deutsch text of KoFEM could not be loaded: Failed to fetch dynamically imported module";
    expect(categorizeError(new WorkerTaskError(message, null, message))).toBe(
      "app_load_failure",
    );
  });
});

describe("the solve_failed event", () => {
  const sent: { name: string; params: object }[] = [];
  const hadWindow = "window" in globalThis;
  const previousWindow = globalThis.window;
  beforeAll(() => {
    globalThis.window = Object.assign(new EventTarget(), {
      __kofemAnalyticsConsent: "granted",
      gtag: (_command: "event", name: string, params: object) =>
        sent.push({ name, params }),
    }) as unknown as Window & typeof globalThis;
  });
  afterAll(() => {
    resetAnalyticsForTests();
    if (hadWindow) globalThis.window = previousWindow;
    else Reflect.deleteProperty(globalThis, "window");
  });

  test("a numerical failure is sent with its sub-reason and nothing else", () => {
    const failure = classifyFailure(
      solving(
        "Error: the coarsest multigrid matrix (315 unknowns) is not positive definite — the model is probably not fully constrained",
      ),
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
  test.each(NUMERICAL_REASONS.map((reason) => [reason]))(
    "%s has advice of its own",
    (reason) => {
      const advice = failureAdvice({
        error_category: "numerical_failure",
        numerical_reason: reason,
      });
      expect(advice).not.toBeNull();
      const others = NUMERICAL_REASONS.filter((r) => r !== reason).map((r) =>
        failureAdvice({
          error_category: "numerical_failure",
          numerical_reason: r,
        }),
      );
      expect(others).not.toContain(advice);
    },
  );

  test("a singular matrix asks for a support or a joint over a face", () => {
    const failure: FailureClass = {
      error_category: "numerical_failure",
      numerical_reason: "singular_matrix",
    };
    expect(withAdvice(failure, "Solver error: the stiffness matrix …")).toBe(
      "Part of the model can still move freely, so the solve has no unique answer. " +
        "Look for a part joined to the rest only along an edge or at a point: " +
        "support it, or join it to the rest over a face.\n" +
        "Solver error: the stiffness matrix …",
    );
  });

  test("other failures keep the solver's words alone", () => {
    expect(
      withAdvice({ error_category: "invalid_input" }, "Solver error: x"),
    ).toBe("Solver error: x");
  });
});
