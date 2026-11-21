// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A mesh refinement study (KOF-401) is a study of its own, built on an
// existing static study like a topology optimization. One click solves the
// static case on the current mesh, re-meshes at the element sizes divided by √2
// and by 2 and solves each, with the supports and loads on the same CAD faces
// throughout. Its levels and convergence verdict are a result of their own
// under Results.
//
// The model is a throwaway built by the published examples' node-side
// pipeline and served at the URLs the app's loader fetches: a 200 × 40 × 20 mm
// steel block clamped on one end face and pulled sideways on the other, a
// cantilever whose tip displacement converges as the mesh refines.

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { prismStep } from "../../examples/gallery/step-prism.mjs";
import { buildFromRecipe } from "../../examples/validation/lib/pipeline.mjs";
import { buildAnalysisFile } from "../../examples/validation/lib/app-model.mjs";
import { bootstrapCantilever } from "./fixtures/cantilever";
import { openTree } from "./fixtures/tree";
import type { Recipe } from "./fixtures/recipe";

const ID = "refinement-study-block";
const MESH = 16;

const recipe: Recipe = {
  step: () =>
    prismStep(
      [
        [0, 0],
        [200, 0],
        [200, 40],
        [0, 40],
      ],
      20,
      "Block",
    ),
  splits: [],
  discretization: { kind: "solid" },
  mesh: { maxElementSize: MESH, order: 1 },
  material: { name: "Steel", young: 210000, poisson: 0.3, density: 7.85e-9 },
  supports: [
    {
      name: "Clamp",
      faces: [{ at: [0, 20, 10] }],
      dofs: [0, 1, 2],
      value: 0,
    },
  ],
  loads: [
    {
      name: "Tip",
      kind: "force",
      faces: [{ at: [200, 20, 10] }],
      components: [0, -1000, 0],
    },
  ],
  readout: {
    quantity: "Tip displacement",
    probe: {
      kind: "displacement",
      component: 1,
      faces: [{ at: [200, 20, 10] }],
      unit: "mm",
    },
    formula: "none (a throwaway model)",
    reference: 1,
  },
};

interface StudyState {
  nodes: number;
  hasResult: boolean;
  remeshNotice: string | null;
  groupFaces: (number | undefined)[][];
  maxElementSize: string;
}

function studyState(page: Page): Promise<StudyState> {
  return page.evaluate(() => {
    type Group = { faces: { cadFaceId?: number }[] };
    const st = (
      window as unknown as {
        __kofemStore: {
          getState(): {
            nodes: unknown[];
            result: unknown;
            remeshNotice: string | null;
            bcGroups: Group[];
            loadGroups: Group[];
            maxElementSize: string;
          };
        };
      }
    ).__kofemStore.getState();
    return {
      nodes: st.nodes.length,
      hasResult: st.result !== null,
      remeshNotice: st.remeshNotice,
      groupFaces: [...st.bcGroups, ...st.loadGroups].map((g) =>
        g.faces.map((f) => f.cadFaceId),
      ),
      maxElementSize: st.maxElementSize,
    };
  });
}

async function openExample(page: Page): Promise<void> {
  const build = await buildFromRecipe(ID, recipe);
  const vtu = buildAnalysisFile(build, "Refinement study block");
  await page.route(`**/examples/${ID}.vtu`, (route) =>
    route.fulfill({ body: vtu, contentType: "application/xml" }),
  );
  await page.route(`**/examples/${ID}.model.step`, (route) =>
    route.fulfill({
      body: Buffer.from(build.stepBytes),
      contentType: "application/octet-stream",
    }),
  );
  await page.goto(`/app/?example=${ID}`);
  await expect(page.locator("nav")).toBeVisible();
  // The geometry is restored by a second fetch after the .vtu has loaded.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __kofemStore: { getState(): { stepBytes: Uint8Array | null } };
            }
          ).__kofemStore.getState().stepBytes?.length ?? 0,
      ),
    )
    .toBeGreaterThan(0);
}

