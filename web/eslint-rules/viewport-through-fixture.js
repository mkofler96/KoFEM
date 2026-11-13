// A click on the 3D viewport goes through tests/fixtures/viewport.ts
// (clickModelAt, clickViewportAt). Those helpers first wait for the
// viewport's `settled()` signal: the scene shows the store as it is and has
// stopped drawing. A spec that calls `page.mouse.click` itself skips that
// wait and clicks a view the user never saw — where the old camera put the
// point, or on a surface that has no pick handler yet. Two such tests failed
// 23% and 11% of their CI runs before the wait existed.
//
// Flagged in tests/*.spec.ts and tests/fixtures (except viewport.ts itself):
// `page.mouse.click(...)` and `page.mouse.dblclick(...)`. Moving the pointer
// and dragging (`move`, `down`, `up`) stay available: they are how a spec
// leaves a hover or drags a panel edge.
//
// A click at page coordinates that is not on the viewport (there should be
// few: click DOM elements through locators) keeps its call with
//   // eslint-disable-next-line kofem/viewport-through-fixture -- <what is clicked>

const CLICKS = new Set(["click", "dblclick"]);

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require viewport clicks in browser specs to go through tests/fixtures/viewport.ts, which waits for the settled viewport",
    },
    schema: [],
    messages: {
      viaFixture:
        "Click the viewport through tests/fixtures/viewport.ts (clickModelAt, clickViewportAt), which waits for the settled viewport first; click DOM elements through locators.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.property.type === "Identifier" &&
          CLICKS.has(callee.property.name) &&
          callee.object.type === "MemberExpression" &&
          !callee.object.computed &&
          callee.object.property.type === "Identifier" &&
          callee.object.property.name === "mouse"
        )
          context.report({ node, messageId: "viaFixture" });
      },
    };
  },
};
