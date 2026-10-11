// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef } from "react";

// What a boundary section (BCs, loads, ties, couplings) shows for the
// model-tree selection: the creation form ("+ Add") or a single object.
export type SectionFocus = { type: "add" } | { type: "item"; id: number };

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

// The id an object view opens its editor on, null otherwise.
export function focusedId(focus: SectionFocus): number | null {
  return focus.type === "item" ? focus.id : null;
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
