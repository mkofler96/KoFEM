# Third-Party Licenses

KoFEM is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE).
It is built on top of several third-party libraries, each of which keeps its own
license. Those licenses are listed below. The combined KoFEM binary (including the
WebAssembly engine, which statically links the C++ libraries) is distributed under
the AGPL-3.0-or-later, but each component named here remains governed by its own
upstream license, and the copyright of each upstream project stays with its authors.

## Core engine libraries

The browser engine (`engine/cpp/engine.cpp`, compiled to WebAssembly) statically
links the following C++ libraries. Pre-compiled WASM builds of these libraries live
in the companion repository
[KoFEM-Dependencies](https://github.com/mkofler96/KoFEM-Dependencies).

| Library                           | Role in KoFEM                                    | License                               | Project                        |
| --------------------------------- | ------------------------------------------------ | ------------------------------------- | ------------------------------ |
| **OpenCASCADE Technology (OCCT)** | STEP geometry import and surface tessellation    | LGPL-2.1 with an additional exception | <https://dev.opencascade.org/> |
| **Netgen / nglib**                | Tetrahedral volume mesh generation               | LGPL-2.1                              | <https://ngsolve.org/>         |
| **MFEM**                          | Linear-elastic finite element assembly and solve | BSD-3-Clause                          | <https://mfem.org/>            |

For the exact license terms of each library, refer to the `LICENSE`/`COPYING` file
shipped in that library's own source distribution (and in the
[KoFEM-Dependencies](https://github.com/mkofler96/KoFEM-Dependencies) repository
where the WASM builds are produced).

### License compatibility

OCCT and Netgen are distributed under the LGPL-2.1, and MFEM under the
permissive BSD-3-Clause license. Both are compatible with KoFEM's
AGPL-3.0-or-later license, which is why they can be combined into a single
distributed binary. KoFEM as a whole is offered under the AGPL; the individual
libraries above continue to be available under their own terms.

## Web frontend

The React + Three.js frontend in `web/` depends on a number of open-source
npm packages (React, Three.js, @react-three/fiber, @react-three/drei, zustand,
immer, leva, react-router-dom, jspdf, Vite, and others). These are permissively
licensed (mostly MIT). The authoritative, always-current list of these
dependencies and their resolved versions is `web/package.json` together with the
lockfile; their license texts are installed under `web/node_modules/<pkg>/`.

## Rust crates

The native crates (`kofem-core`, `kofem-geom`, `kofem-mesh`) are part of KoFEM
and are licensed under AGPL-3.0-or-later. Their Cargo dependencies (`serde`,
`thiserror`, `log`) are dual MIT/Apache-2.0 licensed.

---

> **Note:** This file is a good-faith summary provided for convenience and is
> **not legal advice**. License terms and versions of upstream projects can
> change over time; always consult the license shipped with the specific version
> of each library you build or distribute. If you redistribute KoFEM or a
> modified version, you are responsible for complying with the AGPL-3.0 and with
> the licenses of all third-party components.
