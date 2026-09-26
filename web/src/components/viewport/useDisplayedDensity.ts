// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useModelStore } from "../../store/modelStore";

// The density field the viewport should draw, or null for none. Two sources:
// the final run in Results when it is the active result (KOF-233), and the
// iteration streamed from a running optimization on the Optimize step
// (KOF-240). The scene and the density legend share this so they never disagree.
export function useDisplayedDensity(): Float64Array | null {
  const mode = useModelStore((s) => s.mode);
  const activeResult = useModelStore((s) => s.activeResult);
  const densityResult = useModelStore((s) => s.densityResult);
  const liveDensity = useModelStore((s) => s.liveDensity);
  const isOptimizing = useModelStore((s) => s.isOptimizing);

  if (mode === "results" && activeResult === "density" && densityResult)
    return densityResult.density;
  if (mode === "optimize" && isOptimizing && liveDensity)
    return liveDensity.density;
  return null;
}
