# Academic Writing Style Guide Based on Kofler et al. (2025)

This guide captures the **general academic register and explanatory rhythm** of the uploaded paper by Kofler et al. It focuses on reusable stylistic features such as explicit signposting, contrast-based argumentation, careful qualification, equation-to-prose integration, and sequential methodological exposition.

> **Important:** This guide is intended to reproduce broad stylistic characteristics, not to copy distinctive wording or sentences from the source.

## 1. Overall voice

Aim for a tone that is:

**technical, calm, explanatory, restrained, sequential, and reader-oriented.**

The goal is not to sound elegant or impressive. The goal is to make the logic of the research difficult to misunderstand.

Use first-person plural naturally when describing decisions:

- We use…
- We chose…
- We propose…
- We found…
- We apply…

Use impersonal constructions for general principles:

- The geometry is defined by…
- The method requires…
- The optimization problem can be written as…

A useful distinction is:

**Authorial decisions → active “we”**  
**Mathematical or physical facts → impersonal construction**

---

## 2. Preferred paragraph structure

A highly characteristic paragraph pattern is:

**context → existing approach → advantage → limitation → alternative → justification**

Example:

> A common approach to addressing this problem is to use homogenization. This provides an efficient approximation of the macroscopic structural response. However, the method generally relies on assumptions regarding scale separation and periodicity, which may not hold for all lattice structures. In our approach, we therefore perform a full-scale finite element analysis. Although this increases the computational effort, it allows the structural response to be evaluated without introducing the aforementioned assumptions.

A second useful structure is:

**need → proposed implementation → equation → interpretation → reason for choice**

Example:

> The latent-vector representation should depend on a limited number of design variables while remaining continuous over the domain. One possible solution is to use B-splines. The latent vector can then be expressed as
>
> \[
> \lambda(x)=\sum_i \phi_i(x)\hat{\lambda}_i.
> \]
>
> Here, \(\phi_i\) denotes the spline basis function and \(\hat{\lambda}_i\) the corresponding control variable. We choose this representation for two main reasons. First, it provides a compact parameterization. Second, the derivatives with respect to the control variables can be computed straightforwardly.

---

## 3. Introduce sections explicitly

Do not rely entirely on headings.

At the beginning of a section, tell the reader what will happen.

Preferred formulations:

- In this section, we present…
- In the following section, we describe…
- We first introduce…, followed by…
- The remainder of this section is organized as follows…

For a Methods section, a good opening is:

> In this section, we describe the proposed optimization framework. We first introduce the geometry representation, followed by the mesh-generation procedure and the finite element analysis. Finally, we explain how the design variables are updated using gradient-based optimization.

This style is deliberately explicit.

---

## 4. Use contrast as the main argumentative device

Use contrast words to make logical relationships visible:

- However, …
- In contrast, …
- Conversely, …
- While X…, Y…
- On the other hand, …
- Nevertheless, …
- Instead, …

These words should indicate actual logical relationships rather than serve as filler.

Typical pattern:

> Method A provides an efficient representation. However, it does not preserve continuity across adjacent cells. In contrast, the proposed transformation is defined globally and therefore avoids this discontinuity.

---

## 5. Explain before formalizing

Do not introduce equations abruptly.

Use this sequence:

**conceptual explanation → equation → symbol definitions → interpretation**

Instead of:

> The objective is
> \[
> J=\int_\Omega ...
> \]

write:

> The objective of the optimization is to minimize the structural compliance. For a given geometry, the compliance can be written as
>
> \[
> J=\int_\Omega \sigma(u):\varepsilon(u)\,dx,
> \]
>
> where \(\sigma\) denotes the stress tensor and \(\varepsilon\) the corresponding strain tensor.

Then add:

> This quantity provides a measure of the overall structural flexibility and is therefore minimized during optimization.

The equations should not replace exposition. Important equations should be interpreted in words.

---

## 6. Use “Note that” strategically

