// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Locale } from "./locale";

// A message is text, or a function that builds it from counts and names, so
// each language places them and forms its plurals its own way. Arguments are
// strings and numbers only.
export type Message = string | ((...args: never[]) => string);

// One part of the UI in every language. English fixes the keys and the
// argument types; the type then requires every other language to have each
// message with the same signature.
export type Catalog<M extends Record<string, Message>> = { en: M } & {
  [L in Exclude<Locale, "en">]: NoInfer<M>;
};

export function defineMessages<M extends Record<string, Message>>(
  catalog: Catalog<M>,
): Catalog<M> {
  return catalog;
}
