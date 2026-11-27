// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Contact in the Boundary conditions panel (KOF-485): two picked surfaces
// that carry load where they touch and separate where they pull apart. A
// contact is its own kind under + Add, named Contact1, Contact2 … like a tie
// is Tie1, and the static solve reports its pressure and status as results.
//
// Face picking needs 3D clicks, so the picked faces are written into the
// pick-session state the viewport writes (selectedFace); everything from the
// side toggle on is driven through the real UI.

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { boxHexMesh } from "../../examples/validation/lib/mesh.mjs";
import { addBoundary, openTree } from "./fixtures/tree";

interface ContactGroupState {
  id: number;
  name: string;
  facesA: { id: number; nodeIds: number[] }[];
  facesB: { id: number; nodeIds: number[] }[];
}

interface ContactResultState {
  nodeIds: number[];
  pressure: Float64Array;
  closed: Uint8Array;
  force: number;
}

type Store = {
  getState(): {
    contactGroups: ContactGroupState[];
    result: { contact?: ContactResultState | null } | null;
    resultType: string;
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
const LENGTH = 10;
const SIDE = 4;
const PUSH = 1;
const YOUNG = 210000;
const OFFSET = 1000;

// Two hex boxes along x, 0.5 mm apart, meshed independently (box B finer).
function twoGappedBoxes() {
  const boxA = boxHexMesh(LENGTH, SIDE, SIDE, 4, 2, 2);
  const boxB = boxHexMesh(LENGTH, SIDE, SIDE, 4, 3, 3);
  const nodes: { id: number; x: number; y: number; z: number }[] = [];
  boxA.vertices.forEach((v: number[], i: number) =>
    nodes.push({ id: i, x: v[0], y: v[1], z: v[2] }),
  );
  boxB.vertices.forEach((v: number[], i: number) =>
    nodes.push({ id: OFFSET + i, x: v[0] + LENGTH + GAP, y: v[1], z: v[2] }),
  );
  const elements: {
    id: number;
    type: string;
    nodeIds: number[];
    propertyId: number;
  }[] = [];
  boxA.hexahedra.forEach((h: number[], i: number) =>
    elements.push({ id: i + 1, type: "CHEXA", nodeIds: [...h], propertyId: 1 }),
  );
  boxB.hexahedra.forEach((h: number[], i: number) =>
    elements.push({
      id: OFFSET + i + 1,
      type: "CHEXA",
      nodeIds: h.map((n) => OFFSET + n),
      propertyId: 2,
    }),
  );
  const at = (x: number) =>
    nodes.filter((node) => Math.abs(node.x - x) < 1e-9).map((node) => node.id);
  return {
    nodes,
    elements,
    facingA: at(LENGTH),
    facingB: at(LENGTH + GAP),
    farB: at(2 * LENGTH + GAP),
  };
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
      materials: [
        {
          id: 1,
          name: "Steel",
          young: 210000,
          poisson: 0.3,
          density: 7.85e-9,
          color: "#4e79a7",
        },
      ],
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

const contactState = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __kofemStore: Store }).__kofemStore.getState()
        .contactGroups,
  );

// + Add → Contact, the two facing surfaces, Create Contact.
async function createContact(
  page: Page,
  model: ReturnType<typeof twoGappedBoxes>,
) {
  await addBoundary(page, "contact");
  await pickFace(page, model.facingA);
  await page.getByTestId("contact-side-b").click();
  await pickFace(page, model.facingB);
  await expect(page.getByTestId("contact-side-a")).toContainText("(1)");
  await expect(page.getByTestId("contact-side-b")).toContainText("(1)");
  await page.getByTestId("apply-contact").click();
}

test("a contact is its own kind: picked, named Contact1, and deletable", async ({
  page,
}) => {
  const model = await openConstraintsMode(page);
  await createContact(page, model);

  const groups = await contactState(page);
  expect(groups).toHaveLength(1);
  expect(groups[0].name).toBe("Contact1");
  expect(groups[0].facesA[0].nodeIds).toEqual(model.facingA);
  expect(groups[0].facesB[0].nodeIds).toEqual(model.facingB);
  await expect(page.getByTestId("tree-contact-1")).toHaveText("Contact1");
  // Before a solve the contact's view shows no summary line.
  await page.getByTestId("tree-contact-1").click();
  await expect(page.getByTestId("panel-title")).toHaveText("Contact1");
  await expect(page.getByTestId("contact-summary-1")).toHaveCount(0);

  await page.getByTestId("tree-delete-contact-1").click();
  await page
    .getByRole("dialog", { name: /^Delete / })
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(page.getByTestId("tree-contact-1")).toHaveCount(0);
  expect(await contactState(page)).toHaveLength(0);
});

test("a contact needs both surfaces", async ({ page }) => {
  const model = await openConstraintsMode(page);
  await addBoundary(page, "contact");
  await pickFace(page, model.facingA);
  await page.getByTestId("apply-contact").click();
  await expect(page.getByTestId("constraints-error")).toContainText(
    "Surface B",
  );
  expect(await contactState(page)).toHaveLength(0);
});

