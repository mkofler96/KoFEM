// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useModelStore } from "../../store/modelStore";
import {
  describeUnderResolvedWall,
  type UnderResolvedWall,
} from "../../lib/thinWallCheck";
import styles from "./Panel.module.css";

// The cantilever example's convergence study: linear vs. quadratic elements
// in bending, side by side.
const WHY_URL = "/examples/cantilever/";

// Thin walls with too few linear elements through them (KOF-274). Before the
// solve it offers the fix; on a result it says the result is too stiff.
export function ThinWallNotice({
  walls,
  stage,
}: {
  walls: UnderResolvedWall[];
  stage: "preflight" | "result";
}) {
  const setElementOrder = useModelStore((s) => s.setElementOrder);
  const isRunning = useModelStore((s) => s.isRunning);
  const elementOrder = useModelStore((s) => s.elementOrder);
  if (walls.length === 0) return null;
  return (
    <div className={styles.thinWallNote} data-testid={`thin-wall-${stage}`}>
      <p>
        {stage === "preflight"
          ? "Linear elements are too stiff in bending on thin walls: deflection and stress will come out low."
          : "Solved with linear elements on thin walls: deflection and stress are likely too low."}
      </p>
      <ul>
        {walls.map((wall) => (
          <li key={wall.bodyId}>{describeUnderResolvedWall(wall)}</li>
        ))}
      </ul>
      <p>
        Quadratic elements need one element through a wall, so a coarser mesh
        keeps the solve fast. Shell elements also work for thin bodies.{" "}
        <a href={WHY_URL} target="_blank" rel="noopener">
          Why?
        </a>
      </p>
      {/* A linear result stays linear after the setting changes; the button
          only shows while there is still a setting to change. */}
      {elementOrder === 1 && (
        <button
          className={styles.outlineBtn}
          data-testid="use-quadratic"
          disabled={isRunning}
          onClick={() => setElementOrder(2)}
        >
          Use quadratic elements
        </button>
      )}
    </div>
  );
}
