#!/usr/bin/env python3
"""Convert all standard STEP test files to reference STL files.

Uses OCC (same as the NIST script) with a 0.5 mm linear deflection so curved
surfaces like cylinder barrels and cone frustums get proper tessellation.

Run from the repo root:
    python3 test_files/convert_steps_to_stl.py
"""

import os
import glob
from pathlib import Path

from OCP.STEPControl import STEPControl_Reader
from OCP.IFSelect import IFSelect_RetDone
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.StlAPI import StlAPI_Writer

STEP_DIR = "test_files"
OUT_DIR = "test_files/reference_stl"

# quarter_cylinder is a partial-surface test fixture, not a closed solid — skip it.
SKIP = {"quarter_cylinder"}

LINEAR_DEFLECTION = 0.5  # mm — controls how closely the mesh follows curved faces


def convert(step_path: str, out_dir: str) -> bool:
    stem = Path(step_path).stem
    if stem in SKIP:
        print(f"  skip  {stem}")
        return True

    reader = STEPControl_Reader()
    if reader.ReadFile(step_path) != IFSelect_RetDone:
        print(f"  ERROR reading {step_path}")
        return False

    reader.TransferRoots()
    shape = reader.OneShape()
    if shape.IsNull():
        print(f"  ERROR: empty shape from {step_path}")
        return False

    BRepMesh_IncrementalMesh(shape, LINEAR_DEFLECTION).Perform()

    out_path = os.path.join(out_dir, f"{stem}.stl")
    StlAPI_Writer().Write(shape, out_path)
    print(f"  ok    {stem} -> {out_path}")
    return True


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    step_files = sorted(glob.glob(os.path.join(STEP_DIR, "*.stp")))
    print(f"Converting {len(step_files)} STEP files (deflection={LINEAR_DEFLECTION} mm)...")
    ok = sum(convert(p, OUT_DIR) for p in step_files)
    print(f"\n{ok}/{len(step_files)} converted.")


if __name__ == "__main__":
    main()