test("the static solve reports the contact pressure and force", async ({
  page,
}) => {
  const model = await openConstraintsMode(page);
  // Roller supports, box B's far end pushed 1 mm towards box A across the
  // 0.5 mm gap: two bars in series, F = E·A·(push − gap) / 2L.
  await page.evaluate(
    ({ nodes, farB }) => {
      const constraints: object[] = [];
      for (const node of nodes) {
        if (node.x === 0) constraints.push({ nodeId: node.id, dof: 0 });
        if (node.y === 0) constraints.push({ nodeId: node.id, dof: 1 });
        if (node.z === 0) constraints.push({ nodeId: node.id, dof: 2 });
      }
      for (const nodeId of farB)
        constraints.push({ nodeId, dof: 0, prescribedValue: -1 });
      (window as unknown as { __kofemStore: Store }).__kofemStore.setState({
        constraints,
      });
    },
    { nodes: model.nodes, farB: model.farB },
  );
  await createContact(page, model);

  await openTree(page, "static");
  await page.getByRole("button", { name: /Run static solve/ }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __kofemStore: Store }).__kofemStore.getState()
            .result?.contact?.force ?? null,
      ),
    )
    .not.toBeNull();

  const contact = await page.evaluate(() => {
    const result = (
      window as unknown as { __kofemStore: Store }
    ).__kofemStore.getState().result;
    const found = result?.contact;
    if (!found) throw new Error("no contact result");
    return {
      nodeIds: found.nodeIds,
      pressure: Array.from(found.pressure),
      closed: Array.from(found.closed),
      force: found.force,
    };
  });
  const expected = (YOUNG * SIDE * SIDE * (PUSH - GAP)) / (2 * LENGTH);
  expect(Math.abs(contact.force - expected) / expected).toBeLessThan(1e-4);
  // Box B's facing surface is the finer one: its 16 nodes carry the contact,
  // all touching, in store node ids.
  expect([...contact.nodeIds].sort((a, b) => a - b)).toEqual(
    [...model.facingB].sort((a, b) => a - b),
  );
  expect(contact.closed.every((closed) => closed === 1)).toBe(true);

  // The contact's own view says what it carried.
  await page.getByTestId("tree-contact-1").click();
  await expect(page.getByTestId("contact-summary-1")).toContainText(
    "16 of 16 nodes touching",
  );

  // Results → + Add offers the contact pressure, and plotting it colours
  // the mesh by it.
  await page.getByTestId("tree-add-results").click();
  await page.getByTestId("add-plot-contact-pressure").click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __kofemStore: Store }).__kofemStore.getState()
            .resultType,
      ),
    )
    .toBe("Contact pressure");
  await page.getByTestId("tree-add-results").click();
  await expect(page.getByTestId("add-plot-contact-status")).toBeVisible();
});

// Box B on no support, pushed by a force (KOF-501): only the contact holds
// it, and only along x. It is pressed onto box A across the gap all the
// same; a load across the contact is refused, naming the body and motion.
test("a box only the contact holds is pressed on, and a load across it is refused", async ({
  page,
}) => {
  const model = await openConstraintsMode(page);
  const push = async (sideways: number) => {
    await page.evaluate(
      ({ nodes, farB, offset, sideways }) => {
        const constraints: object[] = [];
        for (const node of nodes) {
          if (node.id >= offset) continue;
          if (node.x === 0) constraints.push({ nodeId: node.id, dof: 0 });
          if (node.y === 0) constraints.push({ nodeId: node.id, dof: 1 });
          if (node.z === 0) constraints.push({ nodeId: node.id, dof: 2 });
        }
        const loads = farB.flatMap((nodeId) => [
          { nodeId, dof: 0, value: -1000 / farB.length },
          { nodeId, dof: 1, value: sideways / farB.length },
        ]);
        (window as unknown as { __kofemStore: Store }).__kofemStore.setState({
          constraints,
          loads,
          result: null,
        });
      },
      { nodes: model.nodes, farB: model.farB, offset: OFFSET, sideways },
    );
  };
  await push(0);
  await createContact(page, model);
  await openTree(page, "static");
  await page.getByRole("button", { name: /Run static solve/ }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __kofemStore: Store }).__kofemStore.getState()
            .result?.contact?.force ?? null,
      ),
    )
    .not.toBeNull();
  const force = await page.evaluate(
    () =>
      (window as unknown as { __kofemStore: Store }).__kofemStore.getState()
        .result?.contact?.force ?? null,
  );
  expect(Math.abs((force ?? 0) - 1000) / 1000).toBeLessThan(1e-4);

  await push(10);
  await openTree(page, "static");
  await page.getByRole("button", { name: /Run static solve/ }).click();
  await expect(
    page.getByText(
      "Body 2 is held only by contact, which cannot stop it: its load would make it move along Y.",
    ),
  ).toBeVisible();
});

test("a model without contact offers no contact results", async ({ page }) => {
  const model = await openConstraintsMode(page);
  await page.evaluate((count) => {
    const store = (
      window as unknown as {
        __kofemStore: {
          getState(): { setResult(result: object): void };
        };
      }
    ).__kofemStore;
    store.getState().setResult({
      displacements: new Float64Array(count * 3),
    });
  }, model.nodes.length);
  await page.getByTestId("tree-add-results").click();
  await expect(page.getByTestId("add-plot-contact-pressure")).toHaveCount(0);
  await expect(page.getByTestId("add-plot-contact-status")).toHaveCount(0);
  await expect(page.getByTestId("add-plot-ux")).toBeVisible();
});
