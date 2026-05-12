"""
Cantilever beam example: 1m steel beam, fixed left end, point load at right.
"""

import kofem

mesh = kofem.Mesh()
bcs = kofem.BoundaryConditions()

# Two nodes along X axis
mesh.add_node(0, 0.0, 0.0, 0.0)
mesh.add_node(1, 1.0, 0.0, 0.0)

# Fix left node (all 6 DOF)
bcs.fix_node(0)

# Apply 1 kN downward force (Uy, DOF index 1) at right node
bcs.apply_force(1, 1, -1000.0)

displacements = kofem.solve(mesh, bcs)
print(f"Tip displacement Uy = {displacements[1 * 6 + 1]:.6e} m")
