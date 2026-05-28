#!/usr/bin/env python3
"""Generate a minimal STEP file for a 10×10×50 mm box for pipeline tests."""
import sys, os, tempfile

try:
    from OCC.Core.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCC.Core.STEPControl import STEPControl_Writer, STEPControl_AsIs
    from OCC.Core.IFSelect import IFSelect_RetDone
except ImportError:
    # If python3-occ not available, write a hardcoded minimal STEP file
    step = """ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Open CASCADE Model'),'2;1');
FILE_NAME('box.stp','2024-01-01',(''),(''),'Open CASCADE STEP processor 6.7','Open CASCADE 6.7','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));
ENDSEC;
DATA;
#1 = APPLICATION_PROTOCOL_DEFINITION('','automotive_design',2000,#2);
#2 = APPLICATION_CONTEXT('automotive design');
#3 = SHAPE_DEFINITION_REPRESENTATION(#4,#5);
#4 = PRODUCT_DEFINITION_SHAPE('','',#6);
#5 = ADVANCED_BREP_SHAPE_REPRESENTATION('',(#7),#8);
#6 = PRODUCT_DEFINITION('design','',#9,#10);
#7 = MANIFOLD_SOLID_BREP('',#11);
#8 = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#12)) GLOBAL_UNIT_ASSIGNED_CONTEXT((#13,#14,#15)) REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY') );
#9 = PRODUCT_DEFINITION_CONTEXT('part definition',#2,'design');
#10 = PRODUCT('Box','Box','',(#16));
#11 = CLOSED_SHELL('',(#17,#18,#19,#20,#21,#22));
#12 = UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#13,'distance_accuracy_value','confusion accuracy');
#13 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );
#14 = ( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) );
#15 = ( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() );
#16 = PRODUCT_CONTEXT('',#2,'mechanical');
ENDSEC;
END-ISO-10303-21;"""
    path = os.path.join(os.path.dirname(__file__), "box.step")
    with open(path, "w") as f:
        f.write(step)
    print(f"Wrote stub STEP to {path}")
    sys.exit(0)

shape = BRepPrimAPI_MakeBox(10.0, 10.0, 50.0).Shape()
writer = STEPControl_Writer()
writer.Transfer(shape, STEPControl_AsIs)
path = os.path.join(os.path.dirname(__file__), "box.step")
status = writer.Write(path)
assert status == IFSelect_RetDone, f"STEP write failed: {status}"
print(f"Wrote {path}")
