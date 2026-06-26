# Disclaimer — No Warranty and No Engineering Liability

**Read this before using KoFEM for anything that matters.**

KoFEM is research-grade, open-source software for browser-based finite element
analysis. It is provided for education, exploration, and early-stage engineering
work. It is **not** a certified or validated engineering tool, and it must not be
treated as one.

## No warranty

KoFEM is provided **"as is", without warranty of any kind**, express or implied,
including but not limited to the warranties of merchantability, fitness for a
particular purpose, accuracy, and non-infringement. This restates and is
consistent with sections 15 and 16 ("Disclaimer of Warranty" and "Limitation of
Liability") of the [GNU Affero General Public License](LICENSE) under which KoFEM
is distributed.

## Simulation results may be wrong

Finite element analysis is an **approximation**. The results KoFEM produces depend
on — among other things — the imported geometry, mesh quality and density, the
chosen material properties, the applied loads and boundary conditions, and the
assumptions and limitations of the underlying numerical methods (linear-static,
small-deformation, linear-elastic). KoFEM does not guarantee that any result is
correct, convergent, or representative of physical reality.

**No result produced by KoFEM should be relied upon without independent
verification** by a qualified engineer, using validated tools, hand calculations,
and/or physical testing as appropriate.

## No liability for real-world consequences

To the maximum extent permitted by applicable law, the authors and contributors of
KoFEM accept **no liability whatsoever** for any direct, indirect, incidental,
consequential, or other damages of any kind arising from the use of, or inability
to use, this software or its results. This explicitly includes, without
limitation:

- failure, fracture, fatigue, deformation, or any other malfunction of a real
  mechanical part, structure, or assembly;
- injury, loss of life, property damage, financial loss, or environmental harm;
- decisions made — or not made — on the basis of KoFEM's output.

**You use KoFEM entirely at your own risk.** If you design, manufacture, certify,
or operate physical hardware, you are solely responsible for ensuring — through
appropriate qualified review, standards compliance, validated software, and
physical testing — that your design is safe and fit for purpose. KoFEM is a
starting point for analysis, never a substitute for professional engineering
judgement.

## Third-party components

KoFEM relies on third-party libraries (OpenCASCADE, Netgen, MFEM, and others),
each of which is likewise provided without warranty by its respective authors. See
[THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md).
