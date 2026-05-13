use kofem_core::io::inp::parse_inp;

const CANTILEVER_INP: &str = include_str!("../../../examples/inp/cantilever_chexa8.inp");

const SIMPLE_INP: &str = include_str!("../../../examples/inp/simple_cantilever.inp");

#[test]
fn cantilever_chexa8_node_count() {
    let m = parse_inp(CANTILEVER_INP).unwrap();
    assert_eq!(m.nodes.len(), 99, "expected 99 nodes");
    assert_eq!(m.elements.len(), 40, "expected 40 elements");
}

#[test]
fn cantilever_chexa8_all_elements_are_chexa() {
    let m = parse_inp(CANTILEVER_INP).unwrap();
    for el in &m.elements {
        assert_eq!(el.kind, "CHEXA", "element {} should be CHEXA", el.id);
        assert_eq!(
            el.node_ids.len(),
            8,
            "element {} should have 8 nodes",
            el.id
        );
    }
}

#[test]
fn cantilever_chexa8_material() {
    let m = parse_inp(CANTILEVER_INP).unwrap();
    assert_eq!(m.materials.len(), 1);
    let mat = &m.materials[0];
    assert_eq!(mat.name, "Steel");
    assert!((mat.young - 210e9).abs() < 1e3, "E should be 210 GPa");
    assert!((mat.poisson - 0.3).abs() < 1e-9);
    assert!((mat.density - 7850.0).abs() < 0.1);
}

#[test]
fn cantilever_chexa8_boundary_conditions() {
    let m = parse_inp(CANTILEVER_INP).unwrap();
    // 9 nodes on left face × 3 DOF (Ux, Uy, Uz) = 27 constraints
    assert_eq!(m.constraints.len(), 27);
    assert!(
        m.constraints.iter().all(|c| c.prescribed_value == 0.0),
        "all BCs should be zero displacement"
    );
}

#[test]
fn cantilever_chexa8_loads() {
    let m = parse_inp(CANTILEVER_INP).unwrap();
    assert_eq!(m.loads.len(), 9, "9 loaded nodes on right face");
    assert!(
        m.loads.iter().all(|l| l.dof == 1),
        "all loads should be Uy (dof=1)"
    );
    let total: f64 = m.loads.iter().map(|l| l.value).sum();
    assert!((total + 10_000.0).abs() < 1.0, "total Fy should be -10 kN");
}

#[test]
fn cantilever_chexa8_property_assignment() {
    let m = parse_inp(CANTILEVER_INP).unwrap();
    assert_eq!(m.properties.len(), 1);
    assert_eq!(m.properties[0].kind, "PSOLID");
    let prop_id = m.properties[0].id;
    assert!(
        m.elements.iter().all(|e| e.property_id == prop_id),
        "all elements should reference the PSOLID property"
    );
}

#[test]
fn simple_cantilever_parses() {
    let m = parse_inp(SIMPLE_INP).unwrap();
    assert_eq!(m.nodes.len(), 12);
    assert_eq!(m.elements.len(), 2);
    assert_eq!(m.constraints.len(), 12); // 4 nodes × 3 DOF
    assert_eq!(m.loads.len(), 4);
    let total: f64 = m.loads.iter().map(|l| l.value).sum();
    assert!((total + 10_000.0).abs() < 1.0);
}
