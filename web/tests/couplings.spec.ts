// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Surface-to-point couplings in the Constraints panel (KOF-208): a coupling is
// a named model object with a picked surface, a kind, a DOF mask and a
// reference point, created, edited and deleted like a BC or a load.
//
// The reference point is a real node of the model — created with the coupling,
// removed with it — which is what lets a BC or a load act on it through the
// ordinary face-entry machinery. These tests pin that lifecycle, because a
// leftover reference point is a node in no element, and the all-solid solve
// would assemble it into a singular system.
//
// Face picking itself needs 3D clicks, so the picked faces are written into the
// same pick-session state the viewport writes (selectedFace); everything from
// the kind select onwards is driven through the real UI.

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { boxHexMesh } from "../../examples/validation/lib/mesh.mjs";

interface CouplingGroupState {
  id: number;
  name: string;
  kind: "distributing" | "kinematic";
  dofs: number[];
  refNodeId: number;
  point: [number, number, number];
  faces: { id: number; nodeIds: number[] }[];
}

type Store = {
  getState(): {
    couplingGroups: CouplingGroupState[];
    bcGroups: { id: number; faces: { nodeIds: number[] }[] }[];
    loadGroups: {
      id: number;
      faces: { nodeIds: number[]; geometry?: string }[];
    }[];
    nodes: { id: number; x: number; y: number; z: number }[];
    couplingDraft: {
      point: [number, number, number];
      nodeIds: number[];
    } | null;
    setSelectedFace(face: {
      nodeIds: number[];
      label: string;
      axis: "X" | "Y" | "Z";
      isMax: boolean;
    }): void;
  };
  setState(s: object): void;
};

// One hex box, 10 × 4 × 4 mm. Its x = 10 face is the surface a coupling grips.
function box() {
  const mesh = boxHexMesh(10, 4, 4, 5, 2, 2);
  const nodes = mesh.vertices.map((v: number[], i: number) => ({
    id: i,
    x: v[0],
    y: v[1],
    z: v[2],
  }));
  const elements = mesh.hexahedra.map((h: number[], i: number) => ({
    id: i,
    type: "CHEXA",
    nodeIds: [...h],
    propertyId: 1,
  }));
  const endFace = nodes
    .filter((node) => Math.abs(node.x - 10) < 1e-9)
    .map((node) => node.id);
  return { nodes, elements, endFace };
}

