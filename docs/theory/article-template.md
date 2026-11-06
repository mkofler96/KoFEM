# Theory article authoring template

Copy this file for a new article and remove instructional comments. Keep the
article small enough to answer one main question. If it answers a second
question, split and link it.

Do not add prerequisite lists or labels to public articles. Introduce needed
concepts in the explanation and link related pages where useful. Keep stable
heading IDs and page-contents links, without visible hashtag permalink links
beside the headings.

Use a general FEM explanation when it answers the question best. KoFEM
examples, app walkthroughs and implementation sections are optional; add them
when the article makes product-specific claims or needs verification evidence.
Keep common unit-system comparisons on the separate
`/theory/foundations/consistent-units/` page. All Theory PRs target `develop`
(the development/dev channel), never `main`.

---

**Question:** _One sentence ending in a question mark._

**Reviewed solver revision (when applicable):** _Full Git commit SHA and review date for product-specific claims._

**Implementation (when applicable):** _Links to exact production C++/WASM and web source files._

## Assumptions and scope

- State physical assumptions (for example static, small-strain, isotropic).
- State the dimensional convention and the units of every input.
- Say what physical model or element/discretisation types the explanation covers;
  identify the solver path when making implementation-specific claims.
- List important exclusions before the derivation.

## Explanation

Start with the physical problem, then introduce only the symbols needed here.
Define each local symbol at first use and link its stable anchor in
`/theory/notation/`. Provide prose that conveys the meaning of every equation
for readers and assistive technology.

_Equation or derivation, with all terms defined._

Connect the physical problem to the formulation, then to the numerical method.
Do not use a display tessellation as evidence about the FEM discretisation.

## KoFEM implementation (optional)

Omit this section from conceptual introductions that make no product-specific
claims. Include it for articles explaining actual solver behaviour.

Explain, with source links pinned to the reviewed revision:

1. which UI/model input reaches the solver;
2. how the production C++/WASM path represents or assembles it;
3. which result is returned and how the web app presents it; and
4. any meaningful differences among solid, shell, and coupled paths.

Do not use the deferred Rust stubs as evidence for production behavior.

## Limitations and practical consequences

- What does the formulation or evidence not establish?
- When can a user get a misleading, mesh-dependent, or invalid answer?
- What should the user check, refine, or compare?
- Which unsupported capability needs a separate issue rather than documentation?

## Example and references

- **Worked example (when useful):** _A standalone calculation or physical model;
  use a KoFEM example URL and command when relevant to the article._
- **Reference result:** _Analytical or published value, assumptions, and units._
- **Sources:** _Primary references and implementation links._
- **Related guide pages:** _Previous, next, and deeper pages._

## Decision (optional)

Include this section only when the article explains an actual technical choice.
Link an established Linear ADR when one exists; do not create a parallel ADR.

- **Choice:** _What KoFEM does._
- **Alternatives:** _Credible options considered._
- **Evidence:** _Benchmarks, constraints, references, or linked ADR._
- **Tradeoffs:** _What the choice improves and costs._
- **Revisit when:** _Concrete conditions that would justify reopening it._

## Review checklist

- [ ] The title and question describe one topic.
- [ ] Previous/next links work.
- [ ] Assumptions, symbol definitions, units, and sign conventions are explicit.
- [ ] Equations have meaningful text equivalents and stable symbol links.
- [ ] Product-specific claims trace to production sources at the recorded revision.
- [ ] Limitations and practical consequences are specific.
- [ ] Any worked example is reproducible and its reference is cited.
- [ ] Numerical claims record executed commands, exact source revision, engine identity, quantity/location, units and justified tolerances.
- [ ] Changed behavior updates affected pages and generated evidence using the [maintenance workflow](README.md#updating-behavior-pages-and-evidence).
- [ ] Any decision section links the owning Linear ADR.
- [ ] Solid, shell, coupled, and optimization scope is not overstated.
