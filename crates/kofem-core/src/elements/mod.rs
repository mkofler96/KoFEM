pub mod beam;
pub mod plane;
pub mod shell;
pub mod solid;

use nalgebra::DMatrix;

/// Element connectivity types using Nastran naming convention.
///
/// For surface elements (CTRIA3, CTRIA6, CQUAD4, CQUAD8) the formulation
/// — shell (PSHELL, 6 DOF/node) or 2D plane (PLPLANE, 2 DOF/node) —
/// is determined by the associated property card, not the element type,
/// mirroring Nastran's design.
///
/// For volume elements (CTETRA, CPENTA, CHEXA, CPYRAM) the node count
/// in `Element::node_ids` determines linear vs. quadratic order:
///   CTETRA: 4 nodes → linear, 10 nodes → quadratic
///   CPENTA: 6 nodes → linear, 15 nodes → quadratic
///   CHEXA:  8 nodes → linear, 20 nodes → quadratic
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ElementType {
    // ── Line elements ────────────────────────────────────────────────
    /// 2-node simple bar/beam (PBAR)
    CBAR,
    /// 2-node general beam with warping (PBEAM)
    CBEAM,

    // ── Surface elements (shell or 2D plane depending on property) ───
    /// 3-node linear triangle
    CTRIA3,
    /// 6-node quadratic triangle
    CTRIA6,
    /// 4-node bilinear quadrilateral
    CQUAD4,
    /// 8-node serendipity quadrilateral
    CQUAD8,

    // ── Volume elements ──────────────────────────────────────────────
    /// Tetrahedron (4-node linear or 10-node quadratic)
    CTETRA,
    /// Pentahedron / wedge (6-node linear or 15-node quadratic)
    CPENTA,
    /// Hexahedron / brick (8-node linear or 20-node quadratic)
    CHEXA,
    /// Pyramid (5-node)
    CPYRAM,
}

impl ElementType {
    pub fn is_line(&self) -> bool {
        matches!(self, Self::CBAR | Self::CBEAM)
    }

    pub fn is_surface(&self) -> bool {
        matches!(
            self,
            Self::CTRIA3 | Self::CTRIA6 | Self::CQUAD4 | Self::CQUAD8
        )
    }

    pub fn is_solid(&self) -> bool {
        matches!(
            self,
            Self::CTETRA | Self::CPENTA | Self::CHEXA | Self::CPYRAM
        )
    }

    /// Default DOF per node when no property card is available.
    /// Surface elements return 6 (shell default); call PropertyCard::dof_per_node
    /// for the authoritative count when a property is present.
    pub fn default_dof_per_node(&self) -> usize {
        if self.is_solid() {
            3
        } else {
            6
        }
    }

    /// Minimum number of nodes for the linear order of this element.
    pub fn min_nodes(&self) -> usize {
        match self {
            Self::CBAR | Self::CBEAM => 2,
            Self::CTRIA3 => 3,
            Self::CTRIA6 | Self::CQUAD4 => 4, // CTRIA6=6 but min check
            Self::CQUAD8 => 8,
            Self::CTETRA => 4,
            Self::CPENTA => 6,
            Self::CHEXA => 8,
            Self::CPYRAM => 5,
        }
    }
}

/// Common interface for element stiffness computation.
///
/// `nodes` is a slice of `[x, y, z]` coordinates in the order given by
/// `Element::node_ids`. All coordinates are in the global Cartesian frame.
pub trait Element {
    fn stiffness_matrix(&self, nodes: &[[f64; 3]]) -> DMatrix<f64>;
    fn consistent_mass_matrix(&self, nodes: &[[f64; 3]], density: f64) -> DMatrix<f64>;
    fn dof_per_node(&self) -> usize;
}
