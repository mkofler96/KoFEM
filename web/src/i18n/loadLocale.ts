// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { catalogsHave } from "./messages";
import { LOCALE_NAMES, type Locale } from "./locale";

// Each language's text of every catalog, split off by vite-locales.ts and
// fetched only when the app speaks it (KOF-471).
const CHUNKS: Record<Exclude<Locale, "en">, () => Promise<unknown>> = {
  de: () => import("./locales/de"),
  fr: () => import("./locales/fr"),
  it: () => import("./locales/it"),
  es: () => import("./locales/es"),
  pt: () => import("./locales/pt"),
};

const loading = new Map<Locale, Promise<void>>();
const loaded = new Set<Locale>(["en"]);

// Whether `tr()` can speak the language now.
export function isLocaleLoaded(locale: Locale): boolean {
  return loaded.has(locale);
}

// Outside the app's build (bun tests) the catalogs carry every language as
// written, and there is nothing to fetch.
async function fetchLocale(locale: Exclude<Locale, "en">): Promise<void> {
  if (catalogsHave(locale)) return;
  try {
    await CHUNKS[locale]();
  } catch (err) {
    throw new Error(
      `The ${LOCALE_NAMES[locale]} text of KoFEM could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!catalogsHave(locale))
    throw new Error(`The ${LOCALE_NAMES[locale]} text of KoFEM is incomplete`);
}

// Fetches the language's text once; a failed fetch is tried again on the
// next call.
export function loadLocale(locale: Locale): Promise<void> {
  if (locale === "en") return Promise.resolve();
  const known = loading.get(locale);
  if (known) return known;
  const pending = fetchLocale(locale).then(() => {
    loaded.add(locale);
  });
  loading.set(locale, pending);
  pending.catch(() => loading.delete(locale));
  return pending;
}
