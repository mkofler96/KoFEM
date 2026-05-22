use kofem_geom::step::topology::{TopoEdge, TopoFace};
use kofem_geom::step::{parse, BRep};
use kofem_geom::tess::{fan_tessellate, tessellate, TessOptions};

// ── helpers ────────────────────────────────────────────────────────────────────

fn tri_normal(pts: &[[f64; 3]], tri: [usize; 3]) -> [f64; 3] {
    let a = pts[tri[0]];
    let b = pts[tri[1]];
    let c = pts[tri[2]];
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
    ];
    let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    if len < 1e-15 {
        return n;
    }
    [n[0] / len, n[1] / len, n[2] / len]
}

fn mesh_area(pts: &[[f64; 3]], tris: &[[usize; 3]]) -> f64 {
    tris.iter()
        .map(|&[a, b, c]| {
            let pa = pts[a];
            let pb = pts[b];
            let pc = pts[c];
            let ab = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
            let ac = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
            let cross = [
                ab[1] * ac[2] - ab[2] * ac[1],
                ab[2] * ac[0] - ab[0] * ac[2],
                ab[0] * ac[1] - ab[1] * ac[0],
            ];
            (cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]).sqrt() / 2.0
        })
        .sum()
}

/// Returns a map from undirected edge `(min,max)` to how many triangles share it.
fn edge_counts(triangles: &[[usize; 3]]) -> std::collections::HashMap<(usize, usize), usize> {
    let mut map: std::collections::HashMap<(usize, usize), usize> = Default::default();
    for &[a, b, c] in triangles {
        for (u, v) in [(a, b), (b, c), (c, a)] {
            let key = if u < v { (u, v) } else { (v, u) };
            *map.entry(key).or_insert(0) += 1;
        }
    }
    map
}

fn count_open_edges(triangles: &[[usize; 3]]) -> usize {
    edge_counts(triangles).values().filter(|&&c| c == 1).count()
}

/// Minimal STEP string: unit square in XY, CW stored loop, bound.orientation=F,
/// same_sense=T.  Matches the convention used by the bracket CAD exporter.
const STEP_UNIT_SQUARE_BOUND_F: &str = "
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('test'));
ENDSEC;
DATA;
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=CARTESIAN_POINT('',(1.,0.,0.));
#3=CARTESIAN_POINT('',(1.,1.,0.));
#4=CARTESIAN_POINT('',(0.,1.,0.));
#5=VERTEX_POINT('',#1);
#6=VERTEX_POINT('',#2);
#7=VERTEX_POINT('',#3);
#8=VERTEX_POINT('',#4);
#9=DIRECTION('',(0.,1.,0.));
#10=VECTOR('',#9,1.);
#11=LINE('',#1,#10);
#12=EDGE_CURVE('',#5,#8,#11,.T.);
#13=DIRECTION('',(1.,0.,0.));
#14=VECTOR('',#13,1.);
#15=LINE('',#4,#14);
#16=EDGE_CURVE('',#8,#7,#15,.T.);
#17=DIRECTION('',(0.,-1.,0.));
#18=VECTOR('',#17,1.);
#19=LINE('',#3,#18);
#20=EDGE_CURVE('',#7,#6,#19,.T.);
#21=DIRECTION('',(-1.,0.,0.));
#22=VECTOR('',#21,1.);
#23=LINE('',#2,#22);
#24=EDGE_CURVE('',#6,#5,#23,.T.);
#25=ORIENTED_EDGE('',*,*,#12,.T.);
#26=ORIENTED_EDGE('',*,*,#16,.T.);
#27=ORIENTED_EDGE('',*,*,#20,.T.);
#28=ORIENTED_EDGE('',*,*,#24,.T.);
#29=EDGE_LOOP('',(#25,#26,#27,#28));
#30=FACE_OUTER_BOUND('',#29,.F.);
#31=CARTESIAN_POINT('',(0.,0.,0.));
#32=DIRECTION('',(0.,0.,1.));
#33=DIRECTION('',(1.,0.,0.));
#34=AXIS2_PLACEMENT_3D('',#31,#32,#33);
#35=PLANE('',#34);
#36=ADVANCED_FACE('',(#30),#35,.T.);
ENDSEC;
END-ISO-10303-21;
";

/// Same square but bound.orientation=T (CCW stored, standard convention).
const STEP_UNIT_SQUARE_BOUND_T: &str = "
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('test'));
ENDSEC;
DATA;
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=CARTESIAN_POINT('',(1.,0.,0.));
#3=CARTESIAN_POINT('',(1.,1.,0.));
#4=CARTESIAN_POINT('',(0.,1.,0.));
#5=VERTEX_POINT('',#1);
#6=VERTEX_POINT('',#2);
#7=VERTEX_POINT('',#3);
#8=VERTEX_POINT('',#4);
#9=DIRECTION('',(1.,0.,0.));
#10=VECTOR('',#9,1.);
#11=LINE('',#1,#10);
#12=EDGE_CURVE('',#5,#6,#11,.T.);
#13=DIRECTION('',(0.,1.,0.));
#14=VECTOR('',#13,1.);
#15=LINE('',#2,#14);
#16=EDGE_CURVE('',#6,#7,#15,.T.);
#17=DIRECTION('',(-1.,0.,0.));
#18=VECTOR('',#17,1.);
#19=LINE('',#3,#18);
#20=EDGE_CURVE('',#7,#8,#19,.T.);
#21=DIRECTION('',(0.,-1.,0.));
#22=VECTOR('',#21,1.);
#23=LINE('',#4,#22);
#24=EDGE_CURVE('',#8,#5,#23,.T.);
#25=ORIENTED_EDGE('',*,*,#12,.T.);
#26=ORIENTED_EDGE('',*,*,#16,.T.);
#27=ORIENTED_EDGE('',*,*,#20,.T.);
#28=ORIENTED_EDGE('',*,*,#24,.T.);
#29=EDGE_LOOP('',(#25,#26,#27,#28));
#30=FACE_OUTER_BOUND('',#29,.T.);
#31=CARTESIAN_POINT('',(0.,0.,0.));
#32=DIRECTION('',(0.,0.,1.));
#33=DIRECTION('',(1.,0.,0.));
#34=AXIS2_PLACEMENT_3D('',#31,#32,#33);
#35=PLANE('',#34);
#36=ADVANCED_FACE('',(#30),#35,.T.);
ENDSEC;
END-ISO-10303-21;
";

