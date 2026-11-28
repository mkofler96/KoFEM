// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The engine options the app tessellates and meshes with. Scripts that must
// build what the app builds (the meshing benchmark, the validation pipeline)
// import them rather than copy them.

// Chord tolerance as a fraction of the model's bounding-box diagonal, so a
// large part isn't tessellated into millions of needless triangles; ~0.1 %
// matches the fast browser STEP viewers.
export const TESSELLATION_OPTIONS = {
  deflection_relative: 0.001,
  angular_deflection: 0.5,
} as const;

export const NETGEN_OPTIONS = {
  grading: 0.3,
  second_order: false,
  elementsperedge: 2.0,
  elementspercurve: 2.0,
  optsteps_2d: 3,
  optsteps_3d: 3,
} as const;
