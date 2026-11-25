// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { rememberBuilt, rememberFixed } from "./english";
import { LOCALES, type Locale } from "./locale";

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

export function defineMessages<M extends Record<string, Message>>(messages: {
  [K in keyof M]: Translations<M[K]>;
}): Catalog<M> {
  const entries = Object.entries<Translations<Message>>(messages);
  const catalog = {} as Record<Locale, Record<string, Message>>;
  for (const locale of LOCALES) {
    const inLocale: Record<string, Message> = {};
    for (const [key, translations] of entries) {
      const shown = translations[locale];
      const english = translations.en;
      if (locale === "en") inLocale[key] = english;
      else if (typeof shown === "string" && typeof english === "string") {
        rememberFixed(shown, english);
        inLocale[key] = shown;
      } else if (typeof shown === "function" && typeof english === "function")
        inLocale[key] = (...args: unknown[]) => {
          const text = (shown as Built)(...args);
          rememberBuilt(text, (english as Built)(...args));
          return text;
        };
      else
        throw new Error(
          `${locale}.${key} is not the kind of message en.${key} is`,
        );
    }
    catalog[locale] = inLocale;
  }
  written.set(catalog, messages);
  return catalog as Catalog<M>;
}