async function openConstraintsMode(page: Page) {
  const model = box();
  await page.goto("/app/");
  await page.waitForFunction(
    () => !!(window as unknown as { __kofemStore?: unknown }).__kofemStore,
  );
  await page.evaluate((injected) => {
    (window as unknown as { __kofemStore: Store }).__kofemStore.setState({
      nodes: injected.nodes,
      elements: injected.elements,
      properties: [{ id: 1, materialId: 1 }],
      modelName: "Box",
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

const state = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __kofemStore: Store }).__kofemStore.getState(),
  );

test("a coupling idealises a picked surface to a reference point", async ({
  page,
}) => {
  const model = await openConstraintsMode(page);

  await page.getByTestId("add-coupling").click();
  await pickFace(page, model.endFace);

  // The point defaults to the picked selection's centre — the x = 10 face of a
  // 10 × 4 × 4 box, so (10, 2, 2).
  await expect(page.getByTestId("coupling-point-x")).toHaveValue("10");
  await expect(page.getByTestId("coupling-point-y")).toHaveValue("2");
  await expect(page.getByTestId("coupling-point-z")).toHaveValue("2");

  // Kinematic with the rotations dropped: a spherical joint at the point.
  await page.getByTestId("coupling-kind").selectOption("kinematic");
  for (const dof of ["Rx", "Ry", "Rz"])
    await page.getByRole("checkbox", { name: dof, exact: true }).uncheck();
  await page.getByTestId("apply-coupling").click();

  const { couplingGroups, nodes } = await state(page);
  expect(couplingGroups).toHaveLength(1);
  expect(couplingGroups[0].name).toBe("Coupling1");
  expect(couplingGroups[0].kind).toBe("kinematic");
  expect(couplingGroups[0].dofs).toEqual([0, 1, 2]);
  expect(couplingGroups[0].point).toEqual([10, 2, 2]);
  expect(couplingGroups[0].faces[0].nodeIds).toEqual(model.endFace);

  // The reference point is a real node, added to the model.
  const refNode = nodes.find((n) => n.id === couplingGroups[0].refNodeId);
  expect(refNode).toBeTruthy();
  expect([refNode?.x, refNode?.y, refNode?.z]).toEqual([10, 2, 2]);
  expect(nodes).toHaveLength(model.nodes.length + 1);

  await expect(page.getByText("Coupling1")).toBeVisible();
  await expect(
    page.getByText(/kinematic · Ux, Uy, Uz · 9 nodes/),
  ).toBeVisible();
});

test("a coupling's kind, DOFs and point are editable, and deleting it removes the reference point", async ({
  page,
}) => {
  const model = await openConstraintsMode(page);

  await page.getByTestId("add-coupling").click();
  await pickFace(page, model.endFace);
  await page.getByTestId("apply-coupling").click();

  // ✎ opens the inline editor. Switching to distributing drops the DOF mask —
  // a distributing coupling ties all six of its point's DOFs by construction,
  // so the checkboxes are not offered and the stored mask is the full set.
  await page.getByTitle("Edit coupling").click();
  const form = page.getByTestId("coupling-edit-form");
  await expect(form).toBeVisible();
  await form.getByTestId("coupling-kind").selectOption("distributing");
  await expect(
    form.getByRole("checkbox", { name: "Rx", exact: true }),
  ).toHaveCount(0);
  await form.getByTestId("coupling-point-x").fill("14");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).not.toBeVisible();

  const edited = await state(page);
  expect(edited.couplingGroups[0].kind).toBe("distributing");
  expect(edited.couplingGroups[0].dofs).toEqual([0, 1, 2, 3, 4, 5]);
  expect(edited.couplingGroups[0].point).toEqual([14, 2, 2]);
  // The reference point NODE moved with it — the point is the node.
  const moved = edited.nodes.find(
    (n) => n.id === edited.couplingGroups[0].refNodeId,
  );
  expect(moved?.x).toBe(14);

  await page.getByTitle("Delete coupling").click();
  const after = await state(page);
  expect(after.couplingGroups).toHaveLength(0);
  expect(after.nodes).toHaveLength(model.nodes.length);
});

test("a BC can act on a coupling's reference point, and goes when the coupling does", async ({
  page,
}) => {
  const model = await openConstraintsMode(page);

  await page.getByTestId("add-coupling").click();
  await pickFace(page, model.endFace);
  await page.getByTestId("coupling-kind").selectOption("kinematic");
  await page.getByTestId("apply-coupling").click();
  const { couplingGroups } = await state(page);
  const refNodeId = couplingGroups[0].refNodeId;

  // A BC with no face at all — the reference point IS the target. Clamping a
  // kinematic point is how a bolted hole is restrained.
  await page.getByRole("button", { name: "+ Add BC" }).click();
  await page
    .getByTestId("target-reference-point")
    .selectOption(String(refNodeId));
  await page.getByRole("button", { name: "Apply BC" }).click();

  const withBc = await state(page);
  expect(withBc.bcGroups).toHaveLength(1);
  expect(withBc.bcGroups[0].faces[0].nodeIds).toEqual([refNodeId]);

  // Deleting the coupling takes the reference point with it, so the BC that
  // named it must go too rather than constrain a node that no longer exists.
  await page.getByTitle("Delete coupling").click();
  const after = await state(page);
  expect(after.couplingGroups).toHaveLength(0);
  expect(after.bcGroups).toHaveLength(0);
  expect(after.nodes).toHaveLength(model.nodes.length);
});

test("the reference point being placed is previewed in the viewport", async ({
  page,
}) => {
  const model = await openConstraintsMode(page);

  // Nothing is being placed yet, so there is nothing to preview.
  await page.getByTestId("add-coupling").click();
  expect((await state(page)).couplingDraft).toBeNull();

  // Picking the surface places the point at its centre, and the preview follows
  // — the marker and the lines to the gripped nodes are what make it possible to
  // judge the position before applying.
  await pickFace(page, model.endFace);
  const picked = await state(page);
  expect(picked.couplingDraft?.point).toEqual([10, 2, 2]);
  expect(picked.couplingDraft?.nodeIds).toEqual(model.endFace);

  // Typing coordinates moves the preview with them.
  await page.getByTestId("coupling-point-x").fill("14");
  await expect
    .poll(async () => (await state(page)).couplingDraft?.point[0])
    .toBe(14);

  // Half-typed input is not a position: the preview drops rather than park the
  // marker at a number the user did not mean.
  await page.getByTestId("coupling-point-x").fill("");
  await expect.poll(async () => (await state(page)).couplingDraft).toBeNull();

  // Cancelling the pick session abandons the coupling, and the preview with it.
  await page.getByTestId("coupling-point-x").fill("14");
  await expect
    .poll(async () => (await state(page)).couplingDraft)
    .not.toBeNull();
  await page.getByTitle("Cancel").click();
  expect((await state(page)).couplingDraft).toBeNull();
});

test("a load can be applied at a single picked node", async ({ page }) => {
  const model = await openConstraintsMode(page);

  await page.getByRole("button", { name: "+ Add Load" }).click();
  // A solid mesh offers Face and Point, but not Edge — a closed solid boundary
  // has no boundary polyline to walk.
  await expect(page.getByTestId("pick-geometry-face")).toBeVisible();
  await expect(page.getByTestId("pick-geometry-point")).toBeVisible();
  await expect(page.getByTestId("pick-geometry-edge")).toHaveCount(0);

  await page.getByTestId("pick-geometry-point").click();
  await pickFace(page, [model.endFace[0]]);
  await expect(
    page.getByText("applied at the picked node as a concentrated force"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Apply Load" }).click();

  // The entry records that it was a POINT, which is what tells the solver to
  // apply the force at the node instead of integrating it over a surface.
  const { loadGroups } = await state(page);
  expect(loadGroups).toHaveLength(1);
  expect(loadGroups[0].faces[0].nodeIds).toEqual([model.endFace[0]]);
  expect(loadGroups[0].faces[0].geometry).toBe("point");
});

test("a pressure or a moment on a single node of a solid mesh is refused", async ({
  page,
}) => {
  const model = await openConstraintsMode(page);

  await page.getByRole("button", { name: "+ Add Load" }).click();
  await page.getByTestId("pick-geometry-point").click();
  await pickFace(page, [model.endFace[0]]);

  // A pressure is force per unit area, and a node has none.
  await page.getByRole("combobox").first().selectOption("pressure");
  await page.getByRole("button", { name: "Apply Load" }).click();
  await expect(page.getByTestId("constraints-error")).toContainText(
    "cannot act on a single node",
  );

  // A moment needs a rotational DOF, which a solid mesh node does not have —
  // the message points at the reference point, which does.
  await page.getByRole("combobox").first().selectOption("moment");
  await page.getByRole("button", { name: "Apply Load" }).click();
  await expect(page.getByTestId("constraints-error")).toContainText(
    "reference point",
  );

  expect((await state(page)).loadGroups).toHaveLength(0);
});
