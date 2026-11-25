// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { create } from "zustand";
import { INTL_TAGS, pickLocale, type Locale } from "./locale";
import { inLocale, type AnyCatalog } from "./messages";
import { loadLocale } from "./loadLocale";

const LOCALE_KEY = "kofem.locale";

// localStorage throws where the browser blocks storage (some private modes);
// outside a browser (bun tests) there is neither storage nor a browser
// language, and the app speaks English.
function storedLocale(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(LOCALE_KEY);
  } catch {
    return null;
  }
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined" || !navigator.languages) return [];
  return navigator.languages;
}

function markDocument(locale: Locale): void {
  if (typeof document !== "undefined") document.documentElement.lang = locale;
}

interface LocaleState {
  locale: Locale;
  // Switches once the language's text has arrived; rejects, keeping the
  // current language, when it cannot be fetched.
  setLocale: (locale: Locale) => Promise<void>;
}

// The latest language asked for: a slower fetch of an earlier pick must not
// switch the app after it.
let requested: Locale | null = null;

// The app's entry loads this language before it renders (main.tsx).
export const useLocaleStore = create<LocaleState>((set) => ({
  locale: pickLocale(storedLocale(), browserLanguages()),
  setLocale: async (locale) => {
    requested = locale;
    await loadLocale(locale);
    if (requested !== locale) return;
    try {
      localStorage.setItem(LOCALE_KEY, locale);
    } catch {
      // Blocked storage: the language holds for this visit only.
    }
    markDocument(locale);
    set({ locale });
  },
}));

markDocument(useLocaleStore.getState().locale);

export function useLocale(): Locale {
  return useLocaleStore((s) => s.locale);
}

// The catalog's messages in the current language, re-rendering on a change.
export function useT<C extends AnyCatalog>(catalog: C): C[Locale] {
  return inLocale(catalog, useLocale());
}

// The same outside React: text a store action or a library function builds
// is in the language current when it is built.
export function tr<C extends AnyCatalog>(catalog: C): C[Locale] {
  return inLocale(catalog, useLocaleStore.getState().locale);
}

// For `toLocaleString` and `Intl` number formats in the current language.
export function useIntlTag(): string {
  return INTL_TAGS[useLocale()];
}

export function intlTag(): string {
  return INTL_TAGS[useLocaleStore.getState().locale];
}
