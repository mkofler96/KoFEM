// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Page } from "@playwright/test";
import { openTree } from "./tree";

// Put the panel in the meshable state without paying for a real STEP import:
// a tessellated surface plus retained bytes is exactly what an import leaves
// behind, and it is what makes the mesh controls render. Goes through the
// store's import actions, which also start the sizes at the suggestion.
export async function fakeImport(page: Page) {
  await page.evaluate(() => {
    const store = (
      window as unknown as {
        __kofemStore: {
          getState(): {
            setStepSurface(t: {
              points: number[][];
              triangles: number[][];
            }): void;
            setStepBytes(bytes: Uint8Array): void;
          };
        };
      }
    ).__kofemStore.getState();
    // A 1 mm cube, the part from the issue: two triangles per face.
    store.setStepSurface({
      points: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
        [0, 0, 1],
        [1, 0, 1],
        [1, 1, 1],
        [0, 1, 1],
      ],
      triangles: [
        [0, 2, 1],
        [0, 3, 2],
        [4, 5, 6],
        [4, 6, 7],
        [0, 1, 5],
        [0, 5, 4],
        [3, 7, 6],
        [3, 6, 2],
        [0, 4, 7],
        [0, 7, 3],
        [1, 2, 6],
        [1, 6, 5],
      ],
    });
    store.setStepBytes(new Uint8Array([1, 2, 3]));
  });
  // A real import lands on the mesh entry; the injected one has to go there.
  await openTree(page, "mesh");
}
