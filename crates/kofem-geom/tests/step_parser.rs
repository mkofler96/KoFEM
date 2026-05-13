use kofem_geom::step::{parse, Arg};

#[test]
fn parses_bracket_entity_count() {
    let file = parse(include_str!("../../../test_files/new_bracket_2.stp")).unwrap();
    assert!(file.len() > 30_000);
}

#[test]
fn parses_cartesian_point_coords() {
    let snippet = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''));\nENDSEC;\nDATA;\n\
        #97=CARTESIAN_POINT('',(4.388981755810E-8,1.467728130595E1,3.159218055376E1));\n\
        ENDSEC;\nEND-ISO-10303-21;";
    let file = parse(snippet).unwrap();
    let e = file.get(&97).unwrap();
    assert_eq!(e.type_name, "CARTESIAN_POINT");
    if let Arg::List(coords) = &e.args[1] {
        assert_eq!(coords.len(), 3);
        if let Arg::Real(x) = coords[0] {
            assert!((x - 4.388981755810E-8).abs() < 1e-15);
        } else {
            panic!("expected Real for x coord");
        }
    } else {
        panic!("expected List");
    }
}

#[test]
fn bracket_has_486_advanced_faces() {
    let file = parse(include_str!("../../../test_files/new_bracket_2.stp")).unwrap();
    let n = file
        .values()
        .filter(|e| e.type_name == "ADVANCED_FACE")
        .count();
    assert_eq!(n, 486);
}
