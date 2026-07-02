// Custom rule enforcing the CLAUDE.md convention "ALWAYS prefer clear and
// information-rich error messages over silent fall-throughs" — the recurring
// bug class catalogued in issue #322 (silent steel defaults #183/#174, silent
// zero-force loads #198, discarded materials #310, ...).
//
// Two layers:
//
// 1. Everywhere: `parseFloat(x) || fallback` (also parseInt/Number) is always
//    flagged — `||` converts NaN into a plausible default, and `??` next to a
//    numeric parse suggests the author believed it handles NaN (it does not).
//
// 2. With `checkValueDefaults: true` (enabled for solver-input/solver-result
//    paths): any `??` / `||` whose right side fabricates a plausible *value* —
//    a number, non-empty string, boolean, non-empty array/object literal,
//    template literal, `new` expression, or an identifier named like a
//    default (`DEFAULT_*`, `fallbackMaterial`, ...) — is flagged. Absence
//    markers (`?? null`, `?? undefined`, `?? []`, `?? ""`, `?? {}`) stay
//    allowed: they represent "no data" and flow into explicit emptiness
//    checks instead of pretending data exists.
//
// A genuinely optional field may keep its default via
//   // eslint-disable-next-line kofem/no-silent-fallback -- <why absence is legitimate here>
// The justification after `--` is mandatory by convention (see CONTRIBUTING.md).

const NUMERIC_PARSERS = new Set(["parseFloat", "parseInt", "Number"]);
const DEFAULT_LIKE_NAME = /default|fallback/i;

function isNumericParseCall(node) {
  return (
    node.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    NUMERIC_PARSERS.has(node.callee.name)
  );
}

// A right-hand side that fabricates a plausible value instead of marking
// absence. `null`, `undefined`, `""`, `[]`, `{}` are absence markers.
function isValueDefault(node) {
  switch (node.type) {
    case "Literal":
      return node.value !== null && node.value !== "";
    case "UnaryExpression":
      return node.operator === "-" && node.argument.type === "Literal";
    case "ArrayExpression":
      return node.elements.length > 0;
    case "ObjectExpression":
      return node.properties.length > 0;
    case "TemplateLiteral":
    case "NewExpression":
      return true;
    case "Identifier":
      return node.name === "undefined"
        ? false
        : DEFAULT_LIKE_NAME.test(node.name);
    default:
      return false;
  }
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow silent fallbacks that substitute a plausible default for missing or invalid data (issue #322 bug class)",
    },
    schema: [
      {
        type: "object",
        properties: {
          checkValueDefaults: { type: "boolean" },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      nanMasking:
        "`{{callee}}(...) {{operator}} {{fallback}}` silently turns invalid input into {{fallback}} " +
        "(the #183/#198 bug pattern). Parse, then validate with Number.isFinite() and raise a clear error.",
      valueDefault:
        "Silent fallback to {{fallback}} fabricates plausible data on a solver-critical path (issue #322 bug class). " +
        "Raise a clear error for missing/mismatched data, or — if the field is genuinely optional — add an " +
        "eslint-disable comment with a `-- justification` (see CONTRIBUTING.md).",
    },
  },

  create(context) {
    const { checkValueDefaults = false } = context.options[0] ?? {};
    const source = context.sourceCode;

    return {
      LogicalExpression(node) {
        if (node.operator !== "||" && node.operator !== "??") return;

        if (isNumericParseCall(node.left)) {
          context.report({
            node,
            messageId: "nanMasking",
            data: {
              callee: node.left.callee.name,
              operator: node.operator,
              fallback: source.getText(node.right),
            },
          });
          return;
        }

        if (checkValueDefaults && isValueDefault(node.right)) {
          context.report({
            node,
            messageId: "valueDefault",
            data: { fallback: `\`${source.getText(node.right)}\`` },
          });
        }
      },
    };
  },
};
