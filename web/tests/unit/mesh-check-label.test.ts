// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The mesh row of the Solve and Optimize pre-flight checks (KOF-466).

import { expect, test } from "bun:test";
import { meshCheckLabel } from "../../src/lib/modelDisplay";

test("no mesh yet says so, instead of a ready mesh of 0 nodes", () => {
  expect(meshCheckLabel(0, 0, null)).toBe("No mesh");
});

test("a mesh gives its node and element counts", () => {
  expect(meshCheckLabel(12, 5, null)).toBe(
    "Mesh ready · 12 nodes · 5 elements",
  );
});

test("a mesh made before a body was suppressed shows why it is stale", () => {
  expect(meshCheckLabel(12, 5, "Remesh: body 2 was suppressed")).toBe(
    "Remesh: body 2 was suppressed",
  );
});