Useful clarification constructions include:

- Note that…
- It should be noted that…
- In this case, …
- In practice, …
- More specifically, …
- This means that…
- In other words, …

Use these for distinctions that could otherwise confuse the reader.

Example:

> Note that the number of spline control points does not need to coincide with the number of unit cells.

Avoid using “Note that” for trivial statements.

---

## 7. Separate general methodology from your implementation

Distinguish what is theoretically possible from what was actually used.

Useful phrases:

- In general, …
- In principle, …
- In theory, …
- In our case, …
- For the present study, …
- For simplicity, we…
- In this work, we…

Example:

> In principle, the free-form deformation control points could also be included as design variables. However, for the present study, we restrict the optimization to the latent-vector parameters.

This prevents implementation choices from being mistaken for theoretical limitations.

---

## 8. Give explicit reasons for methodological choices

Do not write:

> We use B-splines.

Prefer:

> We use B-splines for two main reasons. First, they provide local control over the parameter field. Second, their polynomial basis functions allow the required derivatives to be evaluated efficiently.

This makes methodological decisions appear deliberate and technically justified.

---

## 9. Use enumeration for complex explanations

For anything involving several requirements, contributions, advantages, or steps, state the number before giving them.

Examples:

- Two conditions must be satisfied.
- The method consists of three main steps.
- We extend the existing framework in two aspects.
- There are two reasons for this choice.

Then use:

- First, …
- Second, …
- Finally, …

This gives dense engineering prose a procedural and readable structure.

---

## 10. Results should describe, interpret, and qualify

Do not merely report numbers.

Use:

**observation → interpretation → limitation or significance**

Example:

> The objective decreases substantially during the first ten iterations and subsequently approaches a nearly constant value. This indicates that most of the structural adaptation occurs during the initial part of the optimization. Small oscillations remain close to convergence, which can likely be attributed to changes in the extracted mesh topology.

The interpretation should remain cautious.

Prefer:

- This suggests…
- This indicates…
- This can be attributed to…
- A possible explanation is…

Avoid:

- This proves conclusively…

unless the evidence genuinely supports such a claim.

---

## 11. Be transparent about simple or imperfect experiments

If a test case is deliberately simple, say so.

A good formulation is:

> This test case is deliberately simple and could also be represented analytically. Nevertheless, it provides a useful reference case for verifying the numerical framework before considering more complex geometries.

This kind of transparency generally strengthens credibility.

---

## 12. Integrate limitations where they occur

Do not reserve every limitation for the conclusion.

If a methodological weakness becomes relevant in the Methods section, mention it there.

Example:

> The uniform sampling strategy was sufficient for the geometries considered here. However, it may become inefficient for geometries with highly localized surface features. Investigating adaptive sampling strategies therefore remains a subject for future work.

Likewise:

> In the current implementation, contact between adjacent struts is not considered. This may become relevant when very small gaps occur.

A useful pattern is:

**methodological choice → observed adequacy → limitation → future extension**

---

## 13. Figure discussion template

Use:

**introduce figure → describe what it contains → identify observation → interpret observation**

Example:

> Fig. 8 shows the evolution of the geometry during optimization. The initial design is shown on the left, while the optimized configuration is shown on the right. One can see that material is gradually shifted toward the upper and lower regions of the beam. This redistribution is consistent with the bending-dominated loading condition.

Useful phrases:

- Fig. X shows…
- As shown in Fig. X, …
- One can see that…
- The comparison shows that…
- The upper row shows…, while the lower row shows…
- This behavior can be attributed to…

The prose should follow the same order as the information shown in the figure whenever possible.

---

## 14. Literature review template

Avoid writing a catalogue of individual papers.

Weak form:

> Smith used method A. Jones used method B. Chen used method C.

Preferred form:

