import os
import glob
from pathlib import Path
from OCP.STEPControl import STEPControl_Reader
from OCP.IFSelect import IFSelect_RetDone
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.StlAPI import StlAPI_Writer
from OCP.TopoDS import TopoDS


def convert_step_to_stl(step_file, output_dir, tolerance=0.1):
    """
    Convert a STEP file to STL with simple tessellation.

    Args:
        step_file: Path to the input STEP file
        output_dir: Directory to save the STL file
        tolerance: Tessellation tolerance (default 0.1)
    """
    try:
        # Read STEP file
        reader = STEPControl_Reader()
        status = reader.ReadFile(step_file)

        if status != IFSelect_RetDone:
            print(f"Error reading STEP file: {step_file}")
            return False

        # Transfer to shape
        reader.TransferRoots()
        shape = reader.OneShape()

        if shape.IsNull():
            print(f"Failed to extract shape from: {step_file}")
            return False

        # Perform tessellation
        mesh = BRepMesh_IncrementalMesh(shape, tolerance)
        mesh.Perform()

        # Generate output filename
        base_name = Path(step_file).stem
        output_file = os.path.join(output_dir, f"{base_name}.stl")

        # Write STL file
        writer = StlAPI_Writer()
        writer.Write(shape, output_file)
        print(f"Successfully converted: {step_file} -> {output_file}")
        return True

    except Exception as e:
        print(f"Error converting {step_file}: {str(e)}")
        return False


def main():
    """Main function to convert all STEP files in NIST folder to STL."""

    # Define paths
    nist_folder = "test_files/NIST"
    output_folder = "test_files/reference_stl"

    # Create output directory if it doesn't exist
    os.makedirs(output_folder, exist_ok=True)

    # Find all STEP files
    step_files = glob.glob(os.path.join(nist_folder, "**/*.step"), recursive=True)
    step_files += glob.glob(os.path.join(nist_folder, "**/*.stp"), recursive=True)

    if not step_files:
        print(f"No STEP files found in {nist_folder}")
        return

    print(f"Found {len(step_files)} STEP files")

    # Convert each file
    successful = 0
    for step_file in step_files:
        if convert_step_to_stl(step_file, output_folder):
            successful += 1

    print(
        f"\nConversion complete: {successful}/{len(step_files)} files converted successfully"
    )


if __name__ == "__main__":
    main()
