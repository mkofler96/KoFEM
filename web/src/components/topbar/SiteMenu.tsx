// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useModelStore } from "../../store/modelStore";
import { useExampleLoad } from "../../lib/examples";
import { SITE_PAGES } from "../../lib/siteLinks";
import { tr, useT } from "../../i18n/useLocale";
import { topbarMessages } from "../../i18n/messages/topbar";
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
  if (!window.confirm(tr(topbarMessages).confirmLeave)) e.preventDefault();
}

export function SiteMenu() {
  const [open, setOpen] = useState(false);
  const example = useExampleLoad((s) => s.opened);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const text = useT(topbarMessages);

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
        aria-label={text.siteMenu}
        aria-haspopup="menu"
        aria-expanded={open}
        title={text.siteMenuTitle}
        onClick={() => setOpen((o) => !o)}
      >
        K
      </button>

      {open && (
        <div className={styles.menu} role="menu" aria-label={text.site}>
          {example && (
            <a
              className={`${styles.item} ${styles.back}`}
              role="menuitem"
              href={`/examples/${example.id}/`}
              onClick={leave}
            >
              {text.backTo(example.name)}
            </a>
          )}
          {SITE_PAGES.map((page) =>
            page.section === "home" ? null : (
              <a
                key={page.href}
                className={styles.item}
                role="menuitem"
                href={page.href}
                onClick={leave}
              >
                {text[page.section]}
              </a>
            ),
          )}
        </div>
      )}
    </div>
  );
}