> Several approaches have been proposed to reduce the computational cost of lattice-structure optimization. Homogenization-based methods provide an efficient macroscopic representation but generally rely on scale-separation assumptions. Beam-based models reduce the number of degrees of freedom but are limited to structures consisting primarily of slender members. More recently, neural-network-based representations have been investigated to provide greater geometric flexibility. However, many of these approaches still rely on homogenized material properties. In contrast, the present work uses the neural network only as a geometry parameterization and evaluates the structural response using full-scale finite element analysis.

Organize literature around:

**method family → benefit → limitation → research gap → present approach**

This makes the literature review advance the argument rather than merely summarize citations.

---

## 15. Preferred hedging

Be confident about what the study directly demonstrates and cautious beyond that.

Useful phrases:

- appears to
- suggests that
- can be
- may lead to
- could be extended
- was sufficient for
- worked well for the considered cases
- we did not observe
- is likely caused by
- remains to be investigated
- for the present examples
- within the considered parameter range

Avoid stacking multiple hedges:

> possibly might perhaps somewhat indicate…

One qualifier is usually enough.

---

## 16. Preferred sentence length

Aim mostly for **15–30-word sentences**, with occasional longer technical sentences.

A useful rhythm is:

1. medium sentence
2. short clarification
3. medium technical sentence
4. equation
5. explanatory sentence

Avoid making every sentence equally long.

Example:

> The extracted surface mesh is subsequently converted into a volumetric representation. For this purpose, we use a tetrahedral meshing algorithm. The resulting finite element mesh is then used to evaluate the structural response under the prescribed boundary conditions.

Prefer linear syntax to compressed noun-heavy phrasing.

---

## 17. Preferred vocabulary

Favor ordinary technical verbs:

- use
- apply
- define
- describe
- obtain
- compute
- evaluate
- determine
- introduce
- represent
- vary
- generate
- compare
- show
- demonstrate
- require
- allow
- restrict
- investigate

Avoid unnecessarily ornate alternatives where simpler wording is clearer.

Examples:

- leverage → use
- elucidate → show / explain
- ameliorate → improve
- utilize → use

Technical precision should come from terminology, not decorative vocabulary.

---

## 18. Avoid promotional research language

Avoid:

- revolutionary
- unprecedented
- groundbreaking
- highly novel
- transformative
- remarkable
- extremely powerful

Prefer:

- The proposed method allows…
- The results demonstrate…
- The method provides…
- This enables…
- The framework was successfully applied to…

The tone should remain restrained and evidence-focused.

---

## 19. Recommended introduction architecture

A strong introduction in this style can follow this sequence:

### Broad engineering problem

> Lattice structures provide attractive mechanical properties but remain challenging to design and optimize.

### Primary numerical challenge

> Accurate full-scale analysis is computationally expensive.

### Existing solution families

Introduce, for example:

- homogenization
- beam models
- reduced-order models
- neural approaches

### Limitations of those approaches

Discuss:

- assumptions
- geometric restrictions
- computational cost

### Research gap

> Existing methods do not simultaneously provide X and Y.

### Your approach

> In this work, we propose…

### Contributions

> We extend the existing framework in two aspects. First,… Second,…

### Paper structure

> The remainder of this paper is organized as follows…

The introduction should progressively narrow from the broad engineering problem to the specific contribution.

---

## 20. Methods-section architecture

A Methods chapter should feel procedural.

Start with the complete pipeline:

> The proposed framework consists of four main components…

Then move through each component in the same order:

> First…

> The next step…

> Once X has been obtained…

> Finally…

A useful overall structure is:

1. representation or parameterization
2. input preparation
3. mesh or geometry generation
4. physical simulation
5. sensitivity analysis
6. optimization update

Keep the prose order synchronized with the workflow diagram or algorithm whenever possible.

---

## 21. Results-section architecture

For every experiment, use the same internal sequence:

**test-case purpose → geometry/setup → parameters → result → interpretation → limitation**

Useful opening:

> To evaluate the proposed method, we consider…

Then:

