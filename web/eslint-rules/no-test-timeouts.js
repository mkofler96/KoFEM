// Time budgets of the browser specs are set once per project in
// playwright.config.ts. A number in a spec is a guess about the machine: it
// held on the author's laptop and then failed a pull request on a loaded CI
// runner, or it was raised until it hid a real hang. Before this rule 48 of
// 65 spec files overrode the test budget and 142 waits carried their own.
//
// Flagged in tests/*.spec.ts and tests/fixtures:
//
// - `test.setTimeout(...)` and `test.slow()`: a per-test budget. A test that
//   needs more than the `ui` project gives belongs in `pipeline` (tag its
//   title `@pipeline`).
// - a `timeout` property in an object passed to a call: a per-wait budget
//   (`toBeVisible({ timeout })`, `expect.poll(fn, { timeout })`, …).
// - `page.waitForTimeout(...)` and `setTimeout(...)`: a fixed sleep. Wait for
//   the state instead: a web-first assertion, `expect.poll`, or
//   `settleViewport(page)` (tests/fixtures/viewport.ts) for the 3D viewport.
//
// A wait that is known to outlast its project's budget keeps its number with
//   // eslint-disable-next-line kofem/no-test-timeouts -- <why this one is long>
// The justification after `--` is mandatory by convention, matching
// kofem/no-silent-fallback.

const TEST_BUDGET_METHODS = new Set(["setTimeout", "slow"]);

function isMember(node, objectName, propertyNames) {
  return (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "Identifier" &&
    node.object.name === objectName &&
    node.property.type === "Identifier" &&
    propertyNames.has(node.property.name)
  );
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow per-test budgets, per-wait timeouts and fixed sleeps in browser specs; budgets are set per project in playwright.config.ts",
    },
    schema: [],
    messages: {
      testBudget:
        "Do not set a per-test time budget. Budgets are set per project in playwright.config.ts; a test that needs more than `ui` gives is a `@pipeline` test.",
      waitBudget:
        "Do not give a wait its own timeout. The project's budget in playwright.config.ts applies; an assertion returns as soon as its condition holds. For a wait known to outlast the budget, disable this rule on the line with a `-- reason`.",
      sleep:
        "Do not sleep for a fixed time. Wait for the state: a web-first assertion, expect.poll, or settleViewport(page) for the 3D viewport.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (isMember(callee, "test", TEST_BUDGET_METHODS)) {
          context.report({ node, messageId: "testBudget" });
          return;
        }
        const isSleep =
          (callee.type === "Identifier" && callee.name === "setTimeout") ||
          (callee.type === "MemberExpression" &&
            !callee.computed &&
            callee.property.type === "Identifier" &&
            callee.property.name === "waitForTimeout");
        if (isSleep) {
          context.report({ node, messageId: "sleep" });
          return;
        }
        for (const argument of node.arguments) {
          if (argument.type !== "ObjectExpression") continue;
          for (const property of argument.properties) {
            if (
              property.type === "Property" &&
              !property.computed &&
              property.key.type === "Identifier" &&
              property.key.name === "timeout"
            )
              context.report({ node: property, messageId: "waitBudget" });
          }
        }
      },
    };
  },
};