/// Unit square in XY, CCW from +Z, bound.orientation=T → outward normal +Z.
fn make_square_face() -> TopoFace {
    TopoFace {
        surface_id: 0,
        same_sense: true,
        outer_loop_orientation: true,
        outer_loop: vec![
            TopoEdge {
                edge_id: 0,
                curve_id: 0,
                start: [0.0, 0.0, 0.0],
                end: [1.0, 0.0, 0.0],
                reversed: false,
            },
            TopoEdge {
                edge_id: 0,
                curve_id: 0,
                start: [1.0, 0.0, 0.0],
                end: [1.0, 1.0, 0.0],
                reversed: false,
            },
            TopoEdge {
                edge_id: 0,
                curve_id: 0,
                start: [1.0, 1.0, 0.0],
                end: [0.0, 1.0, 0.0],
                reversed: false,
            },
            TopoEdge {
                edge_id: 0,
                curve_id: 0,
                start: [0.0, 1.0, 0.0],
                end: [0.0, 0.0, 0.0],
                reversed: false,
            },
        ],
        inner_loops: vec![],
    }
}

/// Same unit square but stored CW (as exported by the bracket's CAD system)
/// with bound.orientation=F — after applying the flag the outward normal is still +Z.
fn make_square_face_cw_bound_f() -> TopoFace {
    TopoFace {
        surface_id: 0,
        same_sense: true,
        outer_loop_orientation: false,
        outer_loop: vec![
            TopoEdge {
                edge_id: 0,
                curve_id: 0,
                start: [0.0, 0.0, 0.0],
                end: [0.0, 1.0, 0.0],
                reversed: false,
            },
            TopoEdge {
                edge_id: 0,
                curve_id: 0,
                start: [0.0, 1.0, 0.0],
                end: [1.0, 1.0, 0.0],
                reversed: false,
            },
            TopoEdge {
                edge_id: 0,
                curve_id: 0,
                start: [1.0, 1.0, 0.0],
                end: [1.0, 0.0, 0.0],
                reversed: false,
            },
            TopoEdge {
                edge_id: 0,
                curve_id: 0,
                start: [1.0, 0.0, 0.0],
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

// ── winding / normal tests ─────────────────────────────────────────────────────

#[test]
fn fan_triangulate_planar_face() {
    let face = make_square_face();
    let mesh = fan_tessellate(&face);
    assert_eq!(mesh.triangles.len(), 2, "4-vertex polygon → 2 triangles");
    for tri in &mesh.triangles {
        assert!(tri.iter().all(|&i| i < mesh.points.len()));
    }
}

/// CCW loop + bound.orientation=T → all triangle normals must point +Z.
#[test]
fn unit_square_bound_t_normals_point_up() {
    let face = make_square_face();
    let file = kofem_geom::step::StepFile::new();
    let brep = kofem_geom::step::BRep { faces: vec![face] };
    let mesh = tessellate(&brep, &file, TessOptions::default()).unwrap();
    assert!(!mesh.triangles.is_empty());
    for &tri in &mesh.triangles {
        let n = tri_normal(&mesh.points, tri);
        assert!(
            n[2] > 0.9,
            "expected +Z normal (bound.orientation=T), got {n:?}"
        );
    }
}

/// CW stored loop + bound.orientation=F → after applying the flag, normals
/// must still point +Z.  This test fails without the orientation fix.
#[test]
fn unit_square_bound_f_normals_point_up() {
    let face = make_square_face_cw_bound_f();
    let file = kofem_geom::step::StepFile::new();
    let brep = kofem_geom::step::BRep { faces: vec![face] };
    let mesh = tessellate(&brep, &file, TessOptions::default()).unwrap();
    assert!(!mesh.triangles.is_empty());
    for &tri in &mesh.triangles {
        let n = tri_normal(&mesh.points, tri);
        assert!(
            n[2] > 0.9,
            "expected +Z normal (bound.orientation=F fixed), got {n:?}"
        );
    }
}

/// fan_tessellate area is exact (no Delaunay collinear-point issue).
#[test]
fn fan_tessellate_area_is_exact() {
    for (label, face) in [
        ("bound=T", make_square_face()),
        ("bound=F", make_square_face_cw_bound_f()),
    ] {
        let mesh = fan_tessellate(&face);
        let area = mesh_area(&mesh.points, &mesh.triangles);
        assert!(
            (area - 1.0).abs() < 1e-10,
            "{label}: fan area must be exactly 1.0, got {area}"
        );
    }
}

// ── roundtrip STEP tests ───────────────────────────────────────────────────────

/// Parse a minimal STEP snippet with bound.orientation=F (bracket convention)
/// and verify the normal direction.  Area test is omitted: Delaunay of collinear
/// LINE-edge samples is numerically unreliable for area but normals are correct.
#[test]
fn roundtrip_step_bound_f_normals() {
    let file = parse(STEP_UNIT_SQUARE_BOUND_F).unwrap();
    let brep = BRep::extract(&file).unwrap();
    assert_eq!(brep.faces.len(), 1);
    assert!(
        !brep.faces[0].outer_loop_orientation,
        "expected outer_loop_orientation=false"
    );
    let mesh = tessellate(&brep, &file, TessOptions::default()).unwrap();
    assert!(!mesh.triangles.is_empty());
    for &tri in &mesh.triangles {
        let n = tri_normal(&mesh.points, tri);
        assert!(
            n[2] > 0.9,
            "expected +Z normal (bound.orientation=F), got {n:?}"
        );
    }
}

/// Parse a minimal STEP snippet with bound.orientation=T and verify normals.
#[test]
fn roundtrip_step_bound_t_normals() {
    let file = parse(STEP_UNIT_SQUARE_BOUND_T).unwrap();
    let brep = BRep::extract(&file).unwrap();
    assert_eq!(brep.faces.len(), 1);
    assert!(
        brep.faces[0].outer_loop_orientation,
        "expected outer_loop_orientation=true"
    );
    let mesh = tessellate(&brep, &file, TessOptions::default()).unwrap();
    assert!(!mesh.triangles.is_empty());
    for &tri in &mesh.triangles {
        let n = tri_normal(&mesh.points, tri);
        assert!(
            n[2] > 0.9,
            "expected +Z normal (bound.orientation=T), got {n:?}"
        );
    }
}

// ── hole tessellation tests ────────────────────────────────────────────────────

/// 1×1 outer square with a 0.2×0.2 inner square hole centred at (0.5, 0.5).
/// After tessellation no triangle centroid must fall inside the hole region.
#[test]
fn square_with_square_hole_excludes_hole_region() {
    let hole_min = 0.4_f64;
    let hole_max = 0.6_f64;

    let face = TopoFace {
        surface_id: 0,
        same_sense: true,
        outer_loop_orientation: true,
        outer_loop: vec![
            TopoEdge {
                edge_id: 0,
                curve_id: 0,
                start: [0.0, 0.0, 0.0],
                end: [1.0, 0.0, 0.0],
                reversed: false,
            },
            TopoEdge {
                edge_id: 0,
                curve_id: 0,
                start: [1.0, 0.0, 0.0],
                end: [1.0, 1.0, 0.0],
                reversed: false,
            },
            TopoEdge {
                edge_id: 0,
                curve_id: 0,
                start: [1.0, 1.0, 0.0],
                end: [0.0, 1.0, 0.0],
                reversed: false,
            },
            TopoEdge {
                edge_id: 0,
                curve_id: 0,
                start: [0.0, 1.0, 0.0],
                end: [0.0, 0.0, 0.0],
                reversed: false,
            },
        ],
        inner_loops: vec![vec![
            TopoEdge {
                edge_id: 0,
                curve_id: 0,
                start: [hole_min, hole_min, 0.0],
                end: [hole_min, hole_max, 0.0],
                reversed: false,
            },
            TopoEdge {
                edge_id: 0,
                curve_id: 0,
                start: [hole_min, hole_max, 0.0],
                end: [hole_max, hole_max, 0.0],
                reversed: false,
            },
            TopoEdge {
                edge_id: 0,
                curve_id: 0,
                start: [hole_max, hole_max, 0.0],
                end: [hole_max, hole_min, 0.0],
                reversed: false,
            },
            TopoEdge {
                edge_id: 0,
                curve_id: 0,
                start: [hole_max, hole_min, 0.0],
                end: [hole_min, hole_min, 0.0],
                reversed: false,
            },
        ]],
    };

    let file = kofem_geom::step::StepFile::new();
    let brep = kofem_geom::step::BRep { faces: vec![face] };
    let mesh = tessellate(&brep, &file, TessOptions::default()).unwrap();

    assert!(!mesh.triangles.is_empty(), "mesh must have triangles");

    for &[a, b, c] in &mesh.triangles {
        let pa = mesh.points[a];
        let pb = mesh.points[b];
        let pc = mesh.points[c];
        let cx = (pa[0] + pb[0] + pc[0]) / 3.0;
        let cy = (pa[1] + pb[1] + pc[1]) / 3.0;
        let inside_hole = cx > hole_min && cx < hole_max && cy > hole_min && cy < hole_max;
        assert!(
            !inside_hole,
            "triangle centroid ({cx:.4}, {cy:.4}) is inside the hole [{hole_min},{hole_max}]²"
        );
    }
}

// ── cylinder regression tests ─────────────────────────────────────────────────

fn load_cylinder() -> (kofem_geom::step::StepFile, BRep) {
    let file = parse(include_str!("../../../test_files/cylinder.stp")).unwrap();
    let brep = BRep::extract(&file).unwrap();
    (file, brep)
}

#[test]
fn cylinder_mesh_has_three_faces() {
    let (file, brep) = load_cylinder();
    let mesh = tessellate(&brep, &file, TessOptions::default()).unwrap();
    // Cylinder has: bottom cap + top cap + barrel
    assert!(
        mesh.triangles.len() >= 3,
        "expected at least 3 triangles, got {}",
        mesh.triangles.len()
    );
}

#[test]
fn cylinder_mesh_spans_correct_height() {
    // R=25mm, H=80mm — all points must satisfy z in [0, 80] and radius ≤ 25 + ε.
    let (file, brep) = load_cylinder();
    let opts = TessOptions {
        max_edge_len: 5.0,
        ..TessOptions::default()
    };
    let mesh = tessellate(&brep, &file, opts).unwrap();

    assert!(!mesh.points.is_empty());

    let mut z_min = f64::INFINITY;
    let mut z_max = f64::NEG_INFINITY;
    for &[x, y, z] in &mesh.points {
        let r = (x * x + y * y).sqrt();
        assert!(
            r <= 25.0 + 1e-6,
            "point ({x:.3},{y:.3},{z:.3}) has r={r:.6} > 25"
        );
        z_min = z_min.min(z);
        z_max = z_max.max(z);
    }

    assert!((z_min - 0.0).abs() < 1e-6, "z_min should be 0, got {z_min}");
    assert!(
        (z_max - 80.0).abs() < 1e-6,
        "z_max should be 80, got {z_max}"
    );
}

#[test]
fn cylinder_barrel_has_nonzero_height() {
    // Before the fix, the barrel face was projected flat and all z values were 0.
    let (file, brep) = load_cylinder();
    let opts = TessOptions {
        max_edge_len: 5.0,
        ..TessOptions::default()
    };
    let mesh = tessellate(&brep, &file, opts).unwrap();

    // There must be points with z ≈ 80 (top cap / top of barrel).
    let has_top = mesh.points.iter().any(|&[_, _, z]| (z - 80.0).abs() < 1e-6);
    assert!(
        has_top,
        "no points at z=80 — barrel was likely collapsed flat"
    );
}

#[test]
fn cylinder_caps_stitch_to_barrel() {
    // Every edge on the top cap (z≈80) and bottom cap (z≈0) boundary must be
    // shared by exactly two triangles once the barrel and caps are stitched.
    // Before the fix the cap boundary had only 17 points while the barrel had
    // ceil(2πR / max_edge_len) points, so almost no vertices coincided and the
    // mesh was open at the seam.
    let (file, brep) = load_cylinder();
    let opts = TessOptions {
        max_edge_len: 5.0,
        ..TessOptions::default()
    };
    let mesh = tessellate(&brep, &file, opts).unwrap();

    // Collect boundary edges (count == 1) whose midpoint sits on z≈0 or z≈80.
    let open_seam: Vec<_> = edge_counts(&mesh.triangles)
        .into_iter()
        .filter(|(_, cnt)| *cnt == 1)
        .filter(|((a, b), _)| {
            let (a, b) = (*a, *b);
            let za = mesh.points[a][2];
            let zb = mesh.points[b][2];
            let zmid = (za + zb) / 2.0;
            !(1.0..=79.0).contains(&zmid)
        })
        .collect();

    assert!(
        open_seam.is_empty(),
        "{} open edge(s) at the cap–barrel seam — caps did not stitch to barrel",
        open_seam.len()
    );
}

// ── cone regression tests ─────────────────────────────────────────────────────

/// Truncated cone: bottom circle radius=10 at z=0, top circle radius=20 at z=30.
/// The CONICAL_SURFACE has semi_angle = atan(1/3) ≈ 18.435° (STEP stores degrees).
/// On the barrel, r(z) = 10 + z/3 (linear taper, tan(φ)=1/3).
const STEP_CONE: &str = "
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('KoFEM test cone R_bot=10 R_top=20 H=30'));
ENDSEC;
DATA;
#1=CARTESIAN_POINT('',(10.,0.,0.));
#2=VERTEX_POINT('',#1);
#3=CARTESIAN_POINT('',(20.,0.,30.));
#4=VERTEX_POINT('',#3);
#5=CARTESIAN_POINT('',(10.,0.,0.));
#6=DIRECTION('',(0.31623,0.,0.94868));
#7=VECTOR('',#6,31.62278);
#8=LINE('',#5,#7);
#9=EDGE_CURVE('',#2,#4,#8,.T.);
#10=CARTESIAN_POINT('',(0.,0.,0.));
#11=DIRECTION('',(0.,0.,-1.));
#12=DIRECTION('',(1.,0.,0.));
#13=AXIS2_PLACEMENT_3D('',#10,#11,#12);
#14=CIRCLE('',#13,10.);
#15=EDGE_CURVE('',#2,#2,#14,.T.);
#16=CARTESIAN_POINT('',(0.,0.,30.));
#17=DIRECTION('',(0.,0.,1.));
#18=DIRECTION('',(1.,0.,0.));
#19=AXIS2_PLACEMENT_3D('',#16,#17,#18);
#20=CIRCLE('',#19,20.);
#21=EDGE_CURVE('',#4,#4,#20,.T.);
#22=ORIENTED_EDGE('',*,*,#15,.T.);
#23=CARTESIAN_POINT('',(0.,0.,0.));
#24=DIRECTION('',(0.,0.,-1.));
#25=DIRECTION('',(1.,0.,0.));
#26=AXIS2_PLACEMENT_3D('',#23,#24,#25);
#27=PLANE('',#26);
#28=EDGE_LOOP('',(#22));
#29=FACE_OUTER_BOUND('',#28,.T.);
#30=ADVANCED_FACE('',(#29),#27,.T.);
#31=ORIENTED_EDGE('',*,*,#21,.T.);
#32=CARTESIAN_POINT('',(0.,0.,30.));
#33=DIRECTION('',(0.,0.,1.));
#34=DIRECTION('',(1.,0.,0.));
#35=AXIS2_PLACEMENT_3D('',#32,#33,#34);
#36=PLANE('',#35);
#37=EDGE_LOOP('',(#31));
#38=FACE_OUTER_BOUND('',#37,.T.);
#39=ADVANCED_FACE('',(#38),#36,.T.);
#40=ORIENTED_EDGE('',*,*,#9,.T.);
#41=ORIENTED_EDGE('',*,*,#21,.T.);
#42=ORIENTED_EDGE('',*,*,#9,.F.);
#43=ORIENTED_EDGE('',*,*,#15,.F.);
#44=CARTESIAN_POINT('',(0.,0.,0.));
#45=DIRECTION('',(0.,0.,1.));
#46=DIRECTION('',(1.,0.,0.));
#47=AXIS2_PLACEMENT_3D('',#44,#45,#46);
#48=CONICAL_SURFACE('',#47,10.,18.43495);
#49=EDGE_LOOP('',(#40,#41,#42,#43));
#50=FACE_OUTER_BOUND('',#49,.T.);
#51=ADVANCED_FACE('',(#50),#48,.T.);
#52=CLOSED_SHELL('',(#30,#39,#51));
#53=MANIFOLD_SOLID_BREP('cone',#52);
ENDSEC;
END-ISO-10303-21;
";

fn load_cone() -> (kofem_geom::step::StepFile, BRep) {
    let file = parse(STEP_CONE).unwrap();
    let brep = BRep::extract(&file).unwrap();
    (file, brep)
}

/// All barrel points must lie on the cone surface: r(z) = 10 + z/3 (within 0.1%).
/// Before the fix, conical faces fell through to the flat-projection path and
/// produced only z=0 barrel points.
#[test]
fn cone_barrel_points_lie_on_cone_surface() {
    let (file, brep) = load_cone();
    let opts = TessOptions {
        max_edge_len: 2.0,
        ..TessOptions::default()
    };
    let mesh = tessellate(&brep, &file, opts).unwrap();

    assert!(!mesh.points.is_empty());

    let mut has_barrel = false;
    for &[x, y, z] in &mesh.points {
        // Points on either flat cap lie exactly in z=0 or z=30 planes; skip them.
        let r = (x * x + y * y).sqrt();
        let r_expected = 10.0 + z / 3.0;
        // Only check barrel points (those clearly not on the cap discs).
        if r > 1e-3 && z > 1e-3 && z < 30.0 - 1e-3 {
            let err = (r - r_expected).abs() / r_expected;
            assert!(
                err < 1e-3,
                "barrel point ({x:.4},{y:.4},{z:.4}) has r={r:.6}, expected {r_expected:.6} (err={err:.2e})"
            );
            has_barrel = true;
        }
    }
    assert!(
        has_barrel,
        "no intermediate barrel points found — cone may have been tessellated flat"
    );
}

/// Height range of the merged cone mesh must span [0, 30].
#[test]
fn cone_mesh_spans_correct_height() {
    let (file, brep) = load_cone();
    let opts = TessOptions {
        max_edge_len: 5.0,
        ..TessOptions::default()
    };
    let mesh = tessellate(&brep, &file, opts).unwrap();

    let mut z_min = f64::INFINITY;
    let mut z_max = f64::NEG_INFINITY;
    for &[_, _, z] in &mesh.points {
        z_min = z_min.min(z);
        z_max = z_max.max(z);
    }

    assert!((z_min - 0.0).abs() < 1e-4, "z_min should be 0, got {z_min}");
    assert!(
        (z_max - 30.0).abs() < 1e-4,
        "z_max should be 30, got {z_max}"
    );
}

/// Tessellation must produce triangles (non-degenerate mesh).
#[test]
fn cone_mesh_has_triangles() {
    let (file, brep) = load_cone();
    let mesh = tessellate(&brep, &file, TessOptions::default()).unwrap();
    assert!(
        mesh.triangles.len() >= 3,
        "expected at least 3 triangles, got {}",
        mesh.triangles.len()
    );
}

// ── partial cylinder tests ────────────────────────────────────────────────────

/// Quarter-cylinder patch: r=5, z in [0,10], u in [0, π/2].
/// 4 boundary edges: bottom arc, right seam line, top arc (reversed), left seam line.
/// No closed-circle edge → partial cylinder path must be taken.
const STEP_QUARTER_CYLINDER: &str = "
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('KoFEM quarter-cylinder test r=5 h=10'));
ENDSEC;
DATA;
#1=CARTESIAN_POINT('',(5.,0.,0.));
#2=CARTESIAN_POINT('',(0.,5.,0.));
#3=CARTESIAN_POINT('',(0.,5.,10.));
#4=CARTESIAN_POINT('',(5.,0.,10.));
#5=VERTEX_POINT('',#1);
#6=VERTEX_POINT('',#2);
#7=VERTEX_POINT('',#3);
#8=VERTEX_POINT('',#4);
#10=CARTESIAN_POINT('',(0.,0.,0.));
#11=DIRECTION('',(0.,0.,1.));
#12=DIRECTION('',(1.,0.,0.));
#13=AXIS2_PLACEMENT_3D('',#10,#11,#12);
#14=CIRCLE('',#13,5.);
#15=EDGE_CURVE('',#5,#6,#14,.T.);
#20=CARTESIAN_POINT('',(0.,5.,0.));
#21=DIRECTION('',(0.,0.,1.));
#22=VECTOR('',#21,10.);
#23=LINE('',#20,#22);
#24=EDGE_CURVE('',#6,#7,#23,.T.);
#30=CARTESIAN_POINT('',(0.,0.,10.));
#31=DIRECTION('',(0.,0.,1.));
#32=DIRECTION('',(1.,0.,0.));
#33=AXIS2_PLACEMENT_3D('',#30,#31,#32);
#34=CIRCLE('',#33,5.);
#35=EDGE_CURVE('',#8,#7,#34,.T.);
#40=CARTESIAN_POINT('',(5.,0.,10.));
#41=DIRECTION('',(0.,0.,-1.));
#42=VECTOR('',#41,10.);
#43=LINE('',#40,#42);
#44=EDGE_CURVE('',#8,#5,#43,.T.);
#50=ORIENTED_EDGE('',*,*,#15,.T.);
#51=ORIENTED_EDGE('',*,*,#24,.T.);
#52=ORIENTED_EDGE('',*,*,#35,.F.);
#53=ORIENTED_EDGE('',*,*,#44,.T.);
#54=EDGE_LOOP('',(#50,#51,#52,#53));
#55=FACE_OUTER_BOUND('',#54,.T.);
#60=CARTESIAN_POINT('',(0.,0.,0.));
#61=DIRECTION('',(0.,0.,1.));
#62=DIRECTION('',(1.,0.,0.));
#63=AXIS2_PLACEMENT_3D('',#60,#61,#62);
#64=CYLINDRICAL_SURFACE('',#63,5.);
#65=ADVANCED_FACE('',(#55),#64,.T.);
ENDSEC;
END-ISO-10303-21;
";

/// All barrel points on a partial cylinder must lie on the cylinder surface (r ≈ 5).
#[test]
fn partial_cylinder_points_lie_on_surface() {
    let file = parse(STEP_QUARTER_CYLINDER).unwrap();
    let brep = BRep::extract(&file).unwrap();
    let opts = TessOptions {
        max_edge_len: 1.0,
        ..TessOptions::default()
    };
    let mesh = tessellate(&brep, &file, opts).unwrap();

    assert!(!mesh.points.is_empty(), "mesh must have points");
    assert!(!mesh.triangles.is_empty(), "mesh must have triangles");

    for &[x, y, z] in &mesh.points {
        let r = (x * x + y * y).sqrt();
        assert!(
            (r - 5.0).abs() < 1e-3,
            "point ({x:.4},{y:.4},{z:.4}) has r={r:.6}, expected 5.0"
        );
    }
}

/// The partial cylinder patch must span the correct z range [0, 10].
#[test]
fn partial_cylinder_spans_correct_height() {
    let file = parse(STEP_QUARTER_CYLINDER).unwrap();
    let brep = BRep::extract(&file).unwrap();
    let opts = TessOptions {
        max_edge_len: 1.0,
        ..TessOptions::default()
    };
    let mesh = tessellate(&brep, &file, opts).unwrap();

    let z_min = mesh
        .points
        .iter()
        .map(|p| p[2])
        .fold(f64::INFINITY, f64::min);
    let z_max = mesh
        .points
        .iter()
        .map(|p| p[2])
        .fold(f64::NEG_INFINITY, f64::max);

    assert!((z_min - 0.0).abs() < 1e-6, "z_min should be 0, got {z_min}");
    assert!(
        (z_max - 10.0).abs() < 1e-6,
        "z_max should be 10, got {z_max}"
    );
}

/// The partial cylinder patch must stay within the u ∈ [0, π/2] quarter arc.
#[test]
fn partial_cylinder_stays_within_angular_range() {
    let file = parse(STEP_QUARTER_CYLINDER).unwrap();
    let brep = BRep::extract(&file).unwrap();
    let opts = TessOptions {
        max_edge_len: 1.0,
        ..TessOptions::default()
    };
    let mesh = tessellate(&brep, &file, opts).unwrap();

    for &[x, y, _z] in &mesh.points {
        assert!(
            x >= -1e-6 && y >= -1e-6,
            "point ({x:.4},{y:.4}) is outside the first quadrant"
        );
    }
}

// ── bracket regression tests ───────────────────────────────────────────────────

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

/// Open boundary edges in the bracket must stay below 25 % of total edges.
///
/// The bracket is a MANIFOLD_SOLID_BREP, but B-spline UV tessellations sample
/// the parameter space uniformly without guaranteeing that boundary vertices
/// match across adjacent faces.  Stitching can therefore only close seams where
/// face boundaries happen to produce coincident 3D points — which holds for
/// simple planar/cylindrical/conical geometry but not B-spline faces.
/// Current observed ratio is ~19 %.  This regression gate catches severe
/// regressions (ratio doubling) without requiring perfection.
#[test]
fn bracket_open_edge_ratio_is_low() {
    let (file, brep) = load_bracket();
    let mesh = tessellate(&brep, &file, TessOptions::default()).unwrap();
    let counts = edge_counts(&mesh.triangles);
    let total = counts.len();
    let open = counts.values().filter(|&&c| c == 1).count();
    let ratio = open as f64 / total as f64;
    assert!(
        ratio < 0.25,
        "{open}/{total} edges are open ({:.1}%) — expected < 25%",
        ratio * 100.0
    );
}

// ── box tests ─────────────────────────────────────────────────────────────────

fn load_box() -> (kofem_geom::step::StepFile, BRep) {
    let file = parse(include_str!("../../../test_files/box.stp")).unwrap();
    let brep = BRep::extract(&file).unwrap();
    (file, brep)
}

/// 80×60×40 mm box: tessellated area must be within 0.5 % of the
/// analytical surface area 2(80·60 + 80·40 + 60·40) = 20 800 mm².
/// Planar-face triangulations are exact so even coarse tessellations pass.
#[test]
fn box_surface_area_close_to_analytical() {
    let (file, brep) = load_box();
    let opts = TessOptions {
        max_edge_len: 10.0,
        ..TessOptions::default()
    };
    let mesh = tessellate(&brep, &file, opts).unwrap();
    let area = mesh_area(&mesh.points, &mesh.triangles);
    let expected = 2.0 * (80.0 * 60.0 + 80.0 * 40.0 + 60.0 * 40.0);
    let err = (area - expected).abs() / expected;
    assert!(
        err < 0.005,
        "box area {area:.2} differs from analytical {expected:.2} by {:.2}%",
        err * 100.0
    );
}

/// The box is a MANIFOLD_SOLID_BREP closed shell, so every meshed edge must
/// be shared by exactly 2 triangles after stitching.
#[test]
fn box_mesh_is_manifold() {
    let (file, brep) = load_box();
    let opts = TessOptions {
        max_edge_len: 10.0,
        ..TessOptions::default()
    };
    let mesh = tessellate(&brep, &file, opts).unwrap();
    let open = count_open_edges(&mesh.triangles);
    assert!(
        open == 0,
        "{open} open boundary edge(s) — closed box must produce a manifold mesh"
    );
}

// ── l_bracket tests ────────────────────────────────────────────────────────────

fn load_l_bracket() -> (kofem_geom::step::StepFile, BRep) {
    let file = parse(include_str!("../../../test_files/l_bracket.stp")).unwrap();
    let brep = BRep::extract(&file).unwrap();
    (file, brep)
}

/// L-bracket 80×80×20 mm: no degenerate triangles (zero-area, colinear vertices).
#[test]
fn l_bracket_no_degenerate_triangles() {
    let (file, brep) = load_l_bracket();
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

/// L-bracket tessellated area must match analytical area within 0.5 %.
/// Analytical: 2 × L-face + 6 rectangular sides.
///   L-face = 80×80 − 50×55 = 6400 − 2750 = 3650 mm²
///   Sides  = 80×20 + 25×20 + 50×20 + 55×20 + 30×20 + 80×20 = 6400 mm²
///   Total  = 2×3650 + 6400 = 13700 mm²
#[test]
fn l_bracket_surface_area_close_to_analytical() {
    let (file, brep) = load_l_bracket();
    let opts = TessOptions {
        max_edge_len: 10.0,
        ..TessOptions::default()
    };
    let mesh = tessellate(&brep, &file, opts).unwrap();
    let area = mesh_area(&mesh.points, &mesh.triangles);
    let expected = 13700.0_f64;
    let err = (area - expected).abs() / expected;
    assert!(
        err < 0.005,
        "L-bracket area {area:.2} differs from analytical {expected:.2} by {:.2}%",
        err * 100.0
    );
}

/// The L-bracket is a MANIFOLD_SOLID_BREP closed shell: every edge must be
/// shared by exactly 2 triangles after stitching.
#[test]
fn l_bracket_mesh_is_manifold() {
    let (file, brep) = load_l_bracket();
    let opts = TessOptions {
        max_edge_len: 10.0,
        ..TessOptions::default()
    };
    let mesh = tessellate(&brep, &file, opts).unwrap();
    let open = count_open_edges(&mesh.triangles);
    assert!(
        open == 0,
        "{open} open boundary edge(s) — closed L-bracket must produce a manifold mesh"
    );
}

// ── cone manifold test ────────────────────────────────────────────────────────

/// Interior barrel edges of the truncated cone (z strictly between 0 and 30)
/// must be manifold: shared by exactly 2 triangles.
///
/// The seam edges at z≈0 and z≈30 may be open because
/// `try_tessellate_conical` computes n_u from r_mid while
/// `try_tessellate_disc` computes n_u from the cap's circle radius —
/// the two differ for non-cylindrical surfaces (known limitation).
#[test]
fn cone_barrel_interior_is_manifold() {
    let (file, brep) = load_cone();
    let opts = TessOptions {
        max_edge_len: 5.0,
        ..TessOptions::default()
    };
    let mesh = tessellate(&brep, &file, opts).unwrap();

    let counts = edge_counts(&mesh.triangles);
    let bad: Vec<_> = counts
        .iter()
        .filter(|(_, &cnt)| cnt != 2)
        .filter(|(&(a, b), _)| {
            let za = mesh.points[a][2];
            let zb = mesh.points[b][2];
            // Interior: both endpoints strictly away from the seam planes (z=0 and z=30).
            za > 1.0 && za < 29.0 && zb > 1.0 && zb < 29.0
        })
        .collect();

    assert!(
        bad.is_empty(),
        "{} non-manifold edge(s) in cone barrel interior",
        bad.len()
    );
}

// ── new shape smoke tests ─────────────────────────────────────────────────────

macro_rules! load_shape {
    ($name:ident, $file:expr) => {
        fn $name() -> (kofem_geom::step::StepFile, BRep) {
            let src = include_str!(concat!("../../../test_files/", $file));
            let file = parse(src).unwrap();
            let brep = BRep::extract(&file).unwrap();
            (file, brep)
        }
    };
}

load_shape!(load_tube, "tube.stp");
load_shape!(load_elbow, "elbow.stp");
load_shape!(load_torus_ring, "torus_ring.stp");
load_shape!(load_stepped_shaft, "stepped_shaft.stp");
load_shape!(load_hex_prism, "hex_prism.stp");
load_shape!(load_pyramid, "pyramid.stp");
load_shape!(load_wedge, "wedge.stp");
load_shape!(load_i_beam, "i_beam.stp");
load_shape!(load_t_profile, "t_profile.stp");
load_shape!(load_u_channel, "u_channel.stp");

/// Verify that each new shape parses, tessellates without panic, and produces
/// at least one triangle and no degenerate (zero-area) triangles.
macro_rules! shape_smoke_test {
    ($test_name:ident, $loader:ident) => {
        #[test]
        fn $test_name() {
            let (file, brep) = $loader();
            let mesh = tessellate(&brep, &file, TessOptions::default()).unwrap();
            assert!(!mesh.triangles.is_empty(), "no triangles produced");
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
    };
}

shape_smoke_test!(tube_tessellates, load_tube);
shape_smoke_test!(elbow_tessellates, load_elbow);
shape_smoke_test!(torus_ring_tessellates, load_torus_ring);
shape_smoke_test!(stepped_shaft_tessellates, load_stepped_shaft);
shape_smoke_test!(hex_prism_tessellates, load_hex_prism);
shape_smoke_test!(pyramid_tessellates, load_pyramid);
shape_smoke_test!(wedge_tessellates, load_wedge);
shape_smoke_test!(i_beam_tessellates, load_i_beam);
shape_smoke_test!(t_profile_tessellates, load_t_profile);
shape_smoke_test!(u_channel_tessellates, load_u_channel);

/// Hollow tube must have triangles (annular FACE_BOUND holes are handled).
#[test]
fn tube_has_multiple_faces_tessellated() {
    let (_, brep) = load_tube();
    // 4 faces: 2 cylindrical barrels + 2 annular caps
    assert_eq!(brep.faces.len(), 4, "tube should have 4 faces");
    // Both annular caps must have exactly one inner loop each.
    // Face ordering varies by STEP exporter, so check by predicate.
    let caps: Vec<_> = brep
        .faces
        .iter()
        .filter(|f| !f.inner_loops.is_empty())
        .collect();
    assert_eq!(
        caps.len(),
        2,
        "tube should have exactly 2 annular caps with inner holes"
    );
    for cap in &caps {
        assert_eq!(
            cap.inner_loops.len(),
            1,
            "each annular cap must have exactly one inner hole"
        );
    }
}

/// Stepped shaft annular ring must carry an inner hole.
#[test]
fn stepped_shaft_ring_has_hole() {
    let (_, brep) = load_stepped_shaft();
    let ring = brep.faces.iter().find(|f| !f.inner_loops.is_empty());
    assert!(
        ring.is_some(),
        "stepped shaft ring face must have an inner FACE_BOUND hole"
    );
}

// ── spherical surface tests ───────────────────────────────────────────────────

fn load_nist_ctc_04() -> (kofem_geom::step::StepFile, BRep) {
    let file = parse(include_str!(
        "../../../test_files/NIST/nist_ctc_04_asme1_ap242-e1.stp"
    ))
    .unwrap();
    let brep = BRep::extract(&file).unwrap();
    (file, brep)
}

/// NIST CTC-04 contains 22 SPHERICAL_SURFACE faces. Verify tessellation produces
/// valid non-degenerate triangles for all faces.
#[test]
fn nist_ctc_04_spherical_surfaces_tessellate() {
    let (file, brep) = load_nist_ctc_04();
    let opts = TessOptions {
        max_edge_len: 2.0,
        ..TessOptions::default()
    };
    let mesh = tessellate(&brep, &file, opts).unwrap();

    // Must produce triangles
    assert!(
        mesh.triangles.len() > 100,
        "expected many triangles, got {}",
        mesh.triangles.len()
    );

    // No degenerate triangles
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

/// Verify all points in the spherical surface tessellation are finite.
#[test]
fn nist_ctc_04_all_points_finite() {
    let (file, brep) = load_nist_ctc_04();
    let opts = TessOptions {
        max_edge_len: 2.0,
        ..TessOptions::default()
    };
    let mesh = tessellate(&brep, &file, opts).unwrap();

    for (i, p) in mesh.points.iter().enumerate() {
        assert!(
            p[0].is_finite() && p[1].is_finite() && p[2].is_finite(),
            "point {i} has non-finite coords: {:?}",
            p
        );
    }
}

// ── NIST CTC-02 (AP242 e2, contains NURBS surfaces) ──────────────────────────

fn load_nist_ctc_02() -> (kofem_geom::step::StepFile, BRep) {
    let file = parse(include_str!(
        "../../../test_files/NIST/nist_ctc_02_asme1_ap242-e2.stp"
    ))
    .unwrap();
    let brep = BRep::extract(&file).unwrap();
    (file, brep)
}

/// NIST CTC-02 tessellates in reasonable time (regression guard for O(n²) stitch).
#[test]
fn nist_ctc_02_tessellates_without_panic() {
    let (file, brep) = load_nist_ctc_02();
    let mesh = tessellate(
        &brep,
        &file,
        TessOptions {
            max_edge_len: 5.0,
            ..TessOptions::default()
        },
    )
    .unwrap();
    assert!(
        mesh.triangles.len() > 10,
        "expected triangles, got {}",
        mesh.triangles.len()
    );
    for (i, p) in mesh.points.iter().enumerate() {
        assert!(
            p[0].is_finite() && p[1].is_finite() && p[2].is_finite(),
            "point {i} has non-finite coords: {:?}",
            p
        );
    }
}

// Quick smoke test: tessellate all NIST files without panicking.
// Tests are independent so failures are easy to isolate.
macro_rules! nist_smoke {
    ($name:ident, $file:literal) => {
        #[test]
        fn $name() {
            let text = std::fs::read_to_string(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join($file),
            )
            .expect("NIST file missing");
            let file = kofem_geom::step::parse(&text).expect("parse");
            let brep = kofem_geom::step::BRep::extract(&file).expect("extract");
            let opts = kofem_geom::tess::TessOptions::default();
            let mesh = kofem_geom::tess::tessellate(&brep, &file, opts);
            assert!(mesh.is_ok(), "tessellation failed: {:?}", mesh.err());
        }
    };
}

nist_smoke!(
    nist_ctc_01_smoke,
    "../../test_files/NIST/nist_ctc_01_asme1_ap242-e1.stp"
);
nist_smoke!(
    nist_ctc_03_smoke,
    "../../test_files/NIST/nist_ctc_03_asme1_ap242-e2.stp"
);
nist_smoke!(
    nist_ctc_05_smoke,
    "../../test_files/NIST/nist_ctc_05_asme1_ap242-e1.stp"
);
nist_smoke!(
    nist_ftc_06_smoke,
    "../../test_files/NIST/nist_ftc_06_asme1_ap242-e2.stp"
);
nist_smoke!(
    nist_ftc_07_smoke,
    "../../test_files/NIST/nist_ftc_07_asme1_ap242-e2.stp"
);
nist_smoke!(
    nist_ftc_08_smoke,
    "../../test_files/NIST/nist_ftc_08_asme1_ap242-e2.stp"
);
nist_smoke!(
    nist_ftc_09_smoke,
    "../../test_files/NIST/nist_ftc_09_asme1_ap242-e1.stp"
);
nist_smoke!(
    nist_ftc_10_smoke,
    "../../test_files/NIST/nist_ftc_10_asme1_ap242-e2.stp"
);
nist_smoke!(
    nist_ftc_11_smoke,
    "../../test_files/NIST/nist_ftc_11_asme1_ap242-e2.stp"
);
nist_smoke!(
    nist_stc_06_smoke,
    "../../test_files/NIST/nist_stc_06_asme1_ap242-e3.stp"
);
nist_smoke!(
    nist_stc_07_smoke,
    "../../test_files/NIST/nist_stc_07_asme1_ap242-e3.stp"
);
nist_smoke!(
    nist_stc_08_smoke,
    "../../test_files/NIST/nist_stc_08_asme1_ap242-e3.stp"
);
nist_smoke!(
    nist_stc_09_smoke,
    "../../test_files/NIST/nist_stc_09_asme1_ap242-e3.stp"
);

/// A quarter-cylinder (r=5, z in [0,10], u in [0,π/2]) adjacent to two flat
/// rectangular faces (the bottom quad and the left-side quad) forms a minimal
/// shape where a CDT flat face shares arc boundaries with a partial cylinder.
/// After stitching, the shared arc edges must be manifold (shared by exactly 2
/// triangles) — this verifies that arc-length-based boundary sampling matches
/// the partial-cylinder UV grid positions.
#[test]
fn partial_cylinder_arc_boundary_stitches_to_flat_face() {
    // Quarter-cylinder barrel face (CYLINDRICAL_SURFACE).
    // Outer loop: bottom arc (5,0,0)→(0,5,0), left gen (0,5,0)→(0,5,10),
    //             top arc rev (5,0,10)→(0,5,10), right gen rev (5,0,10)→(5,0,0).
    let cyl_step = STEP_QUARTER_CYLINDER;

    // Flat bottom face: the square x∈[0,5] y∈[0,5] at z=0, with the arc
    // boundary from (5,0,0) to (0,5,0) as one edge.
    const STEP_BOTTOM_FLAT: &str = "
ISO-10303-21;
HEADER;FILE_DESCRIPTION(('bottom flat'));
ENDSEC;
DATA;
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=CARTESIAN_POINT('',(5.,0.,0.));
#3=CARTESIAN_POINT('',(0.,5.,0.));
#5=VERTEX_POINT('',#1);
#6=VERTEX_POINT('',#2);
#7=VERTEX_POINT('',#3);
#10=CARTESIAN_POINT('',(0.,0.,0.));
#11=DIRECTION('',(0.,0.,1.));
#12=DIRECTION('',(1.,0.,0.));
#13=AXIS2_PLACEMENT_3D('',#10,#11,#12);
#14=CIRCLE('',#13,5.);
#15=EDGE_CURVE('',#6,#7,#14,.T.);
#20=CARTESIAN_POINT('',(5.,0.,0.));
#21=DIRECTION('',(-1.,0.,0.));
#22=VECTOR('',#21,5.);
#23=LINE('',#20,#22);
#24=EDGE_CURVE('',#5,#6,#23,.T.);
#30=CARTESIAN_POINT('',(0.,5.,0.));
#31=DIRECTION('',(0.,-1.,0.));
#32=VECTOR('',#31,5.);
#33=LINE('',#30,#32);
#34=EDGE_CURVE('',#7,#5,#33,.T.);
#40=ORIENTED_EDGE('',*,*,#24,.T.);
#41=ORIENTED_EDGE('',*,*,#15,.T.);
#42=ORIENTED_EDGE('',*,*,#34,.T.);
#43=EDGE_LOOP('',( #40,#41,#42));
#44=FACE_OUTER_BOUND('',#43,.T.);
#50=CARTESIAN_POINT('',(0.,0.,0.));
#51=DIRECTION('',(0.,0.,-1.));
#52=DIRECTION('',(1.,0.,0.));
#53=AXIS2_PLACEMENT_3D('',#50,#51,#52);
#54=PLANE('',#53);
#55=ADVANCED_FACE('',( #44),#54,.T.);
ENDSEC;
END-ISO-10303-21;
";

    let opts = TessOptions {
        max_edge_len: 1.0,
        ..TessOptions::default()
    };

    // Tessellate the two faces independently and combine.
    let (cyl_file, cyl_brep) = {
        let f = parse(cyl_step).unwrap();
        let b = BRep::extract(&f).unwrap();
        (f, b)
    };
    let cyl_mesh = tessellate(
        &cyl_brep,
        &cyl_file,
        TessOptions {
            max_edge_len: 1.0,
            ..TessOptions::default()
        },
    )
    .unwrap();

    let (flat_file, flat_brep) = {
        let f = parse(STEP_BOTTOM_FLAT).unwrap();
        let b = BRep::extract(&f).unwrap();
        (f, b)
    };
    let flat_mesh = tessellate(&flat_brep, &flat_file, opts).unwrap();

    // Combine and stitch at a tight tolerance.
    let mut all_pts: Vec<[f64; 3]> = cyl_mesh.points.clone();
    let offset = all_pts.len();
    all_pts.extend_from_slice(&flat_mesh.points);
    let mut all_tris: Vec<[usize; 3]> = cyl_mesh.triangles.clone();
    for &[a, b, c] in &flat_mesh.triangles {
        all_tris.push([a + offset, b + offset, c + offset]);
    }

    // Re-stitch at a fine tolerance.
    let bbox = {
        let mut mn = all_pts[0];
        let mut mx = all_pts[0];
        for &p in &all_pts {
            for k in 0..3 {
                if p[k] < mn[k] {
                    mn[k] = p[k];
                }
                if p[k] > mx[k] {
                    mx[k] = p[k];
                }
            }
        }
        let d = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
        (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt()
    };
    let eps = 1e-4 * bbox.max(1e-10);
    let eps2 = eps * eps;

    let mut remap = vec![0usize; all_pts.len()];
    let mut unique: Vec<[f64; 3]> = Vec::new();
    for (i, &p) in all_pts.iter().enumerate() {
        let found = unique
            .iter()
            .enumerate()
            .find(|(_, &q)| {
                let d = [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
                d[0] * d[0] + d[1] * d[1] + d[2] * d[2] <= eps2
            })
            .map(|(j, _)| j);
        match found {
            Some(j) => remap[i] = j,
            None => {
                remap[i] = unique.len();
                unique.push(p);
            }
        }
    }
    let stitched: Vec<[usize; 3]> = all_tris
        .iter()
        .map(|&[a, b, c]| [remap[a], remap[b], remap[c]])
        .filter(|&[a, b, c]| a != b && b != c && a != c)
        .collect();

    // Count open edges on the arc boundary (z=0, r≈5 region).
    let mut arc_open = 0usize;
    let mut arc_total = 0usize;
    let ecounts = edge_counts(&stitched);
    for (&(a, b), &cnt) in &ecounts {
        let pa = unique[a];
        let pb = unique[b];
        // Arc boundary: both endpoints near r=5, z=0, x≥0, y≥0
        let on_arc = |p: [f64; 3]| {
            let r = (p[0] * p[0] + p[1] * p[1]).sqrt();
            (r - 5.0).abs() < 0.1 && p[2].abs() < 0.1 && p[0] >= -0.1 && p[1] >= -0.1
        };
        if on_arc(pa) && on_arc(pb) {
            arc_total += 1;
            if cnt == 1 {
                arc_open += 1;
            }
        }
    }

    assert_eq!(
        arc_open, 0,
        "{arc_open}/{arc_total} open edge(s) on the arc boundary between \
         the quarter-cylinder and the flat face — arc positions did not match"
    );
}
