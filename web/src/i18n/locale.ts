// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The languages the app speaks (KOF-468). English is the source every
// catalog is written in first, and the language for a browser that asks for
// none of the others. Portuguese is Brazilian Portuguese, the variant most
// of its speakers read.
export const LOCALES = ["en", "de", "fr", "it", "es", "pt"] as const;
export type Locale = (typeof LOCALES)[number];

// Each language by its own name, as a speaker looks for it in a list.
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  de: "Deutsch",
  fr: "Français",
  it: "Italiano",
  es: "Español",
  pt: "Português",
};

// The tag `Intl` and `toLocaleString` format numbers with: "12,345" in
// English, "12.345" in German.
export const INTL_TAGS: Record<Locale, string> = {
  en: "en-US",
  de: "de-DE",
  fr: "fr-FR",
  it: "it-IT",
  es: "es-ES",
  pt: "pt-BR",
};

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

// The language chosen in the app, else the first of the browser's preferred
// languages the app speaks ("pt-BR" is Portuguese), else English. A stored
// value from a language since removed is no choice.
export function pickLocale(
  stored: string | null,
  browserLanguages: readonly string[],
): Locale {
  if (stored !== null && isLocale(stored)) return stored;
  for (const tag of browserLanguages) {
    const language = tag.split("-")[0].toLowerCase();
    if (isLocale(language)) return language;
  }
  return "en";
}
