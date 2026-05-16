use kofem_geom::step::topology::{TopoEdge, TopoFace};
use kofem_geom::step::{parse, BRep};
use kofem_geom::tess::{fan_tessellate, tessellate, TessOptions};

fn make_square_face() -> TopoFace {
    TopoFace {
        surface_id: 0,
        same_sense: true,
        outer_loop: vec![
            TopoEdge {
                curve_id: 0,
                start: [0.0, 0.0, 0.0],
                end: [1.0, 0.0, 0.0],
                reversed: false,
            },
            TopoEdge {
                curve_id: 0,
                start: [1.0, 0.0, 0.0],
                end: [1.0, 1.0, 0.0],
                reversed: false,
            },
            TopoEdge {
                curve_id: 0,
                start: [1.0, 1.0, 0.0],
                end: [0.0, 1.0, 0.0],
                reversed: false,
            },
            TopoEdge {
                curve_id: 0,
                start: [0.0, 1.0, 0.0],
                end: [0.0, 0.0, 0.0],
                reversed: false,
            },
        ],
        inner_loops: vec![],
    }
}

fn load_bracket() -> (kofem_geom::step::StepFile, BRep) {
    let file = parse(include_str!("../../../test_files/new_bracket_2.stp")).unwrap();
    let brep = BRep::extract(&file).unwrap();
    (file, brep)
}

#[test]
fn fan_triangulate_planar_face() {
    let face = make_square_face();
    let mesh = fan_tessellate(&face);
    assert_eq!(mesh.triangles.len(), 2, "4-vertex polygon → 2 triangles");
    for tri in &mesh.triangles {
        assert!(tri.iter().all(|&i| i < mesh.points.len()));
    }
}

#[test]
fn bracket_tessellation_triangle_count() {
    let (file, brep) = load_bracket();
    let mesh = tessellate(&brep, &file, TessOptions::default()).unwrap();
    assert!(
        mesh.triangles.len() > 1_000,
        "expected many triangles, got {}",
        mesh.triangles.len()
    );
}

#[test]
fn no_degenerate_triangles() {
    let (file, brep) = load_bracket();
    let mesh = tessellate(&brep, &file, TessOptions::default()).unwrap();
    for &[a, b, c] in &mesh.triangles {
        let pa = mesh.points[a];
        let pb = mesh.points[b];
        let pc = mesh.points[c];
        let ab = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
        let ac = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
        let cross_len = ((ab[1] * ac[2] - ab[2] * ac[1]).powi(2)
            + (ab[2] * ac[0] - ab[0] * ac[2]).powi(2)
            + (ab[0] * ac[1] - ab[1] * ac[0]).powi(2))
        .sqrt();
        assert!(cross_len > 1e-10, "degenerate triangle {a},{b},{c}");
    }
}