> The geometry and boundary conditions are shown in Fig. X.

Then:

> The following parameters were used…

Then:

> Fig. Y shows the optimization history.

Finally:

> The results indicate…

Using a consistent structure across experiments helps readers compare them.

---

## 22. Conclusion architecture

Use four compact moves:

### What was developed

> In this work, we presented…

### What was demonstrated

> The method was evaluated using…

### What the main advantage is

> The proposed representation enables…

### What remains

> Future work will focus on…

Do not introduce entirely new arguments in the conclusion.

---

# Master prompt for reproducing this academic style

Use the following prompt when drafting a new section:

> **Write the following technical content in a clear computational-engineering academic style modeled on the rhetorical characteristics of Kofler et al. (2025). Do not copy sentences or distinctive phrasing from the source. Reproduce only the general stylistic features.**
>
> Use a formal but readable scientific tone. Favor logical transparency over rhetorical elegance. Use first-person plural (“we”) for methodological decisions and impersonal constructions for general mathematical or physical statements.
>
> Structure paragraphs sequentially. Where appropriate, use the pattern: context → existing approach → advantage → limitation → proposed alternative → justification.
>
> Introduce technical concepts verbally before presenting equations. After each important equation, define the variables and explain its practical meaning in prose.
>
> Use explicit signposting such as “In this section,” “In our case,” “However,” “In contrast,” “Therefore,” “Note that,” “For simplicity,” and “As previously described,” but only when they express a genuine logical relationship.
>
> When explaining methodological choices, explicitly state the reasons, preferably using structures such as “We chose X for two main reasons. First,… Second,…”.
>
> Distinguish clearly between general possibilities and the implementation used in the present work using phrases such as “In principle,” “In our case,” and “For the present study.”
>
> Integrate limitations where they become relevant instead of hiding them until the conclusion. Use restrained claims such as “suggests,” “indicates,” “was sufficient,” “can be,” and “may,” where appropriate.
>
> For figures, use the sequence: identify what the figure shows → describe the important observation → explain its significance.
>
> For results, use the sequence: observation → interpretation → qualification or limitation.
>
> Avoid rhetorical questions, metaphors, promotional adjectives, exaggerated novelty claims, unnecessary jargon, and overly ornate vocabulary.
>
> Prefer medium-length sentences with relatively linear syntax. Use technical terminology precisely, but choose simple verbs such as “use,” “define,” “compute,” “evaluate,” “show,” “compare,” and “determine.”
>
> Maintain a restrained engineering tone throughout.
>
> Preserve all technical meaning, notation, citations, numerical values, and scientific qualifications from the provided content. Do not invent unsupported claims.

---

# Add-on prompt for rewriting existing prose

Add this after the master prompt when revising text you have already written:

> Improve clarity, logical progression, paragraph coherence, and technical precision, but do not make the prose more promotional or more literary. Where the original text jumps directly into technical details, add brief explanatory transitions. Where claims are too strong, qualify them appropriately. Where long paragraphs contain multiple logical functions, separate them into coherent units.

---

# Add-on prompt for a thesis chapter

Add this when drafting or revising a thesis:

> Assume the reader is technically competent but may not be familiar with the specific method. Therefore, explain specialized concepts when they are first introduced and briefly interpret important equations rather than assuming that their significance is self-evident.

---

# Compact checklist

Before finalizing a section, check whether:

- the purpose of the section is stated clearly;
- each paragraph has one main technical function;
- existing methods are presented fairly before their limitations;
- contrasts are made explicitly;
- equations are introduced and interpreted in prose;
- methodological choices are justified;
- general possibilities are distinguished from the implementation used;
- figures are discussed rather than merely cited;
- results are interpreted rather than only reported;
- limitations are acknowledged where relevant;
- claims are appropriately qualified;
- simple technical verbs are preferred over ornate wording;
- promotional language has been removed;
- the overall logic is sequential and easy to follow.