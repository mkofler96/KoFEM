// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Boundary condition, load, tie and coupling visualisation, composed from one
// focused layer each. Child order is draw order among equal renderOrders, so
// keep it: committed face highlights, ties, couplings, the live pick session,
// fixed-support markers, then load arrows. Every layer but the pick session
// hides in results mode.

import type { MeshTopology } from "./useMeshTopology";
import { BcFaceHighlights } from "./BcFaceHighlights";
import { TieOverlay } from "./TieOverlay";
import { CouplingOverlay } from "./CouplingOverlay";
import { PickHighlights } from "./PickHighlights";
import { BcNodeMarkers } from "./BcNodeMarkers";
import { LoadArrows } from "./LoadArrows";

interface BoundaryConditionLayerProps {
  topology: MeshTopology;
  showResult: boolean;
}

export function BoundaryConditionLayer({
  topology,
  showResult,
}: BoundaryConditionLayerProps) {
  return (
    <group>
      <BcFaceHighlights topology={topology} showResult={showResult} />
      <TieOverlay topology={topology} showResult={showResult} />
      <CouplingOverlay topology={topology} showResult={showResult} />
      <PickHighlights topology={topology} />
      <BcNodeMarkers topology={topology} showResult={showResult} />
      <LoadArrows topology={topology} showResult={showResult} />
    </group>
  );
}
