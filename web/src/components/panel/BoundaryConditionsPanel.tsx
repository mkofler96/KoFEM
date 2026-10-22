// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useModelStore } from "../../store/modelStore";
import type { BoundaryKind, TreeTarget } from "../../store/viewSlice";
import { BcSection } from "./BcSection";
import { LoadSection } from "./LoadSection";
import { TieSection } from "./TieSection";
import { CouplingSection } from "./CouplingSection";
import type { SectionFocus } from "./sectionFocus";
import styles from "./Panel.module.css";

export const BOUNDARY_KINDS: {
  kind: BoundaryKind;
  label: string;
  hint: string;
}[] = [
  { kind: "bc", label: "Support", hint: "Fixed or prescribed displacement" },
  { kind: "load", label: "Load", hint: "Force, moment or pressure" },
  { kind: "tie", label: "Tie", hint: "Bond two surfaces together" },
  {
    kind: "coupling",
    label: "Coupling",
    hint: "Connect a surface to a reference point",
  },
];

// What one section shows for the tree target: the creation form for
// "+ Add <kind>", one object for an item of its kind, nothing otherwise
// (undefined = not rendered).
function focusFor(
  target: TreeTarget,
  kind: BoundaryKind,
): SectionFocus | undefined {
  if (target.type === "add")
    return target.kind === kind ? { type: "add" } : undefined;
  if (target.type === "item" && target.kind === kind)
    return { type: "item", id: target.id, created: target.created };
  return undefined;
}

function AddChooser() {
  const selectTreeNode = useModelStore((s) => s.selectTreeNode);
  return (
    <div className={styles.addChooser}>
      {BOUNDARY_KINDS.map(({ kind, label, hint }) => (
        <button
          key={kind}
          className={styles.addChoice}
          data-testid={`add-boundary-${kind}`}
          onClick={() =>
            selectTreeNode({ group: "boundary", target: { type: "add", kind } })
          }
        >
          <span className={styles.addChoiceLabel}>{label}</span>
          <span className={styles.addChoiceHint}>{hint}</span>
        </button>
      ))}
    </div>
  );
}

export function BoundaryConditionsPanel({ target }: { target: TreeTarget }) {
  // Boundary conditions and loads reference mesh nodes, so they can only be
  // defined once a volume mesh exists.
  const meshOk = useModelStore((s) => s.nodes.length > 0);
  const [error, setError] = useState<string | null>(null);
  const bc = focusFor(target, "bc");
  const load = focusFor(target, "load");
  const tie = focusFor(target, "tie");
  const coupling = focusFor(target, "coupling");

  return (
    <div className={styles.panel}>
      <div className={styles.tabContent}>
        {error && (
          <div className={styles.errorBanner} data-testid="constraints-error">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}
        {!meshOk && (
          <div className={styles.empty} data-testid="no-mesh-hint">
            Generate a mesh before adding boundary conditions.
          </div>
        )}
        {meshOk && (
          <>
            {target.type === "add" && target.kind === null && <AddChooser />}
            {bc !== undefined && <BcSection onError={setError} focus={bc} />}
            {load !== undefined && (
              <LoadSection onError={setError} focus={load} />
            )}
            {tie !== undefined && <TieSection onError={setError} focus={tie} />}
            {coupling !== undefined && (
              <CouplingSection onError={setError} focus={coupling} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
