// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Deformation scale (KOF-383): the Results panel shows the real factor the
// displacements are drawn at, "×1 240 (auto)" by default, and the user can
// type one (1 is true scale), drag the log slider, or clear the box to return
// to the automatic factor. Every state is
// checked against the drawn result surface: its vertices sit at
// node + factor · displacement for the factor the panel shows.

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { drawnPositions, settleViewport } from "./fixtures/viewport";

const SURFACE = "result-surface";

type Store = {
  getState(): {
    nodes: { x: number; y: number; z: number }[];
    result: { displacements: ArrayLike<number> } | null;
  };
};

async function readModel(page: Page) {
  return page.evaluate(() => {
    const state = (
      window as unknown as { __kofemStore: Store }
    ).__kofemStore.getState();
    if (!state.result) throw new Error("no result in the store");
    return {
      nodes: state.nodes.map((n) => [n.x, n.y, n.z]),
      disp: Array.from(state.result.displacements),
    };
  });
}

// The factor the slider announces: "×1 240 (auto)" → 1240.
async function shownFactor(page: Page): Promise<number> {
  const text =
    (await page
      .getByLabel("Deformation scale")
      .getAttribute("aria-valuetext")) ?? "";
  const match = /^×([\d .]+)/u.exec(text);
  if (!match) throw new Error(`unexpected deformation readout "${text}"`);
  return Number(match[1].replace(/ /g, ""));
}

test("the deformation scale shows and sets the factor the result is drawn at @pipeline", async ({
  page,
}) => {
  await page.goto("/app/?example=axial-bar");
  await expect(page.locator("nav")).toBeVisible();
  const run = page.getByRole("button", { name: /Run static solve/ });
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.getByTestId("colorbar")).toBeVisible();

  const slider = page.getByLabel("Deformation scale");
  // What the slider announces: the factor and which preset, if any, it is.
  const readout = (text: string | RegExp) =>
    expect(slider).toHaveAttribute("aria-valuetext", text);
  const input = page.getByLabel("Deformation factor");

  // By default: the automatic factor, shown for what it is.
  await readout(/\(auto\)$/);
  const autoFactor = await shownFactor(page);
  // The bar stretches by 0.476 mm over 1000 mm: hundreds of times magnified.
  expect(autoFactor).toBeGreaterThan(100);
  await expect(input).toHaveValue(String(autoFactor));
  const drawnAtAuto = await drawnPositions(page, SURFACE);

  // 0 is the undeformed shape: the drawn vertices are node positions. Match
  // each vertex to its node once, by its undeformed coordinates.
  await slider.fill("0");
  await readout("×0 (undeformed)");
  const undeformed = await drawnPositions(page, SURFACE);
  const { nodes, disp } = await readModel(page);
  const key = (x: number, y: number, z: number) =>
    `${Math.fround(x)},${Math.fround(y)},${Math.fround(z)}`;
  const nodeAt = new Map(nodes.map(([x, y, z], i) => [key(x, y, z), i]));
  const vertexNode: number[] = [];
  for (let v = 0; v < undeformed.length; v += 3) {
    const i = nodeAt.get(
      key(undeformed[v], undeformed[v + 1], undeformed[v + 2]),
    );
    if (i === undefined)
      throw new Error(`drawn vertex ${v / 3} is not at any node`);
    vertexNode.push(i);
  }
  expect(vertexNode.length).toBeGreaterThan(0);

  // The factor the drawn surface applies: the least-squares fit of
  // drawn − node = factor · displacement over every vertex.
  const drawnFactor = (drawn: number[]): number => {
    expect(drawn.length).toBe(undeformed.length);
    let num = 0;
    let den = 0;
    vertexNode.forEach((i, v) => {
      for (let k = 0; k < 3; k++) {
        const comp = disp[3 * i + k];
        num += (drawn[3 * v + k] - nodes[i][k]) * comp;
        den += comp * comp;
      }
    });
    return num / den;
  };
  expect(drawnFactor(undeformed)).toBeCloseTo(0, 4);
  expect(drawnFactor(drawnAtAuto) / autoFactor).toBeCloseTo(1, 4);

  // A typed factor is drawn as typed.
  await input.fill("2500");
  await readout("×2 500");
  expect(drawnFactor(await drawnPositions(page, SURFACE)) / 2500).toBeCloseTo(
    1,
    4,
  );

  // True scale: the real displacements.
  await input.fill("1");
  await readout("×1 (true scale)");
  expect(drawnFactor(await drawnPositions(page, SURFACE))).toBeCloseTo(1, 2);

  // The slider is logarithmic: one decade per step of 1 above true scale.
  await slider.fill("4");
  await readout("×1 000");
  expect(drawnFactor(await drawnPositions(page, SURFACE)) / 1000).toBeCloseTo(
    1,
    4,
  );

  // A factor that is not a number of 0 or more is refused and changes nothing.
  await input.fill("-3");
  await input.press("Enter");
  await expect(page.getByTestId("deform-scale-error")).toBeVisible();
  await readout("×1 000");

  // A cleared box returns to the automatic factor.
  await input.fill("");
  await input.press("Enter");
  await readout(
    `×${autoFactor.toLocaleString("en-US").replace(/,/g, " ")} (auto)`,
  );
  await expect(page.getByTestId("deform-scale-error")).toHaveCount(0);
  await settleViewport(page);
  expect(
    drawnFactor(await drawnPositions(page, SURFACE)) / autoFactor,
  ).toBeCloseTo(1, 4);
});
