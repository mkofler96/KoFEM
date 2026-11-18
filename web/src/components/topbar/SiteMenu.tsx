// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useModelStore } from "../../store/modelStore";
import { useExampleLoad } from "../../lib/examples";
import { SITE_PAGES } from "../../lib/siteLinks";
import styles from "./SiteMenu.module.css";

// The way back to the public site (KOF-381), behind the "K" button at the
// right of the top bar: the examples, the theory and, when the app was opened
// from an example, that example's page. Home is the logo's link (TopBar). The
// links leave in the same tab, so an open analysis asks first, as "New analysis" does; a click
// that opens a new tab (Ctrl/Cmd/Shift, or the middle button, which fires no
// click) keeps the analysis and needs no question.

export function confirmLeave(e: MouseEvent<HTMLAnchorElement>): void {
  const newTab = e.ctrlKey || e.metaKey || e.shiftKey;
  if (newTab || !useModelStore.getState().hasStarted) return;
  if (
    !window.confirm(
      "Leave the app? Unsaved changes will be lost — save the current analysis first if you want to keep it.",
    )
  )
    e.preventDefault();
}

export function SiteMenu() {
  const [open, setOpen] = useState(false);
  const example = useExampleLoad((s) => s.opened);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(e: PointerEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function leave(e: MouseEvent<HTMLAnchorElement>) {
    confirmLeave(e);
    setOpen(false);
  }

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        className={styles.trigger}
        aria-label="Site menu"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Examples and theory"
        onClick={() => setOpen((o) => !o)}
      >
        K
      </button>

      {open && (
        <div className={styles.menu} role="menu" aria-label="Site">
          {example && (
            <a
              className={`${styles.item} ${styles.back}`}
              role="menuitem"
              href={`/examples/${example.id}/`}
              onClick={leave}
            >
              Back to {example.name}
            </a>
          )}
          {SITE_PAGES.filter((page) => page.section !== "home").map((page) => (
            <a
              key={page.href}
              className={styles.item}
              role="menuitem"
              href={page.href}
              onClick={leave}
            >
              {page.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
