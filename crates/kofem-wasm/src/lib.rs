use kofem_mesh::geom::Point2;
use kofem_mesh::{extrude, refine, triangulate};

use kofem_core::boundary::{BoundaryConditions, DofIndex};
use kofem_core::elements::ElementType;
use kofem_core::material::IsotropicElastic;
use kofem_core::mesh::Mesh;
use kofem_core::property::{
    PbarProps, PbeamProps, PlaneFormulation, PlplaneProps, PropertyCard, PshellProps, PsolidProps,
};
use kofem_core::LinearStaticSolver;
use serde::Deserialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

// ── Input DTOs ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ModelInput {
    nodes: Vec<NodeInput>,
    elements: Vec<ElementInput>,
    materials: Vec<MaterialInput>,
    properties: Vec<PropertyInput>,
    constraints: Vec<ConstraintInput>,
    loads: Vec<LoadInput>,
}

#[derive(Deserialize)]
struct NodeInput {
    id: usize,
    x: f64,
    y: f64,
    z: f64,
}

#[derive(Deserialize)]
struct ElementInput {
    id: usize,
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "nodeIds")]
    node_ids: Vec<usize>,
    #[serde(rename = "propertyId")]
    property_id: usize,
}

#[derive(Deserialize)]
struct MaterialInput {
    id: usize,
    young: f64,
    poisson: f64,
    density: f64,
}

#[derive(Deserialize)]
struct PropertyInput {
    id: usize,
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "materialId")]
    material_id: usize,
    // PBAR / PBEAM
    area: Option<f64>,
    i1: Option<f64>,
    i2: Option<f64>,
    j: Option<f64>,
    // PSHELL / PLPLANE
    thickness: Option<f64>,
    #[serde(rename = "planeFormulation")]
    plane_formulation: Option<String>,
}

#[derive(Deserialize)]
struct ConstraintInput {
    #[serde(rename = "nodeId")]
    node_id: usize,
    dof: u8,
    #[serde(rename = "prescribedValue", default)]
    prescribed_value: f64,
}

#[derive(Deserialize)]
struct LoadInput {
    #[serde(rename = "nodeId")]
    node_id: usize,
    dof: u8,
    value: f64,
}

// ── Conversion helpers ────────────────────────────────────────────────────────

fn dof_from_u8(d: u8) -> DofIndex {
    match d {
        0 => DofIndex::Ux,
        1 => DofIndex::Uy,
        2 => DofIndex::Uz,
        3 => DofIndex::Rx,
        4 => DofIndex::Ry,
        _ => DofIndex::Rz,
    }
}

fn element_type_from_str(s: &str) -> Option<ElementType> {
    match s {
        "CBAR" => Some(ElementType::CBAR),
        "CBEAM" => Some(ElementType::CBEAM),
        "CTRIA3" => Some(ElementType::CTRIA3),
        "CTRIA6" => Some(ElementType::CTRIA6),
        "CQUAD4" => Some(ElementType::CQUAD4),
        "CQUAD8" => Some(ElementType::CQUAD8),
        "CTETRA" => Some(ElementType::CTETRA),
        "CPENTA" => Some(ElementType::CPENTA),
        "CHEXA" => Some(ElementType::CHEXA),
        "CPYRAM" => Some(ElementType::CPYRAM),
        _ => None,
    }
}

fn build_mesh_and_bcs(input: ModelInput) -> Result<(Mesh, BoundaryConditions), String> {
    let mut mesh = Mesh::new();

    for n in input.nodes {
        mesh.add_node(n.id, n.x, n.y, n.z);
    }

    for m in input.materials {
        mesh.add_material(m.id, IsotropicElastic::new(m.young, m.poisson, m.density));
    }

    for p in input.properties {
        let card = match p.kind.as_str() {
            "PBAR" => PropertyCard::PBAR(PbarProps {
                material_id: p.material_id,
                area: p.area.unwrap_or(1e-4),
                i1: p.i1.unwrap_or(8.333e-10),
                i2: p.i2.unwrap_or(8.333e-10),
                j: p.j.unwrap_or(1.406e-9),
            }),
            "PBEAM" => PropertyCard::PBEAM(PbeamProps {
                material_id: p.material_id,
                area: p.area.unwrap_or(1e-4),
                i1: p.i1.unwrap_or(8.333e-10),
                i2: p.i2.unwrap_or(8.333e-10),
                j: p.j.unwrap_or(1.406e-9),
                i12: 0.0,
                k1: 0.0,
                k2: 0.0,
            }),
            "PSHELL" => PropertyCard::PSHELL(PshellProps {
                material_id: p.material_id,
                thickness: p.thickness.unwrap_or(0.01),
                bending_material_id: None,
                shear_material_id: None,
            }),
            "PLPLANE" => {
                let formulation = match p.plane_formulation.as_deref() {
                    Some("PlaneStrain") => PlaneFormulation::PlaneStrain,
                    _ => PlaneFormulation::PlaneStress,
                };
                PropertyCard::PLPLANE(PlplaneProps {
                    material_id: p.material_id,
                    thickness: p.thickness.unwrap_or(0.01),
                    formulation,
                })
            }
            "PSOLID" => PropertyCard::PSOLID(PsolidProps {
                material_id: p.material_id,
            }),
            other => return Err(format!("Unknown property type: {other}")),
        };
        mesh.add_property(p.id, card);
    }

    for e in input.elements {
        let etype = element_type_from_str(&e.kind)
            .ok_or_else(|| format!("Unknown element type: {}", e.kind))?;
        // material_id is derived from property; use 0 as placeholder here
        mesh.add_element(e.id, etype, e.node_ids, 0, e.property_id);
    }

    let mut bcs = BoundaryConditions::default();
    for c in input.constraints {
        bcs.constraints.push(kofem_core::boundary::NodalConstraint {
            node_id: c.node_id,
            dof: dof_from_u8(c.dof),
            prescribed_value: c.prescribed_value,
        });
    }
    for l in input.loads {
        bcs.apply_force(l.node_id, dof_from_u8(l.dof), l.value);
    }

    Ok((mesh, bcs))
}

