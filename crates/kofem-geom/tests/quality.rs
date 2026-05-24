//! Mesh quality integration tests: tessellate each supported STEP geometry,
//! compare against a reference STL using symmetric chamfer distance (area-weighted
//! surface sampling + point-to-triangle distance), and write a JSON report consumed
//! by `web/scripts/generate-mesh-report.ts`.
//!
//! `mesh_quality_report`      — 15 standard geometries (runs by default)
//! `mesh_quality_report_nist` — 16 NIST geometries     (#[ignore]; run with
//!                              `cargo test -- --include-ignored`)

use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use kofem_geom::step::{parse, BRep};
use kofem_geom::tess::{tessellate, TessOptions};

/// Area-weighted surface samples drawn from each mesh for chamfer distance.
const MAX_SAMPLE: usize = 2_000;

/// Symmetric chamfer threshold (mm).
/// With point-to-surface distance and area-weighted sampling, correct meshes
/// (tessellated at ≤1 mm edge length against a 0.5 mm reference) should be
/// well under this value.
const CHAMFER_THRESHOLD_MM: f64 = 1.0;

fn json_out() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/test-results/mesh-quality.json")
}

struct GeomSpec {
    name: &'static str,
    label: &'static str,
    step_file: &'static str,
    ref_stl: &'static str,
}

static STANDARD_GEOMETRIES: &[GeomSpec] = &[
    GeomSpec {
        name: "box",
        label: "Simple Box (80×60×40 mm)",
        step_file: "../../test_files/box.stp",
        ref_stl: "../../test_files/reference_stl/box.stl",
    },
    GeomSpec {
        name: "cylinder",
        label: "Cylinder (R=25, H=80 mm)",
        step_file: "../../test_files/cylinder.stp",
        ref_stl: "../../test_files/reference_stl/cylinder.stl",
    },
    GeomSpec {
        name: "elbow",
        label: "Pipe Elbow",
        step_file: "../../test_files/elbow.stp",
        ref_stl: "../../test_files/reference_stl/elbow.stl",
    },
    GeomSpec {
        name: "hex_prism",
        label: "Hexagonal Prism",
        step_file: "../../test_files/hex_prism.stp",
        ref_stl: "../../test_files/reference_stl/hex_prism.stl",
    },
    GeomSpec {
        name: "i_beam",
        label: "I-Beam Profile",
        step_file: "../../test_files/i_beam.stp",
        ref_stl: "../../test_files/reference_stl/i_beam.stl",
    },
    GeomSpec {
        name: "l_bracket",
        label: "L-Bracket (80×80×20 mm)",
        step_file: "../../test_files/l_bracket.stp",
        ref_stl: "../../test_files/reference_stl/l_bracket.stl",
    },
    GeomSpec {
        name: "new_bracket_2",
        label: "Complex Bracket",
        step_file: "../../test_files/new_bracket_2.stp",
        ref_stl: "../../test_files/reference_stl/new_bracket_2.stl",
    },
    GeomSpec {
        name: "pyramid",
        label: "Square Pyramid",
        step_file: "../../test_files/pyramid.stp",
        ref_stl: "../../test_files/reference_stl/pyramid.stl",
    },
    GeomSpec {
        name: "stepped_shaft",
        label: "Stepped Shaft",
        step_file: "../../test_files/stepped_shaft.stp",
        ref_stl: "../../test_files/reference_stl/stepped_shaft.stl",
    },
    GeomSpec {
        name: "t_profile",
        label: "T-Profile",
        step_file: "../../test_files/t_profile.stp",
        ref_stl: "../../test_files/reference_stl/t_profile.stl",
    },
    GeomSpec {
        name: "torus_ring",
        label: "Torus Ring",
        step_file: "../../test_files/torus_ring.stp",
        ref_stl: "../../test_files/reference_stl/torus_ring.stl",
    },
    GeomSpec {
        name: "tube",
        label: "Tube (hollow cylinder)",
        step_file: "../../test_files/tube.stp",
        ref_stl: "../../test_files/reference_stl/tube.stl",
    },
    GeomSpec {
        name: "u_channel",
        label: "U-Channel",
        step_file: "../../test_files/u_channel.stp",
        ref_stl: "../../test_files/reference_stl/u_channel.stl",
    },
    GeomSpec {
        name: "wedge",
        label: "Wedge",
        step_file: "../../test_files/wedge.stp",
        ref_stl: "../../test_files/reference_stl/wedge.stl",
    },
];

