// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineConfig, loadEnv, type PluginOption } from "vite";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import istanbul from "vite-plugin-istanbul";
import {
  analyticsPlugin,
  analyticsSnippet,
  injectAnalytics,
} from "./vite-analytics";

const htmlEntry = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The marketing pages (index.html, examples/index.html, privacy/index.html) are
// fully static — Vite emits them byte-for-byte, they import no hashed assets.
// Feeding them as extra MPA rollup inputs is flaky (in some environments rollup
// crosses the landing/app chunk names and drops the landing HTML entirely,
// leaving "/" on nginx's default page). So the build has a single entry (the
// app) and we copy the static pages into dist/ deterministically. The analytics
// consent block is injected here because these pages bypass Vite's HTML pipeline
// (transformIndexHtml only runs on the app entry at build time). Dev is
// unaffected: rollupOptions is build-only, the dev server serves the pages from
// the filesystem, and transformIndexHtml injects analytics there instead.
const STATIC_PAGES = [
  "index.html",
  "examples/index.html",
  "privacy/index.html",
];

const copyStaticPages = (snippet: string): PluginOption => ({
  name: "copy-static-pages",
  apply: "build",
  closeBundle() {
    for (const page of STATIC_PAGES) {
      const html = injectAnalytics(
        readFileSync(htmlEntry(`./${page}`), "utf8"),
        snippet,
      );
      mkdirSync(htmlEntry(`./dist/${page}/..`), { recursive: true });
      writeFileSync(htmlEntry(`./dist/${page}`), html);
    }
  },
});

// COVERAGE=1 instruments all src/ modules with Istanbul counters so Playwright
// can collect runtime coverage (see tests/coverage.ts).  Off by default: the
// instrumented bundle is bigger and slower.
const coveragePlugins: PluginOption[] = process.env.COVERAGE
  ? [
      istanbul({
        include: "src/*",
        extension: [".ts", ".tsx"],
        exclude: ["node_modules", "src/wasm/pkg/**"],
        forceBuildInstrument: true,
      }),
    ]
  : [];

export default defineConfig(({ mode }) => {
  // VITE_GA_ID (empty prefix loads it from .env files and the process env). When
  // set at build time it is baked in; when unset the snippet ships a placeholder
  // for runtime substitution by the Docker entrypoint (or stays inert on other
  // static hosts). See vite-analytics.ts.
  const gaSnippet = analyticsSnippet(
    loadEnv(mode, process.cwd(), "").VITE_GA_ID,
  );

  return {
    // Multi-page: "/" serves the static marketing landing (index.html); the
    // React solver app lives at "/app/" (app/index.html). MPA mode disables the
    // SPA history fallback so the two entries are served independently.
    appType: "mpa",
    plugins: [
      react(),
      wasm(),
      topLevelAwait(),
      copyStaticPages(gaSnippet),
      analyticsPlugin(gaSnippet),
      ...coveragePlugins,
    ],
    worker: {
      format: "es",
      plugins: () => [wasm(), topLevelAwait(), ...coveragePlugins],
    },
    build: {
      target: "esnext",
      // Fail closed: source maps and unminified output are an explicit
      // `--mode development` opt-in (see the build:dev script). Every other
      // invocation — the default production build, CI, or any custom/empty mode
      // a deploy host might pass — ships minified and map-free. Keying these off
      // `mode === "production"` instead leaks readable, mapped source whenever
      // the mode is anything but that exact string.
      sourcemap: mode === "development",
      minify: mode === "development" ? false : "esbuild",
      rollupOptions: {
        input: {
          app: htmlEntry("./app/index.html"),
        },
      },
    },
  };
});
