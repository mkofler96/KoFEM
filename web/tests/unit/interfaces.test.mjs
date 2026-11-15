// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for src/lib/interfaces.ts — the body-to-body interfaces of a
// multibody assembly (KOF-170), detected from which bodies own each CAD face
// of the tessellation, and the bodies left unbonded.

import { describe, expect, test } from "bun:test";
import {
  detectInterfaces,
  interfaceLabel,
  isInternalInterface,
  restoreInterfaces,
  unconnectedBodies,
} from "../../src/lib/interfaces.ts";

// A tessellation with one triangle per (face, body) entry: the engine emits a
// face shared by two solids once under each of them.
function tess(entries) {
  return {
    points: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
    triangles: entries.map(() => [0, 1, 2]),
    bodyIds: entries.map(([, body]) => body),
    faceIds: entries.map(([face]) => face),
  };
}

const bodies = (n, extra = {}) =>
  Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    materialId: 1,
    ...(extra[i + 1] ?? {}),
  }));

// Three bodies in a row: 1 and 2 share faces 7 and 9 (a split mating face),
// 2 and 3 share face 12; face 3 is body 1's own, face 15 body 3's own.
const row = tess([
  [3, 1],
  [7, 1],
  [7, 1], // a second triangle on the same face
  [9, 1],
  [7, 2],
  [9, 2],
  [12, 2],
  [12, 3],
  [15, 3],
]);
const found = detectInterfaces(row);

describe("detectInterfaces", () => {
  test("two body pairs found", () => {
    expect(found).toHaveLength(2);
  });

  test("1 ↔ 2 groups both shared faces, ascending", () => {
    expect(found[0].bodyA).toBe(1);
    expect(found[0].bodyB).toBe(2);
    expect(found[0].faceIds).toEqual([7, 9]);
  });

  test("2 ↔ 3 on face 12", () => {
    expect(found[1].bodyA).toBe(2);
    expect(found[1].bodyB).toBe(3);
    expect(found[1].faceIds).toEqual([12]);
  });

  test("ids are 1-based in pair order, all bonded", () => {
    expect(found.map((item) => item.id)).toEqual([1, 2]);
    for (const item of found) expect(item.type).toBe("bonded");
  });

  test("label names both bodies", () => {
    expect(interfaceLabel(found[0], bodies(3))).toBe("Body 1 ↔ Body 2");
  });

  test("label names the regions of a split body", () => {
    expect(
      interfaceLabel(found[0], bodies(3, { 1: { body: 1 }, 2: { body: 1 } })),
    ).toBe("Body 1 · Region 1 ↔ Body 1 · Region 2");
  });

  test("an interface inside a body is internal, one between bodies is not", () => {
    expect(isInternalInterface(found[0], bodies(3, { 2: { body: 1 } }))).toBe(
      true,
    );
    expect(isInternalInterface(found[1], bodies(3, { 2: { body: 1 } }))).toBe(
      false,
    );
  });

  test("body order in the tessellation does not matter", () => {
    expect(
      detectInterfaces(
        tess([
          [5, 2],
          [5, 1],
        ]),
      ),
    ).toEqual([{ id: 1, bodyA: 1, bodyB: 2, faceIds: [5], type: "bonded" }]);
  });

  test("no tessellation: none", () => {
    expect(detectInterfaces(null)).toHaveLength(0);
  });

  test("single body: none", () => {
    expect(
      detectInterfaces(
        tess([
          [1, 1],
          [2, 1],
        ]),
      ),
    ).toHaveLength(0);
  });

  test("saved before body ids (one body): none", () => {
    const legacyNoBodies = { ...row, bodyIds: undefined, faceIds: undefined };
    expect(detectInterfaces(legacyNoBodies)).toHaveLength(0);
  });

  test("saved before face ids: unknown (null), not none", () => {
    expect(detectInterfaces({ ...row, faceIds: undefined })).toBeNull();
  });

  test("a face owned by three bodies is refused", () => {
    expect(() =>
      detectInterfaces(
        tess([
          [4, 1],
          [4, 2],
          [4, 3],
        ]),
      ),
    ).toThrow(/face 4 is owned by 3 bodies/);
  });

  test("misaligned id arrays are refused", () => {
    expect(() => detectInterfaces({ ...row, faceIds: [1] })).toThrow(
      /9 triangles but 9 body ids and 1 face ids/,
    );
  });
});

describe("unconnectedBodies", () => {
  // Body 4 touches nothing.
  const withLoose = detectInterfaces(
    tess([
      [7, 1],
      [7, 2],
      [12, 2],
      [12, 3],
      [20, 4],
    ]),
  );

  test("a body with no interface is flagged", () => {
    expect(unconnectedBodies(withLoose, bodies(4))).toEqual([4]);
  });

  test("suppressing its only partner leaves a body unbonded", () => {
    expect(
      unconnectedBodies(withLoose, bodies(4, { 2: { suppressed: true } })),
    ).toEqual([1, 3, 4]);
  });

  test("a suppressed body is not flagged itself", () => {
    expect(
      unconnectedBodies(withLoose, bodies(4, { 4: { suppressed: true } })),
    ).toEqual([]);
  });

  test("one body left in the model: nothing to bond to, no flag", () => {
    expect(unconnectedBodies([], bodies(1))).toHaveLength(0);
  });

  test("interfaces unknown: no flag", () => {
    expect(unconnectedBodies(null, bodies(3))).toHaveLength(0);
  });

  test("regions bonded only to each other leave their body unbonded", () => {
    expect(
      unconnectedBodies(
        withLoose,
        bodies(4, { 2: { body: 1 }, 3: { body: 3 } }),
      ),
    ).toEqual([4]);
    expect(
      unconnectedBodies(
        withLoose,
        bodies(4, { 2: { body: 1 }, 3: { body: 1 }, 4: { body: 4 } }),
      ),
    ).toEqual([1, 2, 3, 4]);
  });

  test("a derived shell section is not a body", () => {
    expect(
      unconnectedBodies(found, [
        ...bodies(3),
        { id: 4, materialId: 1, sourceBodyId: 2 },
      ]),
    ).toHaveLength(0);
  });
});

describe("restoreInterfaces", () => {
  // A file written before interfaces existed has no "interfaces" entry.
  const savedBeforeInterfaces = undefined;

  test("files before interfaces: re-detected", () => {
    expect(restoreInterfaces(row, savedBeforeInterfaces)).toEqual(found);
  });

  test("a matching saved list round-trips", () => {
    expect(restoreInterfaces(row, found)).toEqual(found);
  });

  test("a list that disagrees with the geometry is refused", () => {
    expect(() =>
      restoreInterfaces(row, [found[0], { ...found[1], faceIds: [13] }]),
    ).toThrow(/interface 2 does not match the geometry/);
  });

  test("a missing interface is refused", () => {
    expect(() => restoreInterfaces(row, [found[0]])).toThrow(
      /lists 1 interface\(s\), but its geometry has 2/,
    );
  });

  test("an unknown type is refused", () => {
    expect(() =>
      restoreInterfaces(row, [found[0], { ...found[1], type: "glued" }]),
    ).toThrow(/unknown type "glued"/);
  });

  test("interfaces without face ids to check them against are refused", () => {
    expect(() =>
      restoreInterfaces({ ...row, faceIds: undefined }, found),
    ).toThrow(/no CAD face ids/);
  });
});
