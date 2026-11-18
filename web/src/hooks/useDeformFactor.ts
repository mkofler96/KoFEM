// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The deformation factor of the result view (KOF-383): `factor` is what the
// viewport multiplies the displacements by and what the Results panel shows,
// so both read it here. `autoFactor` is the factor "Auto" would apply.

import { useMemo } from "react";
import { useModelStore } from "../store/modelStore";
import {
  appliedDeformFactor,
  autoDeformFactor,
  modelExtent,
  type DeformScale,
} from "../lib/deformScale";

export interface DeformFactor {
  factor: number;
  autoFactor: number;
  scale: DeformScale;
}

export function useDeformFactor(): DeformFactor {
  const nodes = useModelStore((s) => s.nodes);
  const result = useModelStore((s) => s.result);
  const scale = useModelStore((s) => s.deformScale);
  const modelSize = useMemo(() => modelExtent(nodes), [nodes]);
  const displacements = result?.displacements;
  return useMemo(() => {
    // Without a result nothing is drawn deformed; true scale is the neutral
    // value for "Auto".
    const disp = displacements ?? [];
    return {
      factor: appliedDeformFactor(scale, disp, modelSize),
      autoFactor: autoDeformFactor(disp, modelSize),
      scale,
    };
  }, [displacements, modelSize, scale]);
}
