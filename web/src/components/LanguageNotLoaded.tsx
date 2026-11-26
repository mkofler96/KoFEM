// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { topbarMessages } from "../i18n/messages/topbar";

// In place of the workspace when the visitor's language cannot be fetched at
// start. English is the only text the app holds without fetching.
export function LanguageNotLoaded({ language }: { language: string }) {
  return (
    <p
      role="alert"
      style={{ margin: "48px auto", maxWidth: 480, padding: "0 16px" }}
    >
      {topbarMessages.en.languageNotLoaded(language)}
    </p>
  );
}