static NIST_GEOMETRIES: &[GeomSpec] = &[
    GeomSpec {
        name: "nist_ctc_01",
        label: "NIST CTC-01 (AP242 e1)",
        step_file: "../../test_files/NIST/nist_ctc_01_asme1_ap242-e1.stp",
        ref_stl: "../../test_files/reference_stl/nist_ctc_01_asme1_ap242-e1.stl",
    },
    GeomSpec {
        name: "nist_ctc_02",
        label: "NIST CTC-02 (AP242 e2)",
        step_file: "../../test_files/NIST/nist_ctc_02_asme1_ap242-e2.stp",
        ref_stl: "../../test_files/reference_stl/nist_ctc_02_asme1_ap242-e2.stl",
    },
    GeomSpec {
        name: "nist_ctc_03",
        label: "NIST CTC-03 (AP242 e2)",
        step_file: "../../test_files/NIST/nist_ctc_03_asme1_ap242-e2.stp",
        ref_stl: "../../test_files/reference_stl/nist_ctc_03_asme1_ap242-e2.stl",
    },
    GeomSpec {
        name: "nist_ctc_04",
        label: "NIST CTC-04 (AP242 e1)",
        step_file: "../../test_files/NIST/nist_ctc_04_asme1_ap242-e1.stp",
        ref_stl: "../../test_files/reference_stl/nist_ctc_04_asme1_ap242-e1.stl",
    },
    GeomSpec {
        name: "nist_ctc_05",
        label: "NIST CTC-05 (AP242 e1)",
        step_file: "../../test_files/NIST/nist_ctc_05_asme1_ap242-e1.stp",
        ref_stl: "../../test_files/reference_stl/nist_ctc_05_asme1_ap242-e1.stl",
    },
    GeomSpec {
        name: "nist_ftc_06",
        label: "NIST FTC-06 (AP242 e2)",
        step_file: "../../test_files/NIST/nist_ftc_06_asme1_ap242-e2.stp",
        ref_stl: "../../test_files/reference_stl/nist_ftc_06_asme1_ap242-e2.stl",
    },
    GeomSpec {
        name: "nist_ftc_07",
        label: "NIST FTC-07 (AP242 e2)",
        step_file: "../../test_files/NIST/nist_ftc_07_asme1_ap242-e2.stp",
        ref_stl: "../../test_files/reference_stl/nist_ftc_07_asme1_ap242-e2.stl",
    },
    GeomSpec {
        name: "nist_ftc_08_e2",
        label: "NIST FTC-08 (AP242 e2)",
        step_file: "../../test_files/NIST/nist_ftc_08_asme1_ap242-e2.stp",
        ref_stl: "../../test_files/reference_stl/nist_ftc_08_asme1_ap242-e2.stl",
    },
    GeomSpec {
        name: "nist_ftc_09",
        label: "NIST FTC-09 (AP242 e1)",
        step_file: "../../test_files/NIST/nist_ftc_09_asme1_ap242-e1.stp",
        ref_stl: "../../test_files/reference_stl/nist_ftc_09_asme1_ap242-e1.stl",
    },
    GeomSpec {
        name: "nist_ftc_10",
        label: "NIST FTC-10 (AP242 e2)",
        step_file: "../../test_files/NIST/nist_ftc_10_asme1_ap242-e2.stp",
        ref_stl: "../../test_files/reference_stl/nist_ftc_10_asme1_ap242-e2.stl",
    },
    GeomSpec {
        name: "nist_ftc_11",
        label: "NIST FTC-11 (AP242 e2)",
        step_file: "../../test_files/NIST/nist_ftc_11_asme1_ap242-e2.stp",
        ref_stl: "../../test_files/reference_stl/nist_ftc_11_asme1_ap242-e2.stl",
    },
    GeomSpec {
        name: "nist_stc_06",
        label: "NIST STC-06 (AP242 e3)",
        step_file: "../../test_files/NIST/nist_stc_06_asme1_ap242-e3.stp",
        ref_stl: "../../test_files/reference_stl/nist_stc_06_asme1_ap242-e3.stl",
    },
    GeomSpec {
        name: "nist_stc_07",
        label: "NIST STC-07 (AP242 e3)",
        step_file: "../../test_files/NIST/nist_stc_07_asme1_ap242-e3.stp",
        ref_stl: "../../test_files/reference_stl/nist_stc_07_asme1_ap242-e3.stl",
    },
    GeomSpec {
        name: "nist_stc_08",
        label: "NIST STC-08 (AP242 e3)",
        step_file: "../../test_files/NIST/nist_stc_08_asme1_ap242-e3.stp",
        ref_stl: "../../test_files/reference_stl/nist_stc_08_asme1_ap242-e3.stl",
    },
    GeomSpec {
        name: "nist_stc_09",
        label: "NIST STC-09 (AP242 e3)",
        step_file: "../../test_files/NIST/nist_stc_09_asme1_ap242-e3.stp",
        ref_stl: "../../test_files/reference_stl/nist_stc_09_asme1_ap242-e3.stl",
    },
    GeomSpec {
        name: "nist_stc_10",
        label: "NIST STC-10 (AP242 e2)",
        step_file: "../../test_files/NIST/nist_stc_10_asme1_ap242-e2.stp",
        ref_stl: "../../test_files/reference_stl/nist_stc_10_asme1_ap242-e2.stl",
    },
    GeomSpec {
        name: "l_bracket_w_fillet",
        label: "L-Bracket with a round fillet",
        step_file: "../../test_files/l_bracket_w_fillet.step",
        ref_stl: "../../test_files/reference_stl/l_bracket_w_fillet.stl",
    },
];

