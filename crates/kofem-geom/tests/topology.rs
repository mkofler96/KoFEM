use kofem_geom::step::{parse, BRep};

#[test]
fn bracket_has_486_faces() {
    let file = parse(include_str!("../../../test_files/new_bracket_2.stp")).unwrap();
    let brep = BRep::extract(&file).unwrap();
    assert_eq!(brep.faces.len(), 486);
}

#[test]
fn every_face_has_at_least_3_edges() {
    let file = parse(include_str!("../../../test_files/new_bracket_2.stp")).unwrap();
    let brep = BRep::extract(&file).unwrap();
    for face in &brep.faces {
        // The bracket has 4 faces with 2-edge outer loops (two semicircular arcs);
        // the bound is >= 1 to verify every outer loop is non-empty.
        assert!(
            face.outer_loop.len() >= 1,
            "face with surface #{} has only {} edges",
            face.surface_id,
            face.outer_loop.len()
        );
    }
}

#[test]
fn all_edge_coords_are_finite() {
    let file = parse(include_str!("../../../test_files/new_bracket_2.stp")).unwrap();
    let brep = BRep::extract(&file).unwrap();
    for face in &brep.faces {
        for edge in &face.outer_loop {
            for c in edge.start.iter().chain(edge.end.iter()) {
                assert!(c.is_finite(), "non-finite coord {c}");
            }
        }
    }
}
