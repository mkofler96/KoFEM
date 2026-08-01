// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Tie connections in the Constraints panel: a bonded tie is a named model
// object with two picked surfaces and an extent, created, edited and deleted
// like a BC or a load — the explicit replacement for the model-wide "tie
// distance" number that used to sit under Bodies with nothing to show for it.
//
// Face picking itself needs 3D clicks, so the picked faces are written into the
// same pick-session state the viewport writes (selectedFace); everything from
// the side toggle onwards is driven through the real UI.

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { boxHexMesh } from "../../examples/validation/lib/mesh.mjs";

interface TieGroupState {
  id: number;
  name: string;
  facesA: { id: number; nodeIds: number[] }[];
  facesB: { id: number; nodeIds: number[] }[];
  extent: "full" | "region";
  searchDistance: number;
}

type Store = {
  getState(): {
    tieGroups: TieGroupState[];
    pickTieSide: "a" | "b";
    setSelectedFace(face: {
      nodeIds: number[];
      label: string;
      axis: "X" | "Y" | "Z";
      isMax: boolean;
    }): void;
  };
  setState(s: object): void;
};

const GAP = 0.5;

// Two independently-meshed hex boxes separated by a 0.5 mm gap — the pin/eye
// contact in miniature, and the case a tie exists for.
function twoGappedBoxes() {
  const boxA = boxHexMesh(10, 4, 4, 5, 2, 2);
  const boxB = boxHexMesh(10, 4, 4, 5, 2, 2);
  const off = 1000;

  const nodes: { id: number; x: number; y: number; z: number }[] = [];
  boxA.vertices.forEach((v: number[], i: number) =>
    nodes.push({ id: i, x: v[0], y: v[1], z: v[2] }),
  );
  boxB.vertices.forEach((v: number[], i: number) =>
    nodes.push({ id: off + i, x: v[0] + 10 + GAP, y: v[1], z: v[2] }),
  );

  const elements: {
    id: number;
    type: string;
    nodeIds: number[];
    propertyId: number;
  }[] = [];
  boxA.hexahedra.forEach((h: number[], i: number) =>
    elements.push({ id: i, type: "CHEXA", nodeIds: [...h], propertyId: 1 }),
  );
  boxB.hexahedra.forEach((h: number[], i: number) =>
    elements.push({
      id: off + i,
      type: "CHEXA",
      nodeIds: h.map((n) => off + n),
      propertyId: 2,
    }),
  );

  const facingA = nodes
    .filter((node) => Math.abs(node.x - 10) < 1e-9)
    .map((node) => node.id);
  const facingB = nodes
    .filter((node) => Math.abs(node.x - (10 + GAP)) < 1e-9)
    .map((node) => node.id);

  return { nodes, elements, facingA, facingB };
}

async function openConstraintsMode(page: Page) {
  const model = twoGappedBoxes();
  await page.goto("/app/");
  await page.waitForFunction(
    () => !!(window as unknown as { __kofemStore?: unknown }).__kofemStore,
  );
  await page.evaluate((injected) => {
    (window as unknown as { __kofemStore: Store }).__kofemStore.setState({
      nodes: injected.nodes,
      elements: injected.elements,
      properties: [
        { id: 1, materialId: 1 },
        { id: 2, materialId: 1 },
      ],
      modelName: "Two boxes",
      hasStarted: true,
      viewRepr: "surface",
      mode: "constraints",
    });
  }, model);
  return model;
}

// Write a picked face into the live pick session, the way a viewport click does.
async function pickFace(page: Page, nodeIds: number[]) {
  await page.evaluate((ids) => {
    (window as unknown as { __kofemStore: Store }).__kofemStore
      .getState()
      .setSelectedFace({
        nodeIds: ids,
        label: `Face (${ids.length} nodes)`,
        axis: "X",
        isMax: true,
      });
  }, nodeIds);
}

const tieState = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __kofemStore: Store }).__kofemStore.getState()
        .tieGroups,
  );

