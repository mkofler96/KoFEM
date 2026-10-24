// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef } from "react";

// What a boundary section (BCs, loads, ties, couplings) shows for the
// model-tree selection: the creation form ("+ Add") or a single object —
// `created` when its "+ Add" form just made it.
export type SectionFocus =
  { type: "add" } | { type: "item"; id: number; created?: boolean };

export function showsItem(focus: SectionFocus, id: number): boolean {
  return focus.type === "item" && focus.id === id;
}

// A running pick session belongs to the view that started it: a new object's
// pick (target null) to the add view, an add-face pick to its object's view.
export function showsPick(
  focus: SectionFocus,
  targetId: number | null,
): boolean {
  return focus.type === "add" ? targetId === null : targetId === focus.id;
}

// The id an object view opens its editor on, null otherwise. Picking an object
// in the tree opens its editor; one just applied is already saved, so it shows
// as saved — no second confirmation.
export function focusedId(focus: SectionFocus): number | null {
  return focus.type === "item" && !focus.created ? focus.id : null;
}

// Entering the add view starts the creation pick right away, so "+ Add" in the
// tree is one click, not two. Runs once per mount.
export function useStartOnAdd(focus: SectionFocus, start: () => void): void {
  const pending = useRef(focus.type === "add");
  useEffect(() => {
    if (!pending.current) return;
    pending.current = false;
    start();
  });
}
