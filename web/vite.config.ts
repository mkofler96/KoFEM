// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineConfig, loadEnv, type PluginOption } from "vite";
import { fileURLToPath } from "node:url";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";
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

// The marketing pages (index.html, privacy/index.html) are fully static — Vite
// emits them byte-for-byte, they import no hashed assets. Feeding them as extra
// MPA rollup inputs is flaky (in some environments rollup crosses the
// landing/app chunk names and drops the landing HTML entirely, leaving "/" on
// nginx's default page). So the build has a single entry (the app) and we copy
// the static pages into dist/ deterministically. The analytics consent block is
// injected here because these pages bypass Vite's HTML pipeline
// (transformIndexHtml only runs on the app entry at build time). Dev is
// unaffected: rollupOptions is build-only, the dev server serves the pages from
// the filesystem, and transformIndexHtml injects analytics there instead.
const STATIC_PAGES = ["index.html", "privacy/index.html"];

// The examples gallery lives outside web/, with everything else example-related
// (examples/gallery/). Its site/ folder is served verbatim at /examples/: the
// gallery page, examples.json, and the <id>.vtu / <id>.step files the app's
// `?example=` loader fetches. The Docker build receives it as the named build
// context "gallery" (web/Dockerfile).
const GALLERY_SITE = htmlEntry("../examples/gallery/site/");

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
    const galleryOut = htmlEntry("./dist/examples/");
    cpSync(GALLERY_SITE, galleryOut, { recursive: true });
    writeFileSync(
      join(galleryOut, "index.html"),
      injectAnalytics(
        readFileSync(join(GALLERY_SITE, "index.html"), "utf8"),
        snippet,
      ),
    );
  },
});

const GALLERY_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".vtu": "application/xml",
  ".step": "application/octet-stream",
};

// Dev server only; `vite preview` serves dist/, which copyStaticPages fills.
const serveGallery = (): PluginOption => ({
  name: "serve-gallery",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use("/examples", (req, res, next) => {
      const [original, query] = (req.originalUrl ?? "").split("?");
      // The page fetches "./examples.json"; served at "/examples" that resolves
      // to "/examples.json". nginx redirects the bare path too.
      if (original === "/examples") {
        res.statusCode = 301;
        res.setHeader("Location", `/examples/${query ? `?${query}` : ""}`);
        return res.end();
      }
      const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
      const rel = path === "/" ? "index.html" : path.slice(1);
      const file = join(GALLERY_SITE, rel);
      if (!file.startsWith(GALLERY_SITE) || !existsSync(file)) return next();
      if (!statSync(file).isFile()) return next();
      res.setHeader(
        "Content-Type",
        GALLERY_TYPES[extname(file)] ?? "application/octet-stream",
      );
      if (rel !== "index.html") return res.end(readFileSync(file));
      server
        .transformIndexHtml("/examples/", readFileSync(file, "utf8"))
        .then((html) => res.end(html), next);
    });
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
      serveGallery(),
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
