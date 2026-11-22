// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Support reactions (KOF-387): which support holds each solver DOF, the Rust
// result read back, and the check of the reactions against the applied load.

import { describe, expect, test } from "bun:test";
import {
  parseReactions,
  reactionBalance,
  supportOwners,
  type ReactionSummary,
} from "../../src/lib/solve/reactions";
import { rebuildConstraints } from "../../src/store/boundaryRebuild";
import type { NamedBcGroup } from "../../src/store/boundaryGroups";

describe("supportOwners", () => {
  test("each constraint's DOF belongs to its group, the first one where two name it", () => {
    const vertexOf = (nodeId: number) => nodeId - 10;
    const { owners, supports } = supportOwners(
      [
        { nodeId: 10, dof: 0, group: 0 },
        { nodeId: 10, dof: 0, group: 1 },
        { nodeId: 11, dof: 4, group: 1 },
        { nodeId: 11, dof: 2 },
      ],
      2,
      vertexOf,
    );
    expect(supports).toBe(2);
    expect(Array.from(owners)).toEqual([
      0, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1, -1,
    ]);
  });

  test("a model without grouped constraints has no supports", () => {
    expect(supportOwners([{ nodeId: 1, dof: 0 }], 1, () => 0).supports).toBe(0);
  });

  test("a node that maps outside the solve is refused", () => {
    expect(() =>
      supportOwners([{ nodeId: 1, dof: 0, group: 0 }], 1, () => 3),
    ).toThrow(/maps to vertex 3/);
  });

  test("the BC groups give their constraints their index", () => {
    const groups = [
      {
        id: 7,
        name: "Clamp",
        dofs: [0, 1],
        value: 0,
        faces: [{ id: 1, nodeIds: [1] }],
      },
      {
        id: 9,
        name: "Roller",
        dofs: [2],
        value: 0,
        faces: [{ id: 2, nodeIds: [2] }],
      },
    ] as unknown as NamedBcGroup[];
    expect(
      rebuildConstraints(groups).map((c) => [c.nodeId, c.dof, c.group]),
    ).toEqual([
      [1, 0, 0],
      [1, 1, 0],
      [2, 2, 1],
    ]);
  });
});

describe("parseReactions", () => {
  test("reads force, moment, centroid and vertex count per support, then the loads", () => {
    const flat = Float64Array.from([
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      12, // support 0
      -1,
      -2,
      -3,
      0,
      0,
      0,
      0,
      0,
      0,
      0, // support 1
      10,
      20,
      30,
      0,
      0,
      1,
    ]);
    const summary = parseReactions(flat, 2);
    expect(summary.supports[0]).toEqual({
      support: 0,
      force: [1, 2, 3],
      moment: [4, 5, 6],
      centroid: [7, 8, 9],
      vertices: 12,
    });
    expect(summary.supports[1].vertices).toBe(0);
    expect(summary.applied).toEqual([10, 20, 30]);
    expect(summary.appliedOnSupports).toEqual([0, 0, 1]);
  });

  test("a result of the wrong length is refused", () => {
    expect(() => parseReactions(new Float64Array(15), 1)).toThrow(
      /expected 16/,
    );
  });
});

const summary = (
  forces: [number, number, number][],
  applied: [number, number, number],
  appliedOnSupports: [number, number, number] = [0, 0, 0],
): ReactionSummary => ({
  supports: forces.map((force, support) => ({
    support,
    force,
    moment: [0, 0, 0],
    centroid: [0, 0, 0],
    vertices: 4,
  })),
  applied,
  appliedOnSupports,
});

describe("reactionBalance", () => {
  test("reactions that carry the whole load balance it", () => {
    const balance = reactionBalance(
      summary(
        [
          [0, 0, 600],
          [0, 0, 400.0001],
        ],
        [0, 0, -1000],
      ),
    );
    expect(balance.reaction).toEqual([0, 0, 1000.0001]);
    expect(balance.balanced).toBe(true);
    expect(balance.loadOnSupports).toBe(false);
  });

  test("reactions that miss part of the load do not balance it", () => {
    const balance = reactionBalance(summary([[0, 0, 900]], [0, 0, -1000]));
    expect(balance.balanced).toBe(false);
    expect(balance.difference).toEqual([0, 0, -100]);
  });

  test("load on a held DOF is flagged", () => {
    const balance = reactionBalance(
      summary([[0, 0, 1000]], [0, 0, -1000], [0, 0, -250]),
    );
    expect(balance.balanced).toBe(true);
    expect(balance.loadOnSupports).toBe(true);
  });

  test("no load and no reaction balance", () => {
    expect(reactionBalance(summary([[0, 0, 0]], [0, 0, 0])).balanced).toBe(
      true,
    );
  });
});
