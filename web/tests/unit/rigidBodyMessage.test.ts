// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The words of the rigid-body check (KOF-388): which body is loose and how it
// can still move, from the free motions the Rust check reports.

import { describe, expect, test } from "bun:test";
import {
  freeMotionMessage,
  type LooseComponent,
} from "../../src/lib/solve/rigidBody";

const ALONG_X: [number, number, number] = [1, 0, 0];
const ALONG_Y: [number, number, number] = [0, 1, 0];
const ALONG_Z: [number, number, number] = [0, 0, 1];

const loose = (
  labels: number[],
  translations: [number, number, number][],
  rotationAxes: [number, number, number][],
): LooseComponent => ({ labels, translations, rotationAxes });

const bodies = [
  { id: 1, materialId: 1 },
  { id: 2, materialId: 1 },
  { id: 3, materialId: 1 },
];

describe("freeMotionMessage", () => {
  test("is null when nothing is loose", () => {
    expect(freeMotionMessage([], bodies)).toBeNull();
  });

  test("names the body and the free motion, as in the issue", () => {
    expect(freeMotionMessage([loose([2], [ALONG_X], [ALONG_Z])], bodies)).toBe(
      "Body 2 can still move along X and rotate about Z. " +
        "Add a support or connect it to another body.",
    );
  });

  test("lists several axes and separates the clauses", () => {
    expect(
      freeMotionMessage([loose([1], [ALONG_X, ALONG_Y], [ALONG_Z])], bodies),
    ).toBe(
      "Body 1 can still move along X and Y, and rotate about Z. " +
        "Add a support or connect it to another body.",
    );
  });

  test("states a direction off the axes by its components", () => {
    const diagonal: [number, number, number] = [Math.SQRT1_2, Math.SQRT1_2, 0];
    expect(freeMotionMessage([loose([1], [], [diagonal])], bodies)).toBe(
      "Body 1 can still rotate about (0.71, 0.71, 0). " +
        "Add a support or connect it to another body.",
    );
  });

  test("names bodies joined to each other together", () => {
    expect(freeMotionMessage([loose([1, 3], [ALONG_Z], [])], bodies)).toBe(
      "Bodies 1 and 3 can still move along Z. " +
        "Add supports or connect them to other bodies.",
    );
  });

  test("gives one sentence per loose group and advice for all of them", () => {
    expect(
      freeMotionMessage(
        [loose([1], [ALONG_X], []), loose([2], [], [ALONG_Y])],
        bodies,
      ),
    ).toBe(
      "Body 1 can still move along X. Body 2 can still rotate about Y. " +
        "Add supports or connect them to other bodies.",
    );
  });

  test("names pieces that can make the same motion in one sentence", () => {
    expect(
      freeMotionMessage(
        [loose([1], [ALONG_X], [ALONG_Z]), loose([2], [ALONG_X], [ALONG_Z])],
        bodies,
      ),
    ).toBe(
      "Bodies 1 and 2 can still move along X and rotate about Z. " +
        "Add supports or connect them to other bodies.",
    );
  });

  test("names regions and idealised shells by the body they belong to", () => {
    const properties = [
      { id: 1, materialId: 1, body: 1 },
      { id: 2, materialId: 1, body: 1 },
      { id: 3, materialId: 1 },
      { id: 4, materialId: 1, thickness: 2, sourceBodyId: 3 },
    ];
    expect(
      freeMotionMessage(
        [loose([2], [ALONG_X], []), loose([4], [], [ALONG_Z])],
        properties,
      ),
    ).toBe(
      "Body 1 can still move along X. Body 3 can still rotate about Z. " +
        "Add supports or connect them to other bodies.",
    );
  });

  test("refuses a label no property describes", () => {
    expect(() =>
      freeMotionMessage([loose([9], [ALONG_X], [])], bodies),
    ).toThrow(/9/);
  });
});
