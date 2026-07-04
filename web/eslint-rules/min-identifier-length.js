// Local mirror of DeepSource JS-C1003 ("Variable name is too small"), added
// after it flagged 10 sites on PR #340 post-push (issue #341). DeepSource only
// reviews changed lines, so any PR touching code with a single-letter local
// re-triggers it; this rule fails the same sites in the pre-commit hook and CI
// lint step instead.
//
// Scope mirrors DeepSource's observed behaviour on #340:
//
// - Flagged: `const` / `let` / `var` declarators bound to a single-character
//   name (`const g = ...`, `let S = 0`).
// - Not flagged: loop declarations (`for (const f of faces)`,
//   `for (let i = 0; ...)`) and function/callback parameters
//   (`(g) => g.id === groupId`).
// - Allowlist: `i`, `j`, `k`, `n`, `_` — DeepSource accepted `n` on #340, and
//   conventional counters stay usable outside loop headers too.
//
// A genuine physics/math symbol documented by an equation reference (per the
// CLAUDE.md comment convention) may keep its name via
//   // eslint-disable-next-line kofem/min-identifier-length -- <equation the symbol comes from>
// The justification after `--` is mandatory by convention, matching
// kofem/no-silent-fallback.

const ALLOWED_NAMES = new Set(["i", "j", "k", "n", "_"]);

function isLoopDeclaration(declaration) {
  const parent = declaration.parent;
  return (
    (parent.type === "ForStatement" && parent.init === declaration) ||
    ((parent.type === "ForOfStatement" || parent.type === "ForInStatement") &&
      parent.left === declaration)
  );
}

export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow single-character variable names in const/let/var declarations (mirrors DeepSource JS-C1003, issue #341)",
    },
    schema: [],
    messages: {
      tooShort:
        "Variable name `{{name}}` is too short (DeepSource JS-C1003). Rename it to something descriptive, " +
        "or — for a genuine physics/math symbol documented by an equation comment — add an " +
        "eslint-disable comment with a `-- justification`.",
    },
  },

  create(context) {
    return {
      VariableDeclarator(node) {
        if (node.id.type !== "Identifier") return;
        const { name } = node.id;
        if (name.length > 1 || ALLOWED_NAMES.has(name)) return;
        if (isLoopDeclaration(node.parent)) return;
        context.report({
          node: node.id,
          messageId: "tooShort",
          data: { name },
        });
      },
    };
  },
};
