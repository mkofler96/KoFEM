// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { LOCALES, LOCALE_NAMES, isLocale } from "../../i18n/locale";
import { useLocaleStore, useT } from "../../i18n/useLocale";
import { topbarMessages } from "../../i18n/messages/topbar";
import topBarStyles from "./TopBar.module.css";
import styles from "./SiteMenu.module.css";

// The gear button of the top bar and its popover: the app's language
// (KOF-468), kept for the next visit.
export function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const locale = useLocaleStore((s) => s.locale);
  const setLocale = useLocaleStore((s) => s.setLocale);
  const text = useT(topbarMessages);
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

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        className={topBarStyles.iconBtn}
        title={text.settings}
        aria-label={text.settings}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
          <path
            d="M6.76 3.16L6.87 1.5h2.26l.11 1.66 1.31.54 1.25-1.1 1.6 1.6-1.1 1.25.54 1.31 1.66.11v2.26l-1.66.11-.54 1.31 1.1 1.25-1.6 1.6-1.25-1.1-1.31.54-.11 1.66H6.87l-.11-1.66-1.31-.54-1.25 1.1-1.6-1.6 1.1-1.25-.54-1.31-1.66-.11V6.87l1.66-.11.54-1.31-1.1-1.25 1.6-1.6 1.25 1.1z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
          <circle
            cx="8"
            cy="8"
            r="2.2"
            stroke="currentColor"
            strokeWidth="1.3"
          />
        </svg>
      </button>

      {open && (
        <div className={styles.menu} role="dialog" aria-label={text.settings}>
          <label className={styles.field}>
            <span>{text.language}</span>
            <select
              value={locale}
              onChange={(e) => {
                if (isLocale(e.target.value)) setLocale(e.target.value);
              }}
            >
              {LOCALES.map((l) => (
                <option key={l} value={l} lang={l}>
                  {LOCALE_NAMES[l]}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
