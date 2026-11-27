// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useModelStore } from "../../store/modelStore";
import type { BoundaryKind, TreeTarget } from "../../store/viewSlice";
import { BcSection } from "./BcSection";
import { LoadSection } from "./LoadSection";
import { TemperatureSection } from "./TemperatureSection";
import { TieSection } from "./TieSection";
import { ContactSection } from "./ContactSection";
import { CouplingSection } from "./CouplingSection";
import { InterfaceSection } from "./InterfaceSection";
import type { SectionFocus } from "./sectionFocus";
import { useT } from "../../i18n/useLocale";
import { boundaryMessages } from "../../i18n/messages/boundary";
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
    kind: "contact",
    label: "Contact",
    hint: "Surfaces that press where they touch and can separate",
  },
  {
    kind: "coupling",
    label: "Coupling",
    hint: "Connect a surface to a reference point",
  },
  {
    kind: "temperature",
    label: "Temperature change",
    hint: "ΔT over the model, from a formula in x, y, z",
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

// BOUNDARY_KINDS in the current language.
export function useBoundaryKinds(): typeof BOUNDARY_KINDS {
  const text = useT(boundaryMessages);
  const translated: Record<BoundaryKind, { label: string; hint: string }> = {
    bc: { label: text.kindSupport, hint: text.kindSupportHint },
    load: { label: text.kindLoad, hint: text.kindLoadHint },
    tie: { label: text.kindTie, hint: text.kindTieHint },
    contact: { label: text.kindContact, hint: text.kindContactHint },
    coupling: { label: text.kindCoupling, hint: text.kindCouplingHint },
    temperature: {
      label: text.kindTemperature,
      hint: text.kindTemperatureHint,
    },
  };
  return BOUNDARY_KINDS.map(({ kind }) => ({ kind, ...translated[kind] }));
}

function AddChooser() {
  const selectTreeNode = useModelStore((s) => s.selectTreeNode);
  const kinds = useBoundaryKinds();
  return (
    <div className={styles.addChooser}>
      {kinds.map(({ kind, label, hint }) => (
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
  const text = useT(boundaryMessages);
  const bc = focusFor(target, "bc");
  const load = focusFor(target, "load");
  const tie = focusFor(target, "tie");
  const contact = focusFor(target, "contact");
  const coupling = focusFor(target, "coupling");
  // Interfaces come from the geometry, so they open with or without a mesh.
  const interfaceId =
    target.type === "item" && target.kind === "interface" ? target.id : null;

  return (
    <div className={styles.panel}>
      <div className={styles.tabContent}>
        {error && (
          <div className={styles.errorBanner} data-testid="constraints-error">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}
        {interfaceId !== null && <InterfaceSection id={interfaceId} />}
        {!meshOk && interfaceId === null && (
          <div className={styles.empty} data-testid="no-mesh-hint">
            {text.noMeshHint}
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
            {contact !== undefined && (
              <ContactSection onError={setError} focus={contact} />
            )}
            {coupling !== undefined && (
              <CouplingSection onError={setError} focus={coupling} />
            )}
            {focusFor(target, "temperature") !== undefined && (
              <TemperatureSection />
            )}
          </>
        )}
      </div>
    </div>
  );
}
