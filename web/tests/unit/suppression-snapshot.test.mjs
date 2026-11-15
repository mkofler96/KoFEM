// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// bodiesLeftOutOfMesh (src/lib/suppressBodies.ts): which CAD bodies a saved
// mesh leaves out, read from the mesh rather than from the suppression flags,
// which may have changed after meshing.

import { describe, expect, test } from "bun:test";
import { bodiesLeftOutOfMesh } from "../../src/lib/suppressBodies.ts";

const els = (...propertyIds) =>
  propertyIds.map((propertyId) => ({ propertyId }));

describe("bodiesLeftOutOfMesh", () => {
  test("every body meshed → nothing left out", () => {
    expect(bodiesLeftOutOfMesh([{ id: 1 }, { id: 2 }], els(1, 1, 2))).toEqual(
      [],
    );
  });

  test("a body with no elements was left out, whatever its flag says", () => {
    expect(
      bodiesLeftOutOfMesh([{ id: 1 }, { id: 2, suppressed: false }], els(1, 1)),
    ).toEqual([2]);
  });

  test("a body suppressed after meshing is still in the mesh", () => {
    expect(
      bodiesLeftOutOfMesh([{ id: 1 }, { id: 2, suppressed: true }], els(1, 2)),
    ).toEqual([]);
  });

  test("a Shell body meshed only through its derived PSHELL counts as meshed", () => {
    expect(
      bodiesLeftOutOfMesh(
        [{ id: 1 }, { id: 2 }, { id: 3, sourceBodyId: 2 }],
        els(1, 3, 3),
      ),
    ).toEqual([]);
  });

  test("a derived PSHELL is never reported as a left-out body", () => {
    expect(
      bodiesLeftOutOfMesh([{ id: 1 }, { id: 3, sourceBodyId: 2 }], els(1)),
    ).toEqual([]);
  });

  test("an element without a propertyId is an error", () => {
    expect(() => bodiesLeftOutOfMesh([{ id: 1 }], [{}])).toThrow(
      /no propertyId/,
    );
  });
});
