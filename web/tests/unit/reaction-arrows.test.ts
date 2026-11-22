// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";
import { reactionArrows, reactionRange } from "../../src/lib/reactionArrows";
import type { ReactionSummary } from "../../src/lib/solve/reactions";

const summary: ReactionSummary = {
  supports: [
    {
      support: 0,
      force: [0, 30, 0],
      moment: [0, 0, 0],
      centroid: [0, 5, 5],
      vertices: 3,
    },
    {
      support: 1,
      force: [0, 0, 0],
      moment: [0, 0, 0],
      centroid: [0, 0, 0],
      vertices: 0,
    },
  ],
  nodal: [
    { support: 0, position: [0, 0, 0], force: [0, 10, 0] },
    { support: 0, position: [0, 10, 0], force: [0, 20, 0] },
    { support: 0, position: [0, 10, 10], force: [0, 0, 0] },
  ],
  applied: [0, -30, 0],
  appliedOnSupports: [0, 0, 0],
};

describe("reactionArrows", () => {
  test("resultant: one arrow per support that carries a force, at its centroid", () => {
    const arrows = reactionArrows(summary, "resultant");
    expect(arrows).toEqual([
      {
        key: "support-0",
        tip: [0, 5, 5],
        direction: [0, 1, 0],
        size: 1,
        magnitude: 30,
      },
    ]);
  });

  test("nodal: one arrow per loaded node, sized by the largest", () => {
    const arrows = reactionArrows(summary, "nodal");
    expect(arrows.map((a) => a.key)).toEqual(["node-0", "node-1"]);
    expect(arrows[0]).toEqual({
      key: "node-0",
      tip: [0, 0, 0],
      direction: [0, 1, 0],
      size: 0.5,
      magnitude: 10,
    });
    expect(arrows[1].size).toBe(1);
  });

  test("no force, no arrows", () => {
    const none: ReactionSummary = {
      ...summary,
      supports: [summary.supports[1]],
      nodal: [summary.nodal[2]],
    };
    expect(reactionArrows(none, "resultant")).toEqual([]);
    expect(reactionArrows(none, "nodal")).toEqual([]);
  });
});

describe("reactionRange", () => {
  test("spans the arrows the display draws, for the legend and their colour", () => {
    expect(reactionRange(summary, "nodal")).toEqual({ min: 10, max: 20 });
    expect(reactionRange(summary, "resultant")).toEqual({ min: 30, max: 30 });
  });

  test("none without a reaction", () => {
    expect(
      reactionRange({ ...summary, nodal: [summary.nodal[2]] }, "nodal"),
    ).toBeNull();
  });
});
