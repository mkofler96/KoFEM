"""
KoFEM Python interface.

The native extension (kofem.so) is built via maturin from crates/kofem-py.
Run `maturin develop` in the /python directory to build and install for dev.
"""
try:
    from .kofem import PyMesh as Mesh, PyBoundaryConditions as BoundaryConditions, solve
except ImportError:
    raise ImportError(
        "kofem native extension not built. Run: cd python && maturin develop"
    )

__all__ = ["Mesh", "BoundaryConditions", "solve"]
