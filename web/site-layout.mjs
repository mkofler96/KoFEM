// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The light/dark switch, on pages that have both themes (the example pages).
// Hidden until the page's script wires it up.
const THEME_BUTTON = `<button type="button" class="site-theme" hidden aria-label="Switch to the dark theme">
          <svg class="site-theme-moon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"></path></svg>
          <svg class="site-theme-sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path></svg>
        </button>`;

export function siteHeader(current = "", { themeSwitch = false } = {}) {
  const active = (section) =>
    current === section ? ' aria-current="page"' : "";
  return `<header class="site-navigation">
      <a class="site-wordmark" href="/" aria-label="KoFEM home">KoFEM<span class="site-brand-dot">.</span></a>
      <nav class="site-links" aria-label="Main navigation">
        <a href="/examples/"${active("examples")}>Examples</a>
        <details class="site-more">
          <summary>More</summary>
          <div>
            <a href="/privacy/">Privacy</a>
            <a href="#cookie-settings" id="kofem-cookie-settings">Cookie settings</a>
          </div>
        </details>
        ${themeSwitch ? THEME_BUTTON : ""}
        <a class="site-github" href="https://github.com/mkofler96/KoFEM" target="_blank" rel="noopener" aria-label="KoFEM on GitHub">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.37.5 0 5.78 0 12.29c0 5.2 3.44 9.6 8.21 11.16.6.11.82-.25.82-.56 0-.28-.01-1.02-.02-2-3.34.71-4.04-1.58-4.04-1.58-.55-1.37-1.34-1.74-1.34-1.74-1.08-.72.08-.71.08-.71 1.2.08 1.83 1.21 1.83 1.21 1.07 1.79 2.81 1.27 3.5.97.11-.76.42-1.27.76-1.56-2.67-.3-5.47-1.3-5.47-5.78 0-1.28.47-2.32 1.24-3.14-.12-.3-.54-1.52.12-3.16 0 0 1.01-.32 3.3 1.2a11.6 11.6 0 0 1 6 0c2.29-1.52 3.3-1.2 3.3-1.2.66 1.64.24 2.86.12 3.16.77.82 1.24 1.86 1.24 3.14 0 4.49-2.81 5.47-5.49 5.76.43.36.81 1.08.81 2.18 0 1.58-.01 2.85-.01 3.24 0 .31.22.68.83.56A12.02 12.02 0 0 0 24 12.29C24 5.78 18.63.5 12 .5z"></path></svg>
        </a>
        <a class="site-launch" href="/app/">Start Solver <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-linecap="round" aria-hidden="true"><path d="M3 9 9 3M3 3h6v6"></path></svg></a>
      </nav>
    </header>`;
}

export function siteFooter() {
  return `<footer class="site-footer">
      <span>KoFEM — finite element analysis in your browser</span>
      <nav aria-label="Footer">
        <a href="/">Home</a>
        <a href="/examples/">Examples</a>
        <a href="/privacy/">Privacy</a>
        <a href="https://github.com/mkofler96/KoFEM">GitHub</a>
      </nav>
    </footer>`;
}

export function injectSiteLayout(html, path = "/") {
  const current = path.startsWith("/examples/") ? "examples" : "";
  return html
    .replace("<!-- site-header -->", siteHeader(current))
    .replace("<!-- site-footer -->", siteFooter());
}
