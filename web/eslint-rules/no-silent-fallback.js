// Custom rule enforcing the AGENTS.md convention "ALWAYS prefer clear and
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
//    paths): a default that fabricates a plausible *value* is flagged,
//    however it is written: `x ?? d` / `x || d`, a destructuring or
//    parameter default (`{ size = d }`), or a ternary that falls back when a
//    value is absent (`prop ? prop.materialId : d`, KOF-432). A plausible
//    value is a number, non-empty string, boolean, non-empty array/object
//    literal, template literal, `new` expression, or an identifier named like
//    a default (`DEFAULT_*`, `fallbackMaterial`, ...). Prose ("none shown")
//    is a message that states the absence, not a value. Absence markers
//    (`null`, `undefined`, `[]`, `""`, `{}`, an empty `new Set()` or
//    `new Float64Array(0)`) stay allowed: they represent "no data" and flow
//    into explicit emptiness checks instead of pretending data exists.
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

// Text with a space is a message to the user ("unrecognised OS", `Mesh ready ·
// ${n} nodes`): it states the absence instead of standing in for the data. A
// one-word string ("step", "face") is a value.
function isProse(text) {
  return /\s/.test(text);
}

// `new Set()`, `new Map()`, `new Float64Array(0)`: "no data", like `[]`. An
// empty object of another kind (`new Vector3()`) is a value.
const COLLECTIONS = /^(Set|Map|WeakSet|WeakMap|Array|\w+Array)$/;
function isEmptyCollection(node) {
  const args = node.arguments;
  return (
    node.callee.type === "Identifier" &&
    COLLECTIONS.test(node.callee.name) &&
    (args.length === 0 ||
      (args.length === 1 && args[0].type === "Literal" && args[0].value === 0))
  );
}

// A right-hand side that fabricates a plausible value instead of marking
// absence. `null`, `undefined`, `""`, `[]`, `{}` are absence markers.
function isValueDefault(node) {
  switch (node.type) {
    case "Literal":
      return (
        node.value !== null &&
        node.value !== "" &&
        !(typeof node.value === "string" && isProse(node.value))
      );
    case "UnaryExpression":
      return node.operator === "-" && node.argument.type === "Literal";
    case "ArrayExpression":
      return node.elements.length > 0;
    case "ObjectExpression":
      return node.properties.length > 0;
    case "TemplateLiteral":
      return !node.quasis.some((q) => isProse(q.value.cooked));
    case "NewExpression":
      return !isEmptyCollection(node);
    case "Identifier":
      return node.name === "undefined"
        ? false
        : DEFAULT_LIKE_NAME.test(node.name);
    default:
      return false;
  }
}

// What a presence check tests: a name or a property, optionally chained.
function isPresenceOperand(node) {
  return (
    node.type === "Identifier" ||
    node.type === "MemberExpression" ||
    node.type === "ChainExpression"
  );
}

function isAbsenceLiteral(node) {
  return (
    (node.type === "Literal" && node.value === null) ||
    (node.type === "Identifier" && node.name === "undefined")
  );
}

// The branch a ternary takes when the value it checks is absent, or null when
// the ternary is no presence-check fallback: `x ? x.y : z`, `!x ? z : x[i]`,
// `x !== undefined ? x : z` and `x == null ? z : x` all give z. It is one only
// when the other branch reads the checked value itself, `x` or `x.y`; a flag
// choosing between two values (`ok ? "check-ok" : "check-fail"`) or two
// messages (`g ? \`Add face to ${g.name}\` : "New BC"`) is not.
function absentBranch(node, source) {
  const split = presenceSplit(node);
  if (split === null) return null;
  return readsValue(split.present, split.checked, source) ? split.absent : null;
}

// Strip what does not change which value an expression reads.
function unwrap(node) {
  let current = node;
  while (
    current.type === "ChainExpression" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSAsExpression"
  )
    current = current.expression;
  return current;
}

// `a?.b` and `a.b` read the same value.
function sameValue(a, b, source) {
  const text = (node) =>
    source.getText(unwrap(node)).replace(/\?\./g, ".").replace(/\s+/g, "");
  return text(a) === text(b);
}

