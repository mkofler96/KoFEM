// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { rememberBuilt, rememberFixed } from "./english";
import { LOCALES, LOCALE_NAMES, type Locale } from "./locale";

// A message is text, or a function that builds it from counts and names, so
// each language places them and forms its plurals its own way. Arguments are
// strings and numbers only.
export type Message = string | ((...args: never[]) => string);

// A message's type is `string`, or a function returning `string`, not the
// literals the English happens to return, so a translation may say something
// else.
type Widen<M extends Message> = M extends (...args: infer A) => string
  ? (...args: A) => string
  : string;

// One message in every language, written together so a change to the English
// sits next to the translations it makes stale. English fixes the argument
// types; every other language must have the message with the same signature.
export type Translations<M extends Message> = { en: M } & {
  [L in Exclude<Locale, "en">]: NoInfer<Widen<M>>;
};

// A part of the UI's messages, looked up by language: `catalog.de.nodes`.
export type Catalog<M extends Record<string, Message>> = Record<
  Locale,
  { [K in keyof M]: Widen<M[K]> }
>;

export type AnyCatalog = Catalog<Record<string, Message>>;

type Built = (...args: unknown[]) => string;

// The messages as written, for the checks that read their source
// (scripts/i18n-lock.ts, tests/unit/i18n.test.ts): a catalog's functions
// are wrappers that also remember their English (./english).
const written = new WeakMap<object, Record<string, Translations<Message>>>();

export function writtenMessages(
  catalog: AnyCatalog,
): Record<string, Translations<Message>> {
  const messages = written.get(catalog);
  if (!messages) throw new Error("Not a catalog made by defineMessages");
  return messages;
}

// Every catalog defined so far, so a language's arrival can be checked
// against all of them.
const catalogs = new Set<Partial<Record<Locale, Record<string, Message>>>>();

export function defineMessages<M extends Record<string, Message>>(messages: {
  [K in keyof M]: Translations<M[K]>;
}): Catalog<M> {
  const catalog: Partial<Record<Locale, Record<string, Message>>> = {};
  const all = Object.values<Partial<Translations<Message>>>(messages);
  catalog.en = Object.fromEntries(
    Object.entries<Translations<Message>>(messages).map(([key, t]) => [
      key,
      t.en,
    ]),
  );
  catalogs.add(catalog);
  written.set(catalog, messages);
  // The source as written carries every language; the app's build carries
  // English here and the rest in one chunk per language (vite-locales.ts).
  for (const locale of LOCALES) {
    if (locale === "en" || !all.some((t) => locale in t)) continue;
    addTranslations(
      catalog as AnyCatalog,
      locale,
      Object.fromEntries(
        Object.entries<Translations<Message>>(messages).map(([key, t]) => [
          key,
          t[locale],
        ]),
      ),
    );
  }
  return catalog as Catalog<M>;
}

// One language's text of a catalog, checked against its English.
export function addTranslations(
  target: AnyCatalog,
  locale: Exclude<Locale, "en">,
  texts: Record<string, Message | undefined>,
): void {
  const catalog: Partial<Record<Locale, Record<string, Message>>> = target;
  const english = catalog.en;
  if (!english || !catalogs.has(catalog))
    throw new Error("Not a catalog made by defineMessages");
  const inLocale: Record<string, Message> = {};
  for (const [key, source] of Object.entries(english)) {
    const shown = texts[key];
    if (typeof shown === "string" && typeof source === "string") {
      rememberFixed(shown, source);
      inLocale[key] = shown;
    } else if (typeof shown === "function" && typeof source === "function")
      inLocale[key] = (...args: unknown[]) => {
        const text = (shown as Built)(...args);
        rememberBuilt(text, (source as Built)(...args));
        return text;
      };
    else
      throw new Error(
        shown === undefined
          ? `${locale}.${key} is missing`
          : `${locale}.${key} is not the kind of message en.${key} is`,
      );
  }
  catalog[locale] = inLocale;
}

// Whether catalogs are defined and every one has the language's text.
export function catalogsHave(locale: Locale): boolean {
  return (
    catalogs.size > 0 &&
    [...catalogs].every((catalog) => catalog[locale] !== undefined)
  );
}

// The catalog's messages in a language, or an error naming the language when
// its text has not arrived: the app never shows English in its place.
export function inLocale<C extends AnyCatalog>(
  catalog: C,
  locale: Locale,
): C[Locale] {
  const messages: C[Locale] | undefined = (
    catalog as Partial<Record<Locale, C[Locale]>>
  )[locale];
  if (messages === undefined)
    throw new Error(`The ${LOCALE_NAMES[locale]} text is not loaded`);
  return messages;
}
