// Deliberately narrow ESLint setup: its job is to enforce the "no silent
// fallbacks" convention from CLAUDE.md / CONTRIBUTING.md (issue #322), not
// general style — tsc --strict covers the rest.
import tseslint from "typescript-eslint";
import noSilentFallback from "./eslint-rules/no-silent-fallback.js";

const kofem = {
  rules: { "no-silent-fallback": noSilentFallback },
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
    // Solver-critical paths: everything that feeds the solver or derives
    // displayed results. Here any `??`/`||` fabricating a plausible value
    // default is an error; genuinely optional fields carry an
    // eslint-disable comment with a justification.
    files: ["src/workers/**", "src/store/**", "src/lib/**"],
    plugins: { kofem },
    rules: {
      "kofem/no-silent-fallback": ["error", { checkValueDefaults: true }],
    },
  },
];
