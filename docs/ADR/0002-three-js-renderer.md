# ADR 0002: React + Three.js / React Three Fiber for 3D Rendering

**Status:** Accepted  
**Date:** 2026-05-12

## Context
The preprocessor and postprocessor need interactive 3D mesh visualization with selection, colormap rendering, and orbit navigation.

## Decision
Use **React Three Fiber** (R3F) as the declarative Three.js wrapper inside React. This gives full access to the Three.js API while staying idiomatic with React's component model and Zustand state.

For result colormaps, compute vertex colors on the CPU from solver output (dispatched to the worker), then upload to a `Float32BufferAttribute`. This avoids GPU compute complexity while remaining fast enough for meshes up to ~200k elements.

## Consequences
- **+** Large ecosystem: Drei helpers (OrbitControls, Grid, Gizmo) save weeks of work
- **+** Declarative scene graph integrates naturally with React state
- **-** R3F adds an abstraction layer; raw Three.js performance tricks are less accessible
- **-** Not suitable for > 1M element meshes (browser memory); would need GPU instancing or VTK.js for extreme scale
