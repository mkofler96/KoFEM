// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PluginOption } from "vite";

// Google Analytics (GA4 / gtag.js), gated behind explicit opt-in consent.
//
// The measurement ID can be supplied two ways:
//   1. Build time — the VITE_GA_ID env var is baked into the HTML by Vite
//      (handy for local dev and fully-static hosts).
//   2. Run time — when VITE_GA_ID is NOT set at build time, the HTML ships the
//      GA_PLACEHOLDER token instead, and the Docker image fills it in at
//      container start from the runtime VITE_GA_ID env var (see
//      docker-entrypoint.d/40-kofem-ga-config.sh). This lets one prebuilt image
//      be configured — or left disabled — without a rebuild.
// If neither supplies an ID, the placeholder is never replaced and the loader
// stays inert: no banner, no gtag.js, no cookies.
//
// GA4 sets first-party cookies (_ga, _ga_<id>) that are NOT strictly
// necessary, so under GDPR / the ePrivacy directive they require prior
// consent. We therefore never load gtag.js until the visitor clicks "Accept".
// "Decline" (or a later opt-out via the footer "Cookie settings" link) sets
// Google's documented window['ga-disable-<ID>'] flag. The choice is persisted
// in localStorage under "kofem_analytics_consent".

// Token baked into the HTML when no build-time ID is given; replaced at runtime
// by the Docker entrypoint. Kept in sync with docker-entrypoint.d/40-kofem-ga-config.sh.
export const GA_PLACEHOLDER = "__KOFEM_GA_ID__";

const GA_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Build the consent banner + gated gtag.js loader. When `gaId` is provided it
 * is baked in; otherwise the placeholder is emitted for runtime substitution.
 * The block is injected verbatim before `</body>` on every page (see
 * `injectAnalytics`) and stays inert until a real measurement ID is present.
 */
export function analyticsSnippet(gaId: string | undefined): string {
  const raw = (gaId ?? "").trim();
  if (raw && !GA_ID_RE.test(raw)) {
    throw new Error(
      `VITE_GA_ID="${raw}" is not a valid GA measurement ID (expected characters [A-Za-z0-9_-], e.g. G-XXXXXXXXXX).`,
    );
  }
  const id = raw || GA_PLACEHOLDER;

  // The script uses string concatenation (no template literals) so it survives
  // esbuild's HTML minifier untouched and never collides with this TS template.
  return `
    <!-- Google Analytics (gtag.js) — loaded only after explicit consent. -->
    <style>
      #kofem-cookie-consent {
        position: fixed;
        left: 16px;
        right: 16px;
        bottom: 16px;
        z-index: 2147483000;
        margin: 0 auto;
        max-width: 660px;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 12px 18px;
        padding: 16px 18px;
        border-radius: 12px;
        background: #13151c;
        color: #eceef3;
        border: 1px solid #2d313b;
        box-shadow: 0 18px 50px -12px rgba(0, 0, 0, 0.6);
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        font-size: 13.5px;
        line-height: 1.5;
      }
      #kofem-cookie-consent[hidden] { display: none; }
      #kofem-cookie-consent p { margin: 0; flex: 1 1 260px; }
      #kofem-cookie-consent a { color: #8ea2ff; text-decoration: underline; }
      #kofem-cookie-consent .kofem-consent-actions {
        display: flex;
        gap: 10px;
        margin-left: auto;
      }
      #kofem-cookie-consent button {
        font: inherit;
        font-weight: 600;
        cursor: pointer;
        padding: 8px 16px;
        border-radius: 8px;
        border: 1px solid #2d313b;
        background: transparent;
        color: #eceef3;
      }
      #kofem-cookie-consent button[data-consent="granted"] {
        background: #5b7cff;
        border-color: #5b7cff;
        color: #fff;
      }
      :root[data-theme="light"] #kofem-cookie-consent {
        background: #ffffff;
        color: #0d1117;
        border-color: #d8dbe2;
      }
      :root[data-theme="light"] #kofem-cookie-consent button[data-consent="denied"] {
        color: #0d1117;
        border-color: #d8dbe2;
      }
    </style>
    <div
      id="kofem-cookie-consent"
      role="dialog"
      aria-live="polite"
      aria-label="Cookie consent"
      hidden
    >
      <p>
        We use Google Analytics cookies to understand how KoFEM is used. They
        are only set if you accept. See our
        <a href="/privacy/">Privacy &amp; Cookies</a> notice.
      </p>
      <div class="kofem-consent-actions">
        <button type="button" data-consent="denied">Decline</button>
        <button type="button" data-consent="granted">Accept</button>
      </div>
    </div>
    <script>
      (function () {
        var GA_ID = "${id}";
        // Inert until a real measurement ID is present. An unreplaced runtime
        // placeholder starts with "_"; real IDs (G-…, UA-…) never do.
        if (!GA_ID || GA_ID.charAt(0) === "_") return;
        var KEY = "kofem_analytics_consent";
        var disableFlag = "ga-disable-" + GA_ID;

        function getChoice() {
          try { return localStorage.getItem(KEY); } catch (e) { return null; }
        }
        function setChoice(v) {
          try { localStorage.setItem(KEY, v); } catch (e) {}
        }

        function loadGA() {
          window[disableFlag] = false;
          if (window.__kofemGALoaded) return;
          window.__kofemGALoaded = true;
          var s = document.createElement("script");
          s.async = true;
          s.src =
            "https://www.googletagmanager.com/gtag/js?id=" +
            encodeURIComponent(GA_ID);
          document.head.appendChild(s);
          window.dataLayer = window.dataLayer || [];
          window.gtag = function () { window.dataLayer.push(arguments); };
          window.gtag("js", new Date());
          window.gtag("config", GA_ID);
        }

        function apply(choice) {
          if (choice === "granted") loadGA();
          else window[disableFlag] = true; // documented gtag.js opt-out
        }

        function init() {
          var banner = document.getElementById("kofem-cookie-consent");
          if (banner) {
            var btns = banner.querySelectorAll("[data-consent]");
            for (var i = 0; i < btns.length; i++) {
              btns[i].addEventListener("click", function () {
                var v = this.getAttribute("data-consent");
                setChoice(v);
                apply(v);
                banner.hidden = true;
              });
            }
          }
          var settings = document.getElementById("kofem-cookie-settings");
          if (settings && banner) {
            settings.addEventListener("click", function (e) {
              e.preventDefault();
              banner.hidden = false;
            });
          }

          var choice = getChoice();
          if (choice === "granted") apply("granted");
          else if (choice === "denied") apply("denied");
          else if (banner) banner.hidden = false;
        }

        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", init);
        } else {
          init();
        }
      })();
    </script>`;
}

/** Insert the analytics block just before `</body>` (falls back to append). */
export function injectAnalytics(html: string, snippet: string): string {
  if (!snippet) return html;
  if (html.includes("</body>")) {
    return html.replace("</body>", `${snippet}\n  </body>`);
  }
  return html + snippet;
}

/**
 * Vite plugin that injects the analytics block via `transformIndexHtml`. This
 * covers the dev server (all pages) and the production build of the app entry
 * (app/index.html). The static marketing pages are copied outside Vite's HTML
 * pipeline, so they are injected separately in copyStaticPages().
 */
export function analyticsPlugin(snippet: string): PluginOption {
  return {
    name: "kofem-analytics",
    transformIndexHtml(html) {
      return injectAnalytics(html, snippet);
    },
  };
}
