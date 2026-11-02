# Theory article authoring template

Copy this file for a new article and remove instructional comments. Keep the
article small enough to answer one main question. If it answers a second
question, split and link it.

---

**Question:** _One sentence ending in a question mark._

**Prerequisites:** _Links to the few concepts or earlier guide pages required._

**Reviewed solver revision:** _Full Git commit SHA and review date._

**Implementation:** _Links to exact production C++/WASM and web source files._

## Assumptions and scope

- State physical assumptions (for example static, small-strain, isotropic).
- State the dimensional convention and the units of every input.
- Say what solver path and element/discretisation types the explanation covers.
- List important exclusions before the derivation.

## Explanation

Start with the physical problem, then introduce only the symbols needed here.
Define each local symbol at first use and link its stable anchor in
`/theory/notation/`. Provide prose that conveys the meaning of every equation
for readers and assistive technology.

_Equation or derivation, with all terms defined._

Connect the physical problem to the formulation, then to the numerical method.
Do not use a display tessellation as evidence about the FEM discretisation.

## KoFEM implementation

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

- **Reproducible example:** _Stable KoFEM example URL and exact command._
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
- [ ] Prerequisites and previous/next links work.
- [ ] Assumptions, symbol definitions, units, and sign conventions are explicit.
- [ ] Equations have meaningful text equivalents and stable symbol links.
- [ ] Claims trace to production sources at the recorded revision.
- [ ] Limitations and practical consequences are specific.
- [ ] The example is reproducible and the reference is cited.
- [ ] Any decision section links the owning Linear ADR.
- [ ] Solid, shell, coupled, and optimization scope is not overstated.
