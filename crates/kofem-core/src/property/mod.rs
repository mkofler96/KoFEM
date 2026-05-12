/// Property cards — mirror Nastran conventions.
/// The property card, not the element type, determines the formulation and DOF per node.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaneFormulation {
    PlaneStress,
    PlaneStrain,
}

/// PBAR — simple beam cross-section (no warping, no shear flexibility)
#[derive(Debug, Clone)]
pub struct PbarProps {
    pub material_id: usize,
    pub area: f64,
    /// Moment of inertia about local z-axis (bending in xy-plane)
    pub i1: f64,
    /// Moment of inertia about local y-axis (bending in xz-plane)
    pub i2: f64,
    /// Torsional constant
    pub j: f64,
}

/// PBEAM — general beam cross-section with optional Timoshenko shear factors
#[derive(Debug, Clone)]
pub struct PbeamProps {
    pub material_id: usize,
    pub area: f64,
    pub i1: f64,
    pub i2: f64,
    pub j: f64,
    pub i12: f64,
    /// Shear area factor in planes 1 and 2 (κ = 0 → no transverse shear)
    pub k1: f64,
    pub k2: f64,
}

/// PSHELL — thin shell (CTRIA3, CTRIA6, CQUAD4, CQUAD8 → 6 DOF/node)
#[derive(Debug, Clone)]
pub struct PshellProps {
    pub material_id: usize,
    pub thickness: f64,
    /// Optional separate bending material (MID2 in Nastran); None = same as MID1
    pub bending_material_id: Option<usize>,
    /// Optional transverse shear material (MID3); None = same as MID1
    pub shear_material_id: Option<usize>,
}

/// PLPLANE — 2D plane-stress or plane-strain (CTRIA3, CQUAD4 → 2 DOF/node: ux, uy)
#[derive(Debug, Clone)]
pub struct PlplaneProps {
    pub material_id: usize,
    /// Out-of-plane thickness (used only for plane-stress to compute volume)
    pub thickness: f64,
    pub formulation: PlaneFormulation,
}

/// PSOLID — 3D solid (CTETRA, CPENTA, CHEXA, CPYRAM → 3 DOF/node: ux, uy, uz)
#[derive(Debug, Clone)]
pub struct PsolidProps {
    pub material_id: usize,
}

#[derive(Debug, Clone)]
pub enum PropertyCard {
    PBAR(PbarProps),
    PBEAM(PbeamProps),
    PSHELL(PshellProps),
    PLPLANE(PlplaneProps),
    PSOLID(PsolidProps),
}

impl PropertyCard {
    /// Degrees of freedom per node for elements using this property.
    pub fn dof_per_node(&self) -> usize {
        match self {
            Self::PBAR(_) | Self::PBEAM(_) | Self::PSHELL(_) => 6,
            Self::PLPLANE(_) => 2,
            Self::PSOLID(_) => 3,
        }
    }

    pub fn material_id(&self) -> usize {
        match self {
            Self::PBAR(p) => p.material_id,
            Self::PBEAM(p) => p.material_id,
            Self::PSHELL(p) => p.material_id,
            Self::PLPLANE(p) => p.material_id,
            Self::PSOLID(p) => p.material_id,
        }
    }
}
