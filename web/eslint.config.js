// Deliberately narrow ESLint setup: its job is to enforce the "no silent
// fallbacks" convention from CLAUDE.md / CONTRIBUTING.md (issue #322), not
// general style — tsc --strict covers the rest.
import tseslint from "typescript-eslint";
import noSilentFallback from "./eslint-rules/no-silent-fallback.js";
import minIdentifierLength from "./eslint-rules/min-identifier-length.js";

const kofem = {
  rules: {
    "no-silent-fallback": noSilentFallback,
    "min-identifier-length": minIdentifierLength,
  },
};

export default [
  {
    // Generated Emscripten bundle and third-party output are not linted.
    ignores: ["src/wasm/pkg/**", "dist/**", "node_modules/**"],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { parser: tseslint.parser },
    plugins: { kofem },
    rules: {
      // Empty catch blocks are the C-family flavour of the silent fallback.
      "no-empty": "error",
      // Everywhere: parseFloat(x) || default and friends (NaN masking).
      "kofem/no-silent-fallback": "error",
    },
  },
  {
    // Mirrors DeepSource JS-C1003 (issue #341). Covers tests/ as well —
    // 3 of the 10 findings on #340 were in specs.
    files: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,mjs}"],
    languageOptions: { parser: tseslint.parser },
    plugins: { kofem },
    rules: {
      "kofem/min-identifier-length": "error",
    },
  },
  {
    // Solver-critical paths: everything that feeds the solver or derives
    // displayed results. Here any `??`/`||` fabricating a plausible value
    // default is an error; genuinely optional fields carry an
    // eslint-disable comment with a justification.
    //
    // Components and hooks are in scope because result rendering and solver
    // input now live there too, not just in workers/store/lib: the von Mises
    // colormap zero-filled missing stress data and the rule never saw it
    // (issue #363).
    files: [
      "src/workers/**",
      "src/store/**",
      "src/lib/**",
      "src/components/**",
      "src/hooks/**",
    ],
    plugins: { kofem },
    rules: {
      "kofem/no-silent-fallback": ["error", { checkValueDefaults: true }],
    },
  },
];