// ── STL parsing ───────────────────────────────────────────────────────────────

fn parse_stl_triangles_ascii(text: &str) -> Result<Vec<[[f32; 3]; 3]>, String> {
    let mut tris = Vec::new();
    let mut verts: Vec<[f32; 3]> = Vec::with_capacity(3);
    for line in text.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("vertex ") {
            let mut nums = rest.split_ascii_whitespace();
            let x: f32 = nums.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
            let y: f32 = nums.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
            let z: f32 = nums.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
            verts.push([x, y, z]);
            if verts.len() == 3 {
                tris.push([verts[0], verts[1], verts[2]]);
                verts.clear();
            }
        }
    }
    if tris.is_empty() {
        Err("no triangles found in ASCII STL".to_string())
    } else {
        Ok(tris)
    }
}

fn parse_stl_triangles_binary(data: &[u8]) -> Result<Vec<[[f32; 3]; 3]>, String> {
    if data.len() < 84 {
        return Err(format!("binary STL too short: {} bytes", data.len()));
    }
    let tri_count = u32::from_le_bytes(data[80..84].try_into().unwrap()) as usize;
    let expected = 84 + tri_count * 50;
    if data.len() < expected {
        return Err(format!(
            "binary STL truncated: {} bytes, expected {} ({} tris)",
            data.len(),
            expected,
            tri_count
        ));
    }
    if tri_count == 0 {
        return Err("binary STL has zero triangles".to_string());
    }
    let mut tris = Vec::with_capacity(tri_count);
    for i in 0..tri_count {
        let base = 84 + i * 50 + 12; // skip 80B header + 4B count + 12B normal
        let mut tri = [[0.0f32; 3]; 3];
        for (v, vertex) in tri.iter_mut().enumerate() {
            let off = base + v * 12;
            vertex[0] = f32::from_le_bytes(data[off..off + 4].try_into().unwrap());
            vertex[1] = f32::from_le_bytes(data[off + 4..off + 8].try_into().unwrap());
            vertex[2] = f32::from_le_bytes(data[off + 8..off + 12].try_into().unwrap());
        }
        tris.push(tri);
    }
    Ok(tris)
}

/// Auto-detect ASCII vs binary and parse accordingly.
fn parse_stl_triangles(data: &[u8]) -> Result<Vec<[[f32; 3]; 3]>, String> {
    let looks_ascii = data.starts_with(b"solid");
    let binary_tri_count = if data.len() >= 84 {
        u32::from_le_bytes(data[80..84].try_into().unwrap()) as usize
    } else {
        0
    };
    let correct_binary_size = data.len() == 84 + binary_tri_count * 50;
    if looks_ascii && !correct_binary_size {
        match std::str::from_utf8(data) {
            Ok(text) => parse_stl_triangles_ascii(text),
            Err(e) => Err(format!("STL not valid UTF-8: {e}")),
        }
    } else {
        parse_stl_triangles_binary(data)
    }
}

// ── chamfer distance ──────────────────────────────────────────────────────────

