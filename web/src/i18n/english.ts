// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Analytics sorts errors into categories by their English text
// (lib/analytics.ts), but the text a user sees may be in another language.
// Each translated message is remembered next to its English, so the English
// of a shown text can be recovered. Neither text leaves the browser.

// Every fixed translation, from the catalogs as they are defined. Shorter
// ones are words and labels, not errors, and would only garble the words of
// a longer text they happen to occur in.
const fixed = new Map<string, string>();
const FIXED_MIN_LENGTH = 12;

// The texts message functions built most recently, with counts and names in.
const built = new Map<string, string>();
const BUILT_KEPT = 500;

export function rememberFixed(shown: string, english: string): void {
  if (shown !== english && shown.length >= FIXED_MIN_LENGTH)
    fixed.set(shown, english);
}

export function rememberBuilt(shown: string, english: string): void {
  if (shown === english) return;
  built.delete(shown);
  built.set(shown, english);
  if (built.size > BUILT_KEPT) {
    const oldest = built.keys().next();
    if (!oldest.done) built.delete(oldest.value);
  }
}

// The text with every remembered translation in it put back into English,
// longest first, so a sentence is replaced whole before a phrase within it.
export function inEnglish(text: string): string {
  const found = [...built, ...fixed]
    .filter(([shown]) => text.includes(shown))
    .sort(([a], [b]) => b.length - a.length);
  let english = text;
  for (const [shown, source] of found)
    english = english.split(shown).join(source);
  return english;
}