test("one click solves three ever finer meshes and judges convergence @pipeline", async ({
  page,
}) => {
  await openExample(page);
  // An opened analysis does not record the sizes its mesh was made with, so
  // the study starts from the Mesh settings.
  await openTree(page, "mesh");
  await page.getByTestId("max-element-size").fill(String(MESH));
  await page.getByTestId("min-element-size").fill(String(MESH / 10));
  const before = await studyState(page);
  expect(
    before.groupFaces.flat().every((id) => id !== undefined),
    "every support and load entry is a whole CAD face",
  ).toBe(true);

  // Studies → + Add → Mesh refinement, on the example's static study.
  await openTree(page, "refinement");
  await expect(page.getByTestId("study-static-case")).toHaveValue("1");
  await page.getByTestId("refinement-study-run").click();

  // Run hands off to Results → Mesh refinement straight away: the convergence
  // chart fills the centre while the levels land one after the other on the
  // right.
  await expect(page.getByTestId("panel-title")).toHaveText("Mesh refinement");
  // The study is "Mesh refinement 1"; its result is "Mesh refinement".
  await expect(
    page.locator("nav").getByText("Mesh refinement", { exact: true }),
  ).toBeVisible();
  const chart = page.getByTestId("refinement-chart");
  await expect(chart).toBeVisible();
  const rows = page.getByTestId("refinement-study-level");
  await expect(rows).toHaveCount(3);
  const verdict = page.getByTestId("refinement-study-verdict");
  await expect(verdict).toBeVisible();
  // Every level is a point on the chart.
  await expect(chart.getByTestId("refinement-chart-point")).toHaveCount(3);
  await expect(page.getByTestId("refinement-study-error")).toHaveCount(0);

  // Each level is finer than the one before: a smaller size, more elements.
  const levels = await rows.evaluateAll((trs) =>
    trs.map((tr) => ({
      size: Number(tr.getAttribute("data-size")),
      elements: Number(tr.getAttribute("data-elements")),
      maxDisplacement: Number(tr.getAttribute("data-max-displacement")),
    })),
  );
  expect(levels[0].size).toBeCloseTo(MESH, 9);
  expect(levels[1].size).toBeCloseTo(MESH / Math.SQRT2, 9);
  expect(levels[2].size).toBeCloseTo(MESH / 2, 9);
  expect(levels[1].elements).toBeGreaterThan(levels[0].elements);
  expect(levels[2].elements).toBeGreaterThan(levels[1].elements);
  for (const l of levels) expect(l.maxDisplacement).toBeGreaterThan(0);
  // Linear tets are too stiff and soften as they refine.
  expect(levels[1].maxDisplacement).toBeGreaterThan(levels[0].maxDisplacement);
  expect(levels[2].maxDisplacement).toBeGreaterThan(levels[1].maxDisplacement);
  await expect(verdict).toHaveText(/^(Converged|Not converged): max \|U\|/);

  // The model ends on the finest mesh with its result, the supports and loads
  // on the same CAD faces, and the mesh settings as the user typed them.
  const after = await studyState(page);
  expect(after.hasResult).toBe(true);
  expect(after.nodes).toBeGreaterThan(before.nodes);
  expect(after.groupFaces).toEqual(before.groupFaces);
  expect(after.remeshNotice).toBe(
    "Kept 2 support/load/tie groups on their CAD faces.",
  );
  expect(after.maxElementSize).toBe(before.maxElementSize);

  // Opening a level shows its mesh and result in 3D in place of the chart: it
  // becomes the model's mesh, with the supports and loads on it.
  const coarse = await rows.nth(0).getAttribute("data-nodes");
  await rows.nth(0).click();
  await expect(chart).toBeHidden();
  await expect(rows.nth(0)).toHaveAttribute("aria-current", "true");
  const opened = await studyState(page);
  expect(String(opened.nodes)).toBe(coarse);
  expect(opened.hasResult).toBe(true);
  expect(opened.groupFaces).toEqual(before.groupFaces);
  // Back to the chart.
  await page.getByTestId("refinement-chart-row").click();
  await expect(chart).toBeVisible();

  // An edit after the study makes its levels another model's: they lock, and
  // the panel says to run the study again.
  await page.evaluate(() =>
    (
      window as unknown as {
        __kofemStore: {
          getState(): {
            updateMaterial(id: number, patch: { young: number }): void;
          };
        };
      }
    ).__kofemStore
      .getState()
      .updateMaterial(1, { young: 70000 }),
  );
  await expect(page.getByTestId("refinement-study-stale")).toBeVisible();
  await expect(rows.nth(1)).toBeDisabled();
});

// A model without its geometry cannot be re-meshed: the study says why before
// anything is touched.
test("a model without geometry refuses the study before it starts", async ({
  page,
}) => {
  await bootstrapCantilever(page);
  await openTree(page, "refinement");
  await expect(page.getByTestId("refinement-study-run")).toBeDisabled();
  await expect(page.getByTestId("refinement-study-refusal")).toContainText(
    "geometry",
  );
});

type CouplingStore = {
  getState(): {
    nodes: { id: number }[];
    loadGroups: {
      id: number;
      faces: { cadFaceId?: number; nodeIds: number[]; label: string }[];
    }[];
    couplingGroups: {
      name: string;
      refNodeId: number;
      faces: { cadFaceId?: number }[];
    }[];
    deleteLoadGroup(id: number): void;
    createCouplingGroup(
      faces: {
        label: string;
        nodeIds: number[];
        geometry: "face";
        cadFaceId: number;
      }[],
      point: [number, number, number],
      kind: "kinematic" | "distributing",
      dofs: number[],
    ): void;
    createLoadGroup(
      faces: { label: string; nodeIds: number[]; geometry: "point" }[],
      dof: number,
      totalForce: number,
      kind: "force",
      components: [number, number, number],
    ): void;
  };
};

