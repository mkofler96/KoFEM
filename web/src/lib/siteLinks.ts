// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The public site's main pages, in the order its footer lists them. The site
// header and footer (web/site-layout.mjs) and the app's site menu
// (components/topbar/SiteMenu.tsx) all read this list, so they do not drift.

export type SitePage = {
  readonly section: "home" | "examples" | "theory";
  readonly href: string;
  readonly label: string;
};

export const SITE_PAGES: readonly SitePage[] = [
  { section: "home", href: "/", label: "Home" },
  { section: "examples", href: "/examples/", label: "Examples" },
  { section: "theory", href: "/theory/", label: "Theory" },
];
