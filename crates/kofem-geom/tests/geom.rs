use kofem_geom::{
    geom::{curve_from_step, surface_from_step, GeomError},
    step::parse,
};

/// All surface and curve entities in the bracket STEP file must either
/// succeed or return an Unsupported error — never panic.
#[test]
fn bracket_all_surfaces_parse_without_panic() {
    let file = parse(include_str!("../../../test_files/new_bracket_2.stp")).unwrap();

    let surface_types = [
        "PLANE",
        "CYLINDRICAL_SURFACE",
        "CONICAL_SURFACE",
        "TOROIDAL_SURFACE",
        "SPHERICAL_SURFACE",
        "B_SPLINE_SURFACE_WITH_KNOTS",
        "SURFACE_OF_LINEAR_EXTRUSION",
    ];

    let mut ids: Vec<u64> = file
        .values()
        .filter(|e| surface_types.contains(&e.type_name.as_str()))
        .map(|e| e.id)
        .collect();
    ids.sort_unstable();

    let mut ok = 0u32;
    let mut unsupported = 0u32;
    for id in ids {
        match surface_from_step(id, &file) {
            Ok(_) => ok += 1,
            Err(GeomError::Unsupported(_, _)) => unsupported += 1,
            Err(e) => panic!("surface #{id} failed: {e}"),
        }
    }
    assert!(ok > 0, "expected at least one successful surface parse");
    let _ = unsupported; // known-unsupported types are tolerated
}

#[test]
fn bracket_all_curves_parse_without_panic() {
    let file = parse(include_str!("../../../test_files/new_bracket_2.stp")).unwrap();

    let curve_types = ["LINE", "CIRCLE", "B_SPLINE_CURVE_WITH_KNOTS"];

    let mut ids: Vec<u64> = file
        .values()
        .filter(|e| curve_types.contains(&e.type_name.as_str()))
        .map(|e| e.id)
        .collect();
    ids.sort_unstable();

    let mut ok = 0u32;
    for id in &ids {
        match curve_from_step(*id, &file) {
            Ok(_) => ok += 1,
            Err(GeomError::Unsupported(_, _)) => {}
            Err(e) => panic!("curve #{id} failed: {e}"),
        }
    }
    assert!(ok > 0, "expected at least one successful curve parse");
}

/// Spot-check: every successfully parsed surface must return finite point
/// coordinates when evaluated at the midpoint of its parameter domain.
#[test]
fn bracket_surfaces_return_finite_points() {
    let file = parse(include_str!("../../../test_files/new_bracket_2.stp")).unwrap();

    let surface_types = [
        "PLANE",
        "CYLINDRICAL_SURFACE",
        "CONICAL_SURFACE",
        "TOROIDAL_SURFACE",
        "SPHERICAL_SURFACE",
        "B_SPLINE_SURFACE_WITH_KNOTS",
        "SURFACE_OF_LINEAR_EXTRUSION",
    ];

    let mut ids: Vec<u64> = file
        .values()
        .filter(|e| surface_types.contains(&e.type_name.as_str()))
        .map(|e| e.id)
        .collect();
    ids.sort_unstable();

    for id in ids {
        let surf = match surface_from_step(id, &file) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let (u0, u1) = surf.u_bounds();
        let (v0, v1) = surf.v_bounds();
        // Use a finite test point; for infinite-bound surfaces use 0.0
        let u_mid = if u0.is_finite() && u1.is_finite() {
            (u0 + u1) / 2.0
        } else {
            0.0
        };
        let v_mid = if v0.is_finite() && v1.is_finite() {
            (v0 + v1) / 2.0
        } else {
            0.0
        };
        let p = surf.point(u_mid, v_mid);
        assert!(
            p.iter().all(|x| x.is_finite()),
            "surface #{id} returned non-finite point {p:?} at ({u_mid},{v_mid})"
        );
    }
}
