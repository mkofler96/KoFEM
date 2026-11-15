// A click on the 3D viewport goes through tests/fixtures/viewport.ts
// (clickModelAt, clickViewportAt). Those helpers first wait for the
// viewport's `settled()` signal: the scene shows the store as it is and has
// stopped drawing. A spec that calls `page.mouse.click` itself skips that
// wait and clicks a view the user never saw — where the old camera put the
// point, or on a surface that has no pick handler yet. Two such tests failed
// 23% and 11% of their CI runs before the wait existed.
//
// Flagged in tests/*.spec.ts and tests/fixtures (except viewport.ts itself):
// a `click` or `dblclick` on the mouse (`page.mouse.click(...)`, or a `mouse`
// taken out of the page first) and on a canvas (`page.locator("canvas")
// .click()`, or a variable named for one). Moving the pointer and dragging
// (`move`, `down`, `up`) stay available: they are how a spec leaves a hover
// or drags a panel edge.
//
// A click at page coordinates that is not on the viewport (there should be
// few: click DOM elements through locators) keeps its call with
//   // eslint-disable-next-line kofem/viewport-through-fixture -- <what is clicked>

const CLICKS = new Set(["click", "dblclick"]);
const SELECTORS = new Set(["locator", "$", "$$", "querySelector"]);

function methodName(callee) {
  return callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier"
    ? callee.property.name
    : null;
}

// `page.mouse`, or a variable called `mouse`.
function isMouse(node) {
  if (node.type === "Identifier") return node.name === "mouse";
  return methodName(node) === "mouse";
}

// A locator chain that selects a canvas (`page.locator("canvas").first()`),
// or a variable named for one (`canvas`, `viewportCanvas`).
function isCanvas(node) {
  let current = node;
  while (current) {
    if (current.type === "Identifier") return /canvas/i.test(current.name);
    if (current.type === "AwaitExpression") current = current.argument;
    else if (current.type === "MemberExpression") current = current.object;
    else if (current.type === "CallExpression") {
      const selector = current.arguments[0];
      if (
        SELECTORS.has(methodName(current.callee)) &&
        selector?.type === "Literal" &&
        typeof selector.value === "string" &&
        /canvas/i.test(selector.value)
      )
        return true;
      current =
        current.callee.type === "MemberExpression"
          ? current.callee.object
          : null;
    } else return false;
  }
  return false;
}

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
        if (!CLICKS.has(methodName(callee))) return;
        if (isMouse(callee.object) || isCanvas(callee.object))
          context.report({ node, messageId: "viaFixture" });
      },
    };
  },
};
