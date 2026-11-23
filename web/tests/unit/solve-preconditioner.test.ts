// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The preconditioner a solve uses for the method the user chose, and the note
// that says so when the two differ (KOF-461). Every path with shell facets
// solves with incomplete Cholesky unless AMG takes the model; a Gauss–Seidel
// request there must be told, as an AMG request already is.

import { describe, expect, test } from "bun:test";
import type { Element } from "../../src/workers/solverTypes";
import {
  preconditionerNotice,
  solvePreconditioner,
} from "../../src/lib/solve/amg";

const tet: Element = {
  id: 1,
  type: "CTETRA",
  nodeIds: [1, 2, 3, 4],
  propertyId: 1,
};
const facet: Element = {
  id: 2,
  type: "CTRIA3",
  nodeIds: [1, 2, 3],
  propertyId: 2,
};
const shellsOnly = { path: "shell" } as const;
const autoShell = { path: "auto-shell", shellBodyIds: new Set([1]) } as const;
const coupled = { path: "coupled" } as const;
const solid = { path: "solid" } as const;

describe("solvePreconditioner", () => {
  test("an all-solid model solves with the chosen method", () => {
    expect(solvePreconditioner("gauss-seidel", solid, null, [tet])).toBe(
      "gauss-seidel",
    );
    expect(solvePreconditioner("amg", solid, null, [tet])).toBe("amg");
  });

  test("an all-solid coupled model solves with the chosen method", () => {
    expect(solvePreconditioner("gauss-seidel", coupled, null, [tet])).toBe(
      "gauss-seidel",
    );
  });

  test("Gauss–Seidel on a model with shells solves with incomplete Cholesky", () => {
    const shellReason = "it does not support shell-only models";
    expect(
      solvePreconditioner("gauss-seidel", shellsOnly, shellReason, [facet]),
    ).toBe("incomplete-cholesky");
    expect(
      solvePreconditioner("gauss-seidel", coupled, null, [tet, facet]),
    ).toBe("incomplete-cholesky");
    expect(
      solvePreconditioner(
        "gauss-seidel",
        autoShell,
        "it does not support bodies solved as shells",
        [tet],
      ),
    ).toBe("incomplete-cholesky");
  });

  test("AMG on shells mixed with tets solves with AMG when it takes them", () => {
    expect(solvePreconditioner("amg", coupled, null, [tet, facet])).toBe("amg");
  });

  test("AMG that cannot take a model with shells gives way to incomplete Cholesky", () => {
    expect(
      solvePreconditioner(
        "amg",
        autoShell,
        "it does not support bodies solved as shells",
        [tet],
      ),
    ).toBe("incomplete-cholesky");
  });
});

describe("preconditionerNotice", () => {
  test("says nothing when the chosen method is used", () => {
    expect(preconditionerNotice("gauss-seidel", "gauss-seidel", null)).toBe(
      null,
    );
  });

  test("names why AMG is not used and what is", () => {
    expect(
      preconditionerNotice(
        "amg",
        "incomplete-cholesky",
        "it does not support bodies solved as shells",
      ),
    ).toBe(
      "AMG is not available for this model (it does not support bodies solved as shells). It will solve with an incomplete Cholesky preconditioner.",
    );
  });

  test("names why Gauss–Seidel is not used and what is", () => {
    expect(
      preconditionerNotice("gauss-seidel", "incomplete-cholesky", null),
    ).toBe(
      "Gauss–Seidel is not available for this model (it does not support shells). It will solve with an incomplete Cholesky preconditioner.",
    );
  });
});
