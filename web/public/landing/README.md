# Bracket landing page

The root marketing page loads these static assets through Vite's public directory. The app remains at `/app/`; the existing build still injects consent-gated analytics and copies the root page.

The animation uses manim-web 0.37.0 (`ThreeDScene`, `ModelMobject`, `Arrow3D`) and Three.js 0.186.1. `vendor/` contains the tree-shaken ESM browser bundle and its dynamic chunks, the Three.js modules, and upstream MIT licenses. No CDN or runtime package download is required.

The uploaded GE engine bracket solid was rigidly aligned to a mounting plane at x = 0 mm. KoFEM/Netgen produced a 22,100-tetrahedron display/static-analysis mesh and a separate 51,238-tetrahedron topology mesh (maximum size 6 mm, minimum 1.2 mm). Only the four cylindrical mounting bores are fixed. Steel uses E = 210,000 N/mm² and Poisson ratio 0.3. Both lug bores carry a distributed 1 kN force and an equilibrated 50 N·m moment about the mounting normal. The exact force vector, support selection, binary layouts, optimization settings, and iteration history are in the JSON assets.

The topology sequence is a converged KoFEM SIMP run with a 50% volume target. The browser interpolates volume-weighted nodal densities and extracts a closed surface using marching tetrahedra and clipped CAD boundary faces, following KoFEM's Smooth representation. Bounded tangential Taubin fairing affects presentation only; CAD creases are pinned. A worker keeps extraction off the scroll/render thread. The fine optimization mesh is never drawn as wireframe.

The canvas is fixed outside an inner scroll viewport. A shared side-facing pose moves from right to left; optimization gradually raises the front 18° around a back pivot. Reduced-motion preferences suppress the scroll deformation and use the final inspection tilt directly.

`ge-engine-bracket-solution.bin`, `ge-engine-bracket-network.bin`, and `ge-engine-bracket-smooth.bin` contain precomputed results, not engine WASM build artifacts. The solver engine itself is not vendored here.