// KOF-422: a coupling on a whole CAD face follows the study onto every level.
// The tip load is moved onto the reference point of a coupling that grips the
// tip face; each level re-creates the point as a node of its mesh and the load
// stays on it.
test("a coupling and the load on its reference point follow every level @pipeline", async ({
  page,
}) => {
  await openExample(page);
  await openTree(page, "mesh");
  await page.getByTestId("max-element-size").fill(String(MESH));
  await page.getByTestId("min-element-size").fill(String(MESH / 10));
  await page.evaluate(() => {
    const store = (window as unknown as { __kofemStore: CouplingStore })
      .__kofemStore;
    const tip = store.getState().loadGroups[0];
    const face = tip.faces[0];
    if (face.cadFaceId === undefined) throw new Error("tip is no CAD face");
    store.getState().deleteLoadGroup(tip.id);
    store.getState().createCouplingGroup(
      [
        {
          label: face.label,
          nodeIds: face.nodeIds,
          geometry: "face",
          cadFaceId: face.cadFaceId,
        },
      ],
      [220, 20, 10],
      "distributing",
      [0, 1, 2, 3, 4, 5],
    );
    const ref = store.getState().couplingGroups[0].refNodeId;
    store
      .getState()
      .createLoadGroup(
        [{ label: "Point 1", nodeIds: [ref], geometry: "point" }],
        1,
        -1000,
        "force",
        [0, -1000, 0],
      );
  });

  await openTree(page, "refinement");
  await expect(page.getByTestId("refinement-study-refusal")).toHaveCount(0);
  await page.getByTestId("refinement-levels").fill("2");
  await page.getByTestId("refinement-study-run").click();

  const rows = page.getByTestId("refinement-study-level");
  await expect(page.getByTestId("refinement-study-verdict")).toBeVisible();
  await expect(page.getByTestId("refinement-study-error")).toHaveCount(0);
  await expect(rows).toHaveCount(2);
  const levels = await rows.evaluateAll((trs) =>
    trs.map((tr) => ({
      nodes: Number(tr.getAttribute("data-nodes")),
      maxDisplacement: Number(tr.getAttribute("data-max-displacement")),
    })),
  );
  expect(levels[1].nodes).toBeGreaterThan(levels[0].nodes);
  for (const l of levels) expect(l.maxDisplacement).toBeGreaterThan(0);

  // On the finest mesh the coupling still grips the tip face, its reference
  // point is a node of that mesh, and the load sits on it.
  const after = await page.evaluate(() => {
    const st = (
      window as unknown as { __kofemStore: CouplingStore }
    ).__kofemStore.getState();
    const coupling = st.couplingGroups[0];
    return {
      couplings: st.couplingGroups.length,
      faces: coupling.faces.map((f) => f.cadFaceId !== undefined),
      refIsNode: st.nodes.some((n) => n.id === coupling.refNodeId),
      loadOnRef: st.loadGroups[0].faces[0].nodeIds[0] === coupling.refNodeId,
    };
  });
  expect(after).toEqual({
    couplings: 1,
    faces: [true],
    refIsNode: true,
    loadOnRef: true,
  });
});

// KOF-424: the study's settings are the user's: the number of levels, how much
// finer each is and the target error. The static case's checks are not
// repeated here.
test("the levels, the ratio and the target are editable settings @pipeline", async ({
  page,
}) => {
  await openExample(page);
  await openTree(page, "mesh");
  await page.getByTestId("max-element-size").fill(String(MESH));
  await page.getByTestId("min-element-size").fill(String(MESH / 10));
  await openTree(page, "refinement");

  await expect(page.getByText("Pre-flight check")).toHaveCount(0);
  const plan = page.getByTestId("refinement-study-plan");
  await expect(plan).toHaveText(
    "Solves at 16, 11.3 and 8 mm and checks that the result settles.",
  );

  await page.getByTestId("refinement-levels").fill("4");
  await page.getByTestId("refinement-ratio").selectOption("2");
  await expect(plan).toHaveText(
    "Solves at 16, 8, 4 and 2 mm and checks that the result settles.",
  );

  const run = page.getByTestId("refinement-study-run");
  await expect(run).toBeEnabled();
  await page.getByTestId("refinement-levels").fill("9");
  await expect(
    page.getByText("Levels is a whole number from 2 to 6."),
  ).toBeVisible();
  await expect(run).toBeDisabled();
  await page.getByTestId("refinement-levels").fill("3");
  await page.getByTestId("refinement-tolerance").fill("0");
  await expect(page.getByText("The target is 0.1 to 20 %.")).toBeVisible();
  await expect(run).toBeDisabled();
  await page.getByTestId("refinement-tolerance").fill("5");
  await expect(run).toBeEnabled();
});
