// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useModelStore } from "../../store/modelStore";
import {
  INTERFACE_TYPE_LABELS,
  INTERFACE_TYPES,
  isInterfaceActive,
  type InterfaceType,
} from "../../lib/interfaces";
import styles from "./Panel.module.css";

const INTERFACE_TYPE_NOTES: Record<InterfaceType, string> = {
  bonded:
    "The bodies share mesh nodes on these faces and move together — the " +
    "standard linear model for welded, glued and bolted joints.",
};

// One body-to-body interface, opened from Boundary conditions in the model
// tree: its shared faces (highlighted in the viewport while it is open) and its
// type. Interfaces are detected from the geometry, not created, so they exist
// before any mesh and have no "+ Add" form.
export function InterfaceSection({ id }: { id: number }) {
  const iface = useModelStore((s) => s.interfaces?.find((i) => i.id === id));
  const properties = useModelStore((s) => s.properties);
  const setInterfaceType = useModelStore((s) => s.setInterfaceType);
  if (!iface) return null;
  const active = isInterfaceActive(iface, properties);
  return (
    <>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>Shared faces</span>
        <span data-testid={`interface-faces-${iface.id}`}>
          {iface.faceIds.length}
        </span>
      </div>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>Type</span>
        <select
          className={styles.formSelect}
          data-testid={`interface-type-${iface.id}`}
          value={iface.type}
          onChange={(e) =>
            setInterfaceType(iface.id, e.target.value as InterfaceType)
          }
        >
          {INTERFACE_TYPES.map((t) => (
            <option key={t} value={t}>
              {INTERFACE_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </div>
      <p className={styles.formNote}>{INTERFACE_TYPE_NOTES[iface.type]}</p>
      {!active && (
        <p className={styles.formNote} data-testid="interface-inactive-note">
          Inactive — one of its bodies is suppressed.
        </p>
      )}
    </>
  );
}