test("a tie connects two picked surfaces and reports the pairs it welds", async ({
  page,
}) => {
  const model = await openConstraintsMode(page);

  await page.getByTestId("add-tie").click();

  // Surface A, then switch sides and pick surface B. Switching parks the first
  // side, so both counts are visible on the toggle.
  await pickFace(page, model.facingA);
  await expect(page.getByTestId("tie-side-a")).toContainText("(1)");
  await page.getByTestId("tie-side-b").click();
  await pickFace(page, model.facingB);
  await expect(page.getByTestId("tie-side-a")).toContainText("(1)");
  await expect(page.getByTestId("tie-side-b")).toContainText("(1)");

  // Limit the tie to the region that actually comes within 0.6 mm.
  await page.getByTestId("tie-extent").selectOption("region");
  await page.getByTestId("tie-distance").fill("0.6");
  await page.getByTestId("apply-tie").click();

  const groups = await tieState(page);
  expect(groups).toHaveLength(1);
  expect(groups[0].name).toBe("Tie1");
  expect(groups[0].extent).toBe("region");
  expect(groups[0].searchDistance).toBe(0.6);
  expect(groups[0].facesA[0].nodeIds).toEqual(model.facingA);
  expect(groups[0].facesB[0].nodeIds).toEqual(model.facingB);

  // The card names the connection and the node pairs it actually welds — the
  // 3×3 interface of the two facing faces.
  await expect(page.getByText("Tie1")).toBeVisible();
  await expect(page.getByText("within 0.6 mm · 9 node pairs")).toBeVisible();
});

test("a tie's extent is editable after creation, and the tie is deletable", async ({
  page,
}) => {
  const model = await openConstraintsMode(page);

  await page.getByTestId("add-tie").click();
  await pickFace(page, model.facingA);
  await page.getByTestId("tie-side-b").click();
  await pickFace(page, model.facingB);
  await page.getByTestId("tie-extent").selectOption("region");
  await page.getByTestId("tie-distance").fill("0.6");
  await page.getByTestId("apply-tie").click();

  // ✎ opens the inline editor; switching to the full surface drops the distance.
  await page.getByTitle("Edit tie").click();
  const form = page.getByTestId("tie-edit-form");
  await expect(form).toBeVisible();
  await form.getByTestId("tie-extent").selectOption("full");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).not.toBeVisible();

  const edited = await tieState(page);
  expect(edited[0].extent).toBe("full");
  await expect(page.getByText("full surface · 9 node pairs")).toBeVisible();

  await page.getByTitle("Delete tie").click();
  expect(await tieState(page)).toHaveLength(0);
});

test("a region tie needs a positive search distance", async ({ page }) => {
  const model = await openConstraintsMode(page);

  await page.getByTestId("add-tie").click();
  await pickFace(page, model.facingA);
  await page.getByTestId("tie-side-b").click();
  await pickFace(page, model.facingB);
  await page.getByTestId("tie-extent").selectOption("region");
  await page.getByTestId("tie-distance").fill("0");
  await page.getByTestId("apply-tie").click();

  await expect(page.getByTestId("constraints-error")).toContainText(
    "search distance must be a positive number",
  );
  expect(await tieState(page)).toHaveLength(0);
});

test("one picked interface splits between the two bodies that meet on it", async ({
  page,
}) => {
  const model = await openConstraintsMode(page);

  // Where two parts meet across a coincident interface the mesher gives them a
  // single CAD face, so one click selects both bodies' nodes. Leaving Surface B
  // empty ties that one pick, split by body — the only way the crane's pin/hook
  // interface can be declared.
  await page.getByTestId("add-tie").click();
  await pickFace(page, [...model.facingA, ...model.facingB]);
  await page.getByTestId("apply-tie").click();

  const groups = await tieState(page);
  expect(groups).toHaveLength(1);
  expect(groups[0].facesB).toHaveLength(0);
  // The split found the 3x3 facing grids of the two boxes and welded them.
  await expect(
    page.getByText("full surface · split by body · 9 node pairs"),
  ).toBeVisible();
});

test("a tie with nothing picked is rejected", async ({ page }) => {
  await openConstraintsMode(page);

  await page.getByTestId("add-tie").click();
  await page.getByTestId("apply-tie").click();

  await expect(page.getByTestId("constraints-error")).toContainText(
    "at least one picked face on Surface A",
  );
  expect(await tieState(page)).toHaveLength(0);
});