// ── Public WASM API ───────────────────────────────────────────────────────────

/// Parse an Abaqus INP file and return the model as a JSON string.
///
/// The JSON matches the `ModelInput` schema (plus a `modelName` field) and
/// can be fed directly into `solve_linear_static`.
#[wasm_bindgen]
pub fn parse_inp_model(inp_text: &str) -> Result<String, JsError> {
    let parsed = kofem_core::io::inp::parse_inp(inp_text).map_err(|e| JsError::new(&e))?;
    serde_json::to_string(&parsed).map_err(|e| JsError::new(&e.to_string()))
}

/// Solve a linear static FEM model.
///
/// `model_json` is a JSON string matching the `ModelInput` schema.
/// Returns a flat Float64Array of nodal displacements (6 values per node).
#[wasm_bindgen]
pub fn solve_linear_static(model_json: &str) -> Result<Vec<f64>, JsError> {
    let input: ModelInput =
        serde_json::from_str(model_json).map_err(|e| JsError::new(&e.to_string()))?;
    let (mesh, bcs) = build_mesh_and_bcs(input).map_err(|e| JsError::new(&e))?;
    LinearStaticSolver::solve(&mesh, &bcs)
        .map(|r| r.displacements)
        .map_err(|e| JsError::new(&e.to_string()))
}

// ── Mesh generation API ───────────────────────────────────────────────────────

/// Triangulate a 2-D boundary polygon and refine it with Ruppert's algorithm.
///
/// `polygon_json` — JSON array of `{x, y}` objects listing the CCW boundary
/// vertices.  `min_angle_deg` — target minimum angle (20–33° is practical;
/// pass 0 to skip refinement).  `max_steiner` — hard cap on inserted points.
///
/// Returns a JSON object `{ points: [{x,y}, …], triangles: [{v:[a,b,c]}, …] }`.
#[wasm_bindgen]
pub fn mesh_polygon(
    polygon_json: &str,
    min_angle_deg: f64,
    max_steiner: usize,
) -> Result<String, JsError> {
    let boundary: Vec<Point2> =
        serde_json::from_str(polygon_json).map_err(|e| JsError::new(&e.to_string()))?;

    if boundary.len() < 3 {
        return Err(JsError::new("polygon needs at least 3 vertices"));
    }

    let mut mesh = triangulate(&boundary);

    if min_angle_deg > 0.0 && max_steiner > 0 {
        refine(
            &mut mesh.points,
            &mut mesh.triangles,
            &boundary,
            min_angle_deg,
            max_steiner,
        );
    }

    serde_json::to_string(&mesh).map_err(|e| JsError::new(&e.to_string()))
}

/// Extrude a 2-D triangle mesh into a 3-D tetrahedral mesh.
///
/// `mesh2d_json` — JSON produced by [`mesh_polygon`].
/// `dir_x/y/z` — extrusion direction vector (magnitude = total extrusion length).
/// `layers` — number of equal slices along the extrusion direction.
///
/// Returns a JSON object `{ points: [{x,y,z}, …], tets: [{v:[a,b,c,d]}, …] }`.
#[wasm_bindgen]
pub fn extrude_mesh(
    mesh2d_json: &str,
    dir_x: f64,
    dir_y: f64,
    dir_z: f64,
    layers: usize,
) -> Result<String, JsError> {
    let mesh2d: kofem_mesh::Mesh2D =
        serde_json::from_str(mesh2d_json).map_err(|e| JsError::new(&e.to_string()))?;

    if layers == 0 {
        return Err(JsError::new("layers must be ≥ 1"));
    }

    let mesh3d = extrude(&mesh2d, [dir_x, dir_y, dir_z], layers);
    serde_json::to_string(&mesh3d).map_err(|e| JsError::new(&e.to_string()))
}
