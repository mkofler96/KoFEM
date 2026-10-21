# Bracket landing page

The root marketing page loads these static assets through Vite's public directory. The app remains at `/app/`; the existing build still injects consent-gated analytics and copies the root page.

The animation uses manim-web 0.37.0 (`ThreeDScene`, `ModelMobject`, `Arrow3D`) and Three.js 0.186.1. `vendor/` contains the tree-shaken ESM browser bundle and its dynamic chunks, the Three.js modules, and upstream MIT licenses. No CDN or runtime package download is required.

The uploaded GE engine bracket solid was rigidly aligned to a mounting plane at x = 0 mm. KoFEM/Netgen produced a 19,723-tetrahedron display/static-analysis mesh and a separate 292,038-tetrahedron topology mesh (maximum size 2 mm, minimum 0.4 mm). Only the four cylindrical mounting bores are fixed. Steel uses E = 210,000 N/mm² and Poisson ratio 0.3. Both lug bores carry a distributed 1 kN pull along the original STEP's positive Z axis, perpendicular to their common bore axis, with no applied moment. The exact force vector, support selection, binary layouts, optimization settings, and iteration history are in the JSON assets.

The topology sequence is a converged KoFEM reaction–diffusion level-set run with a 12% volume target (88% material removal) and a 2 mm regularization length. Intermediate frames interpolate the engine's streamed element densities after volume-weighted nodal averaging. The stored final solver frame uses the actual nodal level set, mapped as `(phi + 1) / 2`, so extraction at 0.5 draws the engine's `phi = 0` boundary. Marching tetrahedra and clipped CAD boundary faces produce a closed surface, following KoFEM's Smooth representation. Bounded tangential Taubin fairing affects presentation only; CAD creases are pinned. A worker keeps extraction off the scroll/render thread. The fine optimization mesh is never drawn as wireframe.

Playback shows iterations 0–36, starting from the solid bracket. The last four solver iterations are excluded from display because the end of the sequence develops a knobbly outline. The complete 40-iteration solver history and fields remain in the assets. Each displayed iteration gets an equal part of the first 80% of the turn, with continuous interpolation between density fields. Iteration 36 stays fixed for the final 72° of rotation so it can be inspected.

The canvas is fixed outside an inner scroll viewport. The bracket moves horizontally from right to left while rotating 90° about the viewport's vertical axis, then completes another 360° turn about that same axis during optimization. Post-processing displays the displacement contour on undeformed geometry. Reduced-motion preferences suppress the optimization turn and heading transitions.

`ge-engine-bracket-solution.bin`, `ge-engine-bracket-network.bin`, and `ge-engine-bracket-smooth.bin` contain precomputed results, not engine WASM build artifacts. The solver engine itself is not vendored here.

The generator gzips each `.bin` itself, so it arrives compressed from any static host; `assets.js` inflates it with `DecompressionStream`. The smooth sequence is also packed for size: tetrahedron and boundary indices are 16-bit, each tetrahedron's nodes and then the tetrahedra are sorted (element indices in `settings.passive` refer to the mesher's original order), boundary normals are 16-bit signed and density fields 16-bit unsigned, each with the `scale` recorded in its layout entry.

`landing.js` requests the libraries and the bracket data in parallel. The topology worker fetches and decodes the optimization sequence itself, starting once everything the bracket needs has arrived.

Regenerate the static solve, connected mesh reveal, and level-set sequence with the matching engine installed:

```bash
cd web
bun scripts/generate-landing-bracket.mjs /path/to/ge_engine_bracket-2.step
```

The generator checks the original STEP hash, remeshes the display and optimization models, and rebuilds protected elements around the mounting and loaded bore surfaces. It runs the solve and optimizer in fresh engine instances and verifies load equilibrium, fixed-node displacement, and optimization convergence before writing the assets. The original STEP force `[0, 0, 1000]` N transforms to approximately `[748.974, 0, -662.599]` N in the aligned mounting frame. The applied moment about the loaded surface's area centroid is zero; the offset pull still produces reaction moments at the supports.
