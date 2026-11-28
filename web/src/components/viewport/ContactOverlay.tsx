// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Contacts (KOF-485): the two surfaces of every contact, and of the contact
// being picked. A contact draws no links: where the surfaces touch is only
// known after the solve, and the results show it.

import { useMemo } from "react";
import { useModelStore } from "../../store/modelStore";
import { buildFacePositions } from "./useMeshTopology";
import type { MeshTopology } from "./useMeshTopology";
import { FaceOverlay } from "./FaceOverlay";

// Contact colours: surface A orange, surface B amber — apart from the tie's
// violet and teal, so a contact is not taken for a bond.
const CONTACT_COLOR_A = "#ea580c";
const CONTACT_COLOR_B = "#ca8a04";

interface ContactOverlayProps {
  topology: MeshTopology;
  showResult: boolean;
}

export function ContactOverlay({ topology, showResult }: ContactOverlayProps) {
  const contactGroups = useModelStore((s) => s.contactGroups);
  const pickMode = useModelStore((s) => s.pickMode);
  const tieDraft = useModelStore((s) => s.tieDraft);
  const { nodeMap, boundaryMeshTopo } = topology;

  // The parked side of a contact pick (the shared two-sided draft) is drawn
  // too: only one side is in the live pick session at a time.
  const highlights = useMemo(() => {
    if (!boundaryMeshTopo) return null;
    const out: { key: string; positions: Float32Array; side: "a" | "b" }[] = [];
    const add = (
      key: string,
      faces: { nodeIds: number[] }[],
      side: "a" | "b",
    ) => {
      faces.forEach((face, i) => {
        const positions = buildFacePositions(
          face.nodeIds,
          boundaryMeshTopo.triangles,
          nodeMap,
        );
        if (positions) out.push({ key: `${key}-${i}`, positions, side });
      });
    };
    for (const group of contactGroups) {
      add(`contact-${group.id}-a`, group.facesA, "a");
      add(`contact-${group.id}-b`, group.facesB, "b");
    }
    if (pickMode === "contact") {
      add("contact-draft-a", tieDraft.a, "a");
      add("contact-draft-b", tieDraft.b, "b");
    }
    return out;
  }, [contactGroups, pickMode, tieDraft, boundaryMeshTopo, nodeMap]);

  if (showResult || !highlights) return null;
  return highlights.map((highlight) => (
    <FaceOverlay
      key={highlight.key}
      positions={highlight.positions}
      color={highlight.side === "a" ? CONTACT_COLOR_A : CONTACT_COLOR_B}
      opacity={0.3}
      renderOrder={1}
    />
  ));
}
