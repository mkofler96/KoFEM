// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { LanguageNotLoaded } from "./components/LanguageNotLoaded";
import { loadLocale } from "./i18n/loadLocale";
import { LOCALE_NAMES } from "./i18n/locale";
import { useLocaleStore } from "./i18n/useLocale";
import {
  sendToWorker,
  resetWorker,
  setProgressCallback,
  startEngine,
} from "./workers/sharedWorker";

// Exposed for Playwright tests — not part of the public API.
(
  window as Window & {
    __kofem?: {
      sendToWorker: typeof sendToWorker;
      resetWorker: typeof resetWorker;
      setProgressCallback: typeof setProgressCallback;
    };
  }
).__kofem = { sendToWorker, resetWorker, setProgressCallback };

// The workspace renders once its language has arrived, so it never shows
// English first. A language that cannot be fetched is reported as such; the
// workspace does not open in English in its place (KOF-471).
const container = document.getElementById("root");
if (!container) throw new Error("app/index.html has no #root element");
const root = ReactDOM.createRoot(container);
const { locale } = useLocaleStore.getState();
loadLocale(locale).then(
  () =>
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    ),
  (err: unknown) => {
    console.error(err);
    root.render(<LanguageNotLoaded language={LOCALE_NAMES[locale]} />);
  },
);

// Every workflow but viewing a pre-solved example needs the engine. Loading it
// now overlaps its download with the visitor picking a file; on first request
// the whole wait came after the pick (KOF-263).
startEngine();