fn extract_triangles(mesh: &kofem_geom::tess::SurfaceMesh) -> Vec<[[f32; 3]; 3]> {
    mesh.triangles
        .iter()
        .map(|&[a, b, c]| {
            let pa = mesh.points[a];
            let pb = mesh.points[b];
            let pc = mesh.points[c];
            [
                [pa[0] as f32, pa[1] as f32, pa[2] as f32],
                [pb[0] as f32, pb[1] as f32, pb[2] as f32],
                [pc[0] as f32, pc[1] as f32, pc[2] as f32],
            ]
        })
        .collect()
}

#[inline]
fn sub3(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

#[inline]
fn dot3(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[inline]
fn len2(v: [f32; 3]) -> f32 {
    dot3(v, v)
}

/// Squared distance from `p` to the closest point on triangle `t`.
/// Christer Ericson, "Real-Time Collision Detection" §5.1.5.
fn point_to_tri_dist2(p: [f32; 3], t: &[[f32; 3]; 3]) -> f32 {
    let (a, b, c) = (t[0], t[1], t[2]);
    let ab = sub3(b, a);
    let ac = sub3(c, a);
    let ap = sub3(p, a);
    let d1 = dot3(ab, ap);
    let d2 = dot3(ac, ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return len2(ap); // vertex A
    }
    let bp = sub3(p, b);
    let d3 = dot3(ab, bp);
    let d4 = dot3(ac, bp);
    if d3 >= 0.0 && d4 <= d3 {
        return len2(bp); // vertex B
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let v = d1 / (d1 - d3);
        return len2(sub3(ap, [v * ab[0], v * ab[1], v * ab[2]])); // edge AB
    }
    let cp = sub3(p, c);
    let d5 = dot3(ab, cp);
    let d6 = dot3(ac, cp);
    if d6 >= 0.0 && d5 <= d6 {
        return len2(cp); // vertex C
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let w = d2 / (d2 - d6);
        return len2(sub3(ap, [w * ac[0], w * ac[1], w * ac[2]])); // edge AC
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        let bc = sub3(c, b);
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return len2(sub3(bp, [w * bc[0], w * bc[1], w * bc[2]])); // edge BC
    }
    let denom = 1.0 / (va + vb + vc);
    let v = vb * denom;
    let w = vc * denom;
    let proj = [
        a[0] + v * ab[0] + w * ac[0],
        a[1] + v * ab[1] + w * ac[1],
        a[2] + v * ab[2] + w * ac[2],
    ];
    len2(sub3(p, proj))
}

/// Van der Corput low-discrepancy sequence in the given base.
fn van_der_corput(mut n: usize, base: usize) -> f32 {
    let mut r = 0.0f32;
    let mut f = 1.0f32 / base as f32;
    while n > 0 {
        r += f * (n % base) as f32;
        n /= base;
        f /= base as f32;
    }
    r
}

/// Sample `n` points uniformly over a triangle mesh, weighted by triangle area.
/// Deterministic — uses a 3D Halton sequence (bases 2, 3, 5).
fn sample_surface_uniform(tris: &[[[f32; 3]; 3]], n: usize) -> Vec<[f32; 3]> {
    if tris.is_empty() || n == 0 {
        return Vec::new();
    }
    let areas: Vec<f32> = tris
        .iter()
        .map(|t| {
            let ab = sub3(t[1], t[0]);
            let ac = sub3(t[2], t[0]);
            let cx = ab[1] * ac[2] - ab[2] * ac[1];
            let cy = ab[2] * ac[0] - ab[0] * ac[2];
            let cz = ab[0] * ac[1] - ab[1] * ac[0];
            (cx * cx + cy * cy + cz * cz).sqrt() * 0.5
        })
        .collect();
    let total: f32 = areas.iter().sum();
    if total == 0.0 {
        return tris
            .iter()
            .take(n)
            .map(|t| {
                [
                    (t[0][0] + t[1][0] + t[2][0]) / 3.0,
                    (t[0][1] + t[1][1] + t[2][1]) / 3.0,
                    (t[0][2] + t[1][2] + t[2][2]) / 3.0,
                ]
            })
            .collect();
    }
    let mut prefix = Vec::with_capacity(tris.len() + 1);
    prefix.push(0.0f32);
    for &a in &areas {
        prefix.push(prefix.last().unwrap() + a);
    }
    (0..n)
        .map(|i| {
            // Triangle selection: Halton base-2 stratifies over area CDF.
            let t_val = van_der_corput(i + 1, 2) * total;
            let tri_idx = prefix
                .partition_point(|&p| p < t_val)
                .saturating_sub(1)
                .min(tris.len() - 1);
            let tri = &tris[tri_idx];
            // Barycentric coords: independent Halton dimensions (bases 3 and 5).
            let mut u = van_der_corput(i + 1, 3);
            let mut v = van_der_corput(i + 1, 5);
            if u + v > 1.0 {
                u = 1.0 - u;
                v = 1.0 - v;
            }
            let w = 1.0 - u - v;
            [
                w * tri[0][0] + u * tri[1][0] + v * tri[2][0],
                w * tri[0][1] + u * tri[1][1] + v * tri[2][1],
                w * tri[0][2] + u * tri[1][2] + v * tri[2][2],
            ]
        })
        .collect()
}

/// One-sided: mean and max point-to-surface distance from `from` sample points
/// to the triangle mesh `to`.
fn one_sided(from: &[[f32; 3]], to: &[[[f32; 3]; 3]]) -> (f64, f64) {
    let mut sum = 0.0f64;
    let mut max_d = 0.0f64;
    for &p in from {
        let min_d2 = to
            .iter()
            .map(|tri| point_to_tri_dist2(p, tri))
            .fold(f32::MAX, f32::min);
        let d = (min_d2 as f64).sqrt();
        sum += d;
        if d > max_d {
            max_d = d;
        }
    }
    (sum / from.len() as f64, max_d)
}

/// Symmetric chamfer distance → (mean_mm, max_mm).
///
/// Draws `MAX_SAMPLE` area-weighted surface points from each mesh, then
/// measures point-to-surface (not point-to-centroid) distance in both directions.
fn chamfer_distance(kofem: &[[[f32; 3]; 3]], reference: &[[[f32; 3]; 3]]) -> (f64, f64) {
    let a = sample_surface_uniform(kofem, MAX_SAMPLE);
    let b = sample_surface_uniform(reference, MAX_SAMPLE);
    let (mean_ab, max_ab) = one_sided(&a, reference);
    let (mean_ba, max_ba) = one_sided(&b, kofem);
    ((mean_ab + mean_ba) / 2.0, f64::max(max_ab, max_ba))
}

// ── JSON output ───────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
struct QualityResult {
    name: String,
    label: String,
    kofem_triangles: Option<usize>,
    ref_triangles: Option<usize>,
    chamfer_mean_mm: Option<f64>,
    chamfer_max_mm: Option<f64>,
    time_ms: u64,
    error: Option<String>,
    pass: bool,
}

// ── per-geometry runner ───────────────────────────────────────────────────────

fn run_geometry(spec: &GeomSpec, idx: usize, total: usize) -> (QualityResult, bool) {
    let t0 = Instant::now();
    let tag = format!("[{idx}/{total}] {}", spec.name);
    let ms = || t0.elapsed().as_millis();

    macro_rules! fail {
        ($err:expr) => {{
            let err: String = $err;
            eprintln!("{tag}  ERROR: {err}");
            return (
                QualityResult {
                    name: spec.name.to_string(),
                    label: spec.label.to_string(),
                    kofem_triangles: None,
                    ref_triangles: None,
                    chamfer_mean_mm: None,
                    chamfer_max_mm: None,
                    time_ms: ms() as u64,
                    error: Some(err),
                    pass: false,
                },
                false,
            );
        }};
    }

    eprintln!("{tag}  reading STEP...");
    let step_text = match fs::read_to_string(spec.step_file) {
        Ok(s) => s,
        Err(e) => fail!(format!("read STEP: {e}")),
    };

    eprintln!(
        "{tag}  parsing STEP ({} bytes, {}ms)...",
        step_text.len(),
        ms()
    );
    let step_file = match parse(&step_text) {
        Ok(f) => f,
        Err(e) => fail!(format!("parse STEP: {e}")),
    };

    eprintln!("{tag}  extracting BRep ({}ms)...", ms());
    let brep = match BRep::extract(&step_file) {
        Ok(b) => b,
        Err(e) => fail!(format!("extract BRep: {e}")),
    };

    eprintln!(
        "{tag}  tessellating {} faces ({}ms)...",
        brep.faces.len(),
        ms()
    );
    let mesh = match tessellate(&brep, &step_file, TessOptions::default()) {
        Ok(m) => m,
        Err(e) => fail!(format!("tessellate: {e}")),
    };
    let tess_ms = ms() as u64;
    let kofem_tris = mesh.triangles.len();
    let kofem_tris_data = extract_triangles(&mesh);
    eprintln!("{tag}  tessellated → {kofem_tris} tris ({tess_ms}ms); reading ref STL...");

    let ref_data = match fs::read(spec.ref_stl) {
        Ok(d) => d,
        Err(e) => fail!(format!("read ref STL: {e}")),
    };
    eprintln!("{tag}  ref STL {} bytes; parsing...", ref_data.len());

    let ref_tris_data = match parse_stl_triangles(&ref_data) {
        Ok(t) => t,
        Err(e) => fail!(format!("parse ref STL: {e}")),
    };
    let ref_tris = ref_tris_data.len();
    eprintln!(
        "{tag}  ref={ref_tris} tris; computing chamfer (n_samples={MAX_SAMPLE}, {}ms)...",
        ms()
    );

    let (mean_mm, max_mm) = chamfer_distance(&kofem_tris_data, &ref_tris_data);
    let total_ms = ms() as u64;
    let pass = mean_mm < CHAMFER_THRESHOLD_MM;

    eprintln!(
        "{tag}  → mean={mean_mm:.2}mm max={max_mm:.2}mm  tess={tess_ms}ms  total={total_ms}ms  {}",
        if pass { "PASS" } else { "FAIL" }
    );

    (
        QualityResult {
            name: spec.name.to_string(),
            label: spec.label.to_string(),
            kofem_triangles: Some(kofem_tris),
            ref_triangles: Some(ref_tris),
            chamfer_mean_mm: Some(mean_mm),
            chamfer_max_mm: Some(max_mm),
            time_ms: tess_ms,
            error: None,
            pass,
        },
        pass,
    )
}

// ── JSON merge helper ─────────────────────────────────────────────────────────

/// Merge `new_results` into the existing JSON file (preserving entries for
/// geometries not in this run), then write back.
fn write_json(new_results: &[QualityResult]) {
    // Load existing results and replace/append entries by name
    let mut existing: std::collections::HashMap<String, usize> = Default::default();
    let mut all: Vec<serde_json::Value> = Vec::new();

    if let Ok(text) = fs::read_to_string(json_out()) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(arr) = v.get("results").and_then(|r| r.as_array()) {
                for entry in arr {
                    if let Some(name) = entry.get("name").and_then(|n| n.as_str()) {
                        existing.insert(name.to_string(), all.len());
                        all.push(entry.clone());
                    }
                }
            }
        }
    }

    for r in new_results {
        let v = serde_json::to_value(r).expect("serialise");
        if let Some(&idx) = existing.get(&r.name) {
            all[idx] = v;
        } else {
            all.push(v);
        }
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let report = serde_json::json!({ "generated_at": now, "results": all });
    let json = serde_json::to_string_pretty(&report).expect("JSON serialization");
    let out = json_out();

    fs::create_dir_all(out.parent().unwrap()).expect("create output dir");
    fs::write(&out, &json).expect("write quality JSON");

    eprintln!(
        "Quality report written → {}  ({} total entries)",
        out.display(),
        all.len()
    );
}

// ── tests ─────────────────────────────────────────────────────────────────────

fn run_suite(label: &str, geoms: &[GeomSpec]) {
    let total = geoms.len();
    eprintln!("{label}: running {total} geometries");

    let mut results: Vec<QualityResult> = Vec::new();
    let mut failures: Vec<String> = Vec::new();

    for (i, spec) in geoms.iter().enumerate() {
        let (result, pass) = run_geometry(spec, i + 1, total);
        if !pass {
            let msg = result.error.clone().unwrap_or_else(|| {
                format!(
                    "chamfer {:.2}mm",
                    result.chamfer_mean_mm.unwrap_or(f64::INFINITY)
                )
            });
            failures.push(format!("{}: {msg}", spec.name));
        }
        results.push(result);
    }

    write_json(&results);

    if !failures.is_empty() {
        panic!(
            "{} quality failure(s):\n{}",
            failures.len(),
            failures.join("\n")
        );
    }
    eprintln!("{label}: all {total} passed.");
}

/// Standard 15 geometries — runs by default with `cargo test`.
#[test]
fn mesh_quality_report() {
    run_suite("mesh_quality_report", STANDARD_GEOMETRIES);
}

/// 16 NIST AP242 models — slow in debug mode; run explicitly with
/// `cargo test -- --include-ignored mesh_quality_report_nist`.
#[test]
#[ignore]
fn mesh_quality_report_nist() {
    run_suite("mesh_quality_report_nist", NIST_GEOMETRIES);
}
