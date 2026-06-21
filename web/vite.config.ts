import { defineConfig, type PluginOption } from "vite";
import { fileURLToPath } from "node:url";
import { copyFileSync, mkdirSync } from "node:fs";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import istanbul from "vite-plugin-istanbul";

const htmlEntry = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The marketing pages (index.html, examples/index.html) are fully static — Vite
// emits them byte-for-byte, they import no hashed assets. Feeding them as extra
// MPA rollup inputs is flaky (in some environments rollup crosses the landing/app
// chunk names and drops the landing HTML entirely, leaving "/" on nginx's default
// page). So the build has a single entry (the app) and we copy the static pages
// into dist/ deterministically. Dev is unaffected: rollupOptions is build-only,
// and the dev server still serves the pages from the filesystem.
const copyStaticPages = (): PluginOption => ({
  name: "copy-static-pages",
  apply: "build",
  closeBundle() {
    copyFileSync(htmlEntry("./index.html"), htmlEntry("./dist/index.html"));
    mkdirSync(htmlEntry("./dist/examples"), { recursive: true });
    copyFileSync(
      htmlEntry("./examples/index.html"),
      htmlEntry("./dist/examples/index.html"),
    );
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

export default defineConfig(({ mode }) => ({
  // Multi-page: "/" serves the static marketing landing (index.html); the React
  // solver app lives at "/app/" (app/index.html). MPA mode disables the SPA
  // history fallback so the two entries are served independently.
  appType: "mpa",
  plugins: [
    react(),
    wasm(),
    topLevelAwait(),
    copyStaticPages(),
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
}));