// Whether `expr` is `checked` or a property of it, at any depth.
function readsValue(expr, checked, source) {
  let current = unwrap(expr);
  for (;;) {
    if (sameValue(current, checked, source)) return true;
    if (current.type !== "MemberExpression") return false;
    current = unwrap(current.object);
  }
}

function presenceSplit(node) {
  const { test, consequent, alternate } = node;
  if (isPresenceOperand(test))
    return { checked: test, present: consequent, absent: alternate };
  if (
    test.type === "UnaryExpression" &&
    test.operator === "!" &&
    isPresenceOperand(test.argument)
  )
    return { checked: test.argument, present: alternate, absent: consequent };
  if (test.type !== "BinaryExpression") return null;
  const checked = isAbsenceLiteral(test.right)
    ? test.left
    : isAbsenceLiteral(test.left)
      ? test.right
      : null;
  if (checked === null || !isPresenceOperand(checked)) return null;
  if (test.operator === "!==" || test.operator === "!=")
    return { checked, present: consequent, absent: alternate };
  if (test.operator === "===" || test.operator === "==")
    return { checked, present: alternate, absent: consequent };
  return null;
}

// `m.set(k, (m.get(k) ?? 0) + x)`, `m.set(k, Math.max(m.get(k) ?? 0, x))` and
// `m.set(k, (m.get(k) ?? new Vector3()).add(x))`: a running sum, count or
// maximum read back into its own map entry, starting from the identity of the
// reduction (0 for a sum, 0 for a maximum of non-negative values, an empty
// vector for a vector sum). Any other default, or a direct write of the
// fallback, is still a fabricated value.
function isZero(node) {
  return node.type === "Literal" && node.value === 0;
}

function isEmptyNew(node) {
  return node.type === "NewExpression" && node.arguments.length === 0;
}

function isMathMinMax(callee) {
  return (
    callee.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    callee.object.name === "Math" &&
    (callee.property.name === "max" || callee.property.name === "min")
  );
}

// The reduction expression the fallback starts, or null.
function reductionOf(node) {
  const parent = node.parent;
  if (
    parent.type === "BinaryExpression" &&
    parent.operator === "+" &&
    isZero(node.right)
  )
    return parent;
  if (
    parent.type === "CallExpression" &&
    isMathMinMax(parent.callee) &&
    parent.arguments.includes(node) &&
    isZero(node.right)
  )
    return parent;
  if (
    parent.type === "MemberExpression" &&
    parent.object === node &&
    parent.property.name === "add" &&
    parent.parent.type === "CallExpression" &&
    parent.parent.callee === parent &&
    isEmptyNew(node.right)
  )
    return parent.parent;
  return null;
}

function isOwnEntryUpdate(node, source) {
  const read = unwrap(node.left);
  if (
    read.type !== "CallExpression" ||
    read.callee.type !== "MemberExpression" ||
    read.callee.property.name !== "get" ||
    read.arguments.length !== 1
  )
    return false;
  const reduction = reductionOf(node);
  if (reduction === null) return false;
  const write = reduction.parent;
  return (
    write.type === "CallExpression" &&
    write.callee.type === "MemberExpression" &&
    write.callee.property.name === "set" &&
    write.arguments.length === 2 &&
    write.arguments[1] === reduction &&
    sameValue(write.callee.object, read.callee.object, source) &&
    sameValue(write.arguments[0], read.arguments[0], source)
  );
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

    const reportValueDefault = (node, fallback) =>
      context.report({
        node,
        messageId: "valueDefault",
        data: { fallback: `\`${source.getText(fallback)}\`` },
      });

    return {
      // `{ size = 20 }`, `[first = 1]`, `function f(size = 20)`.
      AssignmentPattern(node) {
        if (checkValueDefaults && isValueDefault(node.right))
          reportValueDefault(node, node.right);
      },
      ConditionalExpression(node) {
        if (!checkValueDefaults) return;
        const absent = absentBranch(node, source);
        if (absent !== null && isValueDefault(absent))
          reportValueDefault(node, absent);
      },
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

        if (
          checkValueDefaults &&
          isValueDefault(node.right) &&
          !isOwnEntryUpdate(node, source)
        )
          reportValueDefault(node, node.right);
      },
    };
  },
};
