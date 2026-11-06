// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Reading order and permanent slugs from docs/theory/content-map.md.
// Unwritten topics link to their overview entry, never to an empty article.
export const topics = [
  ["Foundations", "foundations/model-and-units", "Model and units"],
  ["Foundations", "foundations/consistent-units", "Consistent unit systems"],
  ["Foundations", "foundations/reading-a-study", "Reading a study"],
  ["Notation and operators", "notation", "Notation"],
  [
    "Notation and operators",
    "operators/gradient-divergence",
    "Gradient and divergence",
  ],
  [
    "Notation and operators",
    "operators/tensor-products",
    "Tensor products and contractions",
  ],
  [
    "Notation and operators",
    "operators/integration-by-parts",
    "Integration and the weak form",
  ],
  [
    "Notation and operators",
    "operators/reference-mapping",
    "Reference elements and Jacobians",
  ],
  ["Solid mechanics", "solid-mechanics/linear-elasticity", "Linear elasticity"],
  [
    "Solid mechanics",
    "solid-mechanics/equilibrium-and-weak-form",
    "Equilibrium and weak form",
  ],
  [
    "Numerical methods",
    "numerical-methods/elements-and-quadrature",
    "Elements and quadrature",
  ],
  ["Numerical methods", "numerical-methods/assembly", "Assembly"],
  [
    "Numerical methods",
    "numerical-methods/loads-and-constraints",
    "Loads and constraints",
  ],
  ["Numerical methods", "numerical-methods/linear-solve", "Linear solve"],
  ["Results", "results/displacement-and-stress", "Displacement and stress"],
  [
    "Results",
    "results/interpretation-and-convergence",
    "Interpretation and convergence",
  ],
  ["Verification", "verification/axial-bar", "Axial-bar verification"],
  ["Verification", "verification/strategy", "Verification strategy"],
  ["Shells", "shells/formulation", "Shell formulation"],
  ["Shells", "shells/solid-coupling", "Solid–shell coupling"],
  ["Optimization", "optimization/simp", "SIMP"],
  [
    "Optimization",
    "optimization/constraints-and-convergence",
    "Constraints and convergence",
  ],
  [
    "Optimization",
    "optimization/interpreting-designs",
    "Interpreting optimized designs",
  ],
].map(([section, slug, title]) => ({ section, slug, title }));

export const topicAnchor = (topic) => topic.slug.replaceAll("/", "-");
export const articleUrl = (topic) => `/theory/${topic.slug}/`;
