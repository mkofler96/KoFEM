// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, type Page } from "@playwright/test";

// Model-tree navigation. The dividers (Geometry, Mesh, …) only collapse; the
// entries under them open their editor in the properties panel, and each group
// ends in "+ Add".

type StudyKind = "static" | "topopt";

// The id of the first study of `kind`, or null.
function studyId(page: Page, kind: StudyKind): Promise<number | null> {
  return page.evaluate((k) => {
    const state = (
      window as unknown as {
        __kofemStore: {
          getState(): { studies: { id: number; kind: string }[] };
        };
      }
    ).__kofemStore.getState();
    return state.studies.find((st) => st.kind === k)?.id ?? null;
  }, kind);
}

// Open a study of `kind`, adding it through Studies → + Add when the model has
// none yet — an optimization on the first static study, added first if needed.
async function openStudy(page: Page, kind: StudyKind): Promise<void> {
  const existing = await studyId(page, kind);
  if (existing !== null) {
    await page.getByTestId(`tree-study-${existing}`).click();
    return;
  }
  if (kind === "topopt" && (await studyId(page, "static")) === null)
    await openStudy(page, "static");
  await page.getByTestId("tree-add-studies").click();
  if (kind === "static") await page.getByTestId("add-study-static").click();
  else {
    await page.getByTestId("add-study-topopt").click();
    await page.getByTestId("add-study-create").click();
  }
  await expect(page.getByTestId("panel-title")).toHaveText(
    /^(Static|Optimization) \d+$/,
  );
}

// Open a step's editor: the mesh controls (the mesh, or Mesh → + Add before
// there is one), the split tool (an edit of Body 1), or a study.
export async function openTree(
  page: Page,
  view: "split" | "mesh" | StudyKind,
): Promise<void> {
  if (view === "split") {
    await openBody(page, 1);
    return;
  }
  if (view === "mesh") {
    const mesh = page.getByTestId("tree-mesh-1");
    await (
      (await mesh.count()) > 0 ? mesh : page.getByTestId("tree-add-mesh")
    ).click();
    return;
  }
  await openStudy(page, view);
}

// Boundary conditions → + Add → <kind>. The creation pick starts right away.
export async function addBoundary(
  page: Page,
  kind: "bc" | "load" | "tie" | "coupling",
): Promise<void> {
  await page.getByTestId("tree-add-boundary").click();
  await page.getByTestId(`add-boundary-${kind}`).click();
}

// Materials → + Add: the new-material form.
export async function addMaterial(page: Page): Promise<void> {
  await page.getByTestId("tree-add-materials").click();
}

// Geometry → Body <id>: that body's visibility, material, element type and
// the split tool.
export async function openBody(page: Page, id: number): Promise<void> {
  await page.getByTestId(`tree-body-${id}`).click();
  // Hovering a body entry highlights the body (others dim); leave the entry so
  // the viewport shows the model as it is.
  await page.mouse.move(0, 0);
}

// Geometry → Body <id> → Element type: the per-body Solid / Shell choice, the
// only way a body becomes shells.
export async function setElementType(
  page: Page,
  id: number,
  type: "solid" | "shell",
): Promise<void> {
  await openBody(page, id);
  await page.getByTestId(`body-type-${id}`).selectOption(type);
}
