// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// What the analysis report embeds besides its content (KOF-391): its fonts
// and the KoFEM logo, read from the app's own self-hosted copies
// (public/fonts, public/kofem_logo.svg) and inlined, so the saved file shows
// the same on any machine and fetches nothing.

import { tr } from "../../i18n/useLocale";
import { reportMessages } from "../../i18n/messages/report";

export interface ReportAssets {
  // @font-face rules with the fonts as data URLs.
  fontCss: string;
  // The logo's <svg> element.
  logo: string;
}

// [family, weight, file in public/fonts]: text, headings, symbols and numbers.
const FONTS: [string, number, string][] = [
  ["STIX Two Text", 400, "stix-two-text-400-latin.woff2"],
  ["STIX Two Text", 600, "stix-two-text-600-latin.woff2"],
  ["Caladea", 700, "caladea-700-latin.woff2"],
  ["KoFEM Math", 400, "kofem-math.woff2"],
];

async function fetchOk(path: string): Promise<Response> {
  const response = await fetch(path);
  if (!response.ok)
    throw new Error(tr(reportMessages).assetMissing(path, response.status));
  return response;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

export async function loadReportAssets(): Promise<ReportAssets> {
  const faces = await Promise.all(
    FONTS.map(async ([family, weight, file]) => {
      const bytes = new Uint8Array(
        await (await fetchOk(`/fonts/${file}`)).arrayBuffer(),
      );
      return `@font-face{font-family:"${family}";font-weight:${weight};src:url(data:font/woff2;base64,${base64(bytes)}) format("woff2")}`;
    }),
  );
  const svg = await (await fetchOk("/kofem_logo.svg")).text();
  const start = svg.indexOf("<svg");
  if (start < 0)
    throw new Error(tr(reportMessages).assetMissing("/kofem_logo.svg", 200));
  return { fontCss: faces.join("\n"), logo: svg.slice(start) };
}
