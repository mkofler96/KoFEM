// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import panelStyles from "../panel/Panel.module.css";

// The last error message the UI put on screen, for a bug report's diagnostics.
// Panel errors live in component state all over the sidebar; rather than
// thread each one to a registry, this watches the DOM for the two ways they are
// shown — the panels' error banner and the CAD import error line — and keeps
// the latest text in memory. It is never stored or sent anywhere.

const BANNER = `.${CSS.escape(panelStyles.errorBanner)}`;
const SELECTOR = `${BANNER}, [data-testid="step-error"]`;

let last: string | null = null;

// A banner is the message plus its dismiss button; take the message only.
function messageOf(el: Element): string {
  return Array.from(el.childNodes)
    .filter((n) => !(n instanceof HTMLButtonElement))
    .map((n) => n.textContent)
    .join(" ")
    .trim();
}

function note(el: Element) {
  const text = messageOf(el);
  if (text) last = text;
}

/** Start watching for shown errors; returns the function that stops it. */
export function watchShownErrors(): () => void {
  document.querySelectorAll(SELECTOR).forEach(note);
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      // New text in a banner that stays on screen: React rewrites the text
      // node in place, or replaces it.
      const parent =
        r.target instanceof Element ? r.target : r.target.parentElement;
      const host = parent?.closest(SELECTOR);
      if (host) {
        note(host);
        continue;
      }
      for (const added of r.addedNodes) {
        if (!(added instanceof Element)) continue;
        if (added.matches(SELECTOR)) note(added);
        else added.querySelectorAll(SELECTOR).forEach(note);
      }
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  return () => observer.disconnect();
}

export function lastShownError(): string | null {
  return last;
}
