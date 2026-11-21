// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A load the solve cannot apply in full is refused in the Solve panel, by
// name, before the run (KOF-411). A force picked on an edge of a solid body
// spans no element face, so it used to vanish from the solve without a word;
// a group with one such selection put its whole total on the others.

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { bootstrapCantilever } from "./fixtures/cantilever";

type FaceArg = {
  label: string;
  nodeIds: number[];
  geometry?: "face" | "edge" | "point";
};
type Store = {
  getState(): {
    nodes: { id: number; x: number; y: number; z: number }[];
    createLoadGroup(
      faces: FaceArg[],
      dof: number,
      totalForce: number,
      kind?: string,
      components?: [number, number, number],
    ): void;
  };
};

// Add a 500 N force group on the cantilever's free end (x = 1): its end face,
// its bottom edge (y = z = 0), or both.
async function addEndLoad(page: Page, picks: ("face" | "edge")[]) {
  await page.evaluate((picks) => {
    const store = (window as unknown as { __kofemStore: Store }).__kofemStore;
    const end = store.getState().nodes.filter((n) => Math.abs(n.x - 1) < 1e-9);
    const selections = {
      face: { label: "End face", nodeIds: end.map((n) => n.id) },
      edge: {
        label: "Bottom edge",
        geometry: "edge" as const,
        nodeIds: end
          .filter((n) => Math.abs(n.y) < 1e-9 && Math.abs(n.z) < 1e-9)
          .map((n) => n.id),
      },
    };
    store.getState().createLoadGroup(
      picks.map((pick) => selections[pick]),
      2,
      -500,
      "force",
      [0, 0, -500],
    );
  }, picks);
}

async function openStaticStudy(page: Page) {
  await page.getByTestId("tree-add-studies").click();
  await page.getByTestId("add-study-static").click();
}

test("a force on an edge of a solid is refused by name, not dropped", async ({
  page,
}) => {
  await bootstrapCantilever(page);
  await addEndLoad(page, ["edge"]);
  await openStaticStudy(page);

  await expect(page.getByTestId("check-fail")).toHaveCount(1);
  await expect(page.getByTestId("check-fail")).toContainText(
    'Load "Load2": 1 of its selections matches no face of the current mesh, so it would apply no load at all.',
  );
  await expect(
    page.getByRole("button", { name: /Run static solve/ }),
  ).toBeDisabled();
});

test("a load group with one selection on no face is refused, not concentrated on the rest", async ({
  page,
}) => {
  await bootstrapCantilever(page);
  await addEndLoad(page, ["face", "edge"]);
  await openStaticStudy(page);

  await expect(page.getByTestId("check-fail")).toContainText(
    'Load "Load2": 1 of its selections matches no face of the current mesh, so its total would act on the other selections alone.',
  );
  await expect(
    page.getByRole("button", { name: /Run static solve/ }),
  ).toBeDisabled();
});

test("a load group on faces only still solves", async ({ page }) => {
  await bootstrapCantilever(page);
  await addEndLoad(page, ["face"]);
  await openStaticStudy(page);
  await expect(page.getByTestId("check-fail")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Run static solve/ }),
  ).toBeEnabled();
});
