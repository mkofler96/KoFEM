use std::path::PathBuf;

fn main() {
    let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    let is_wasm = target_arch == "wasm32";

    let include_dir: Option<PathBuf> = if is_wasm {
        let root = std::env::var("OCCT_WASM_ROOT")
            .expect("OCCT_WASM_ROOT must point to an Emscripten build of OCCT");
        Some(PathBuf::from(root).join("include/opencascade"))
    } else if let Ok(root) = std::env::var("OCCT_ROOT") {
        Some(PathBuf::from(root).join("include/opencascade"))
    } else {
        let candidate = PathBuf::from("/usr/include/opencascade");
        if candidate.exists() {
            Some(candidate)
        } else {
            None
        }
    };

    if let Some(inc) = &include_dir {
        let mut build = cc::Build::new();
        build
            .cpp(true)
            .file("cpp/occt_bridge.cpp")
            .include("include")
            .include(inc)
            .flag_if_supported("-std=c++17");

        // SIDE_MODULE WASM links require every object to be position-independent.
        if is_wasm {
            build.flag("-fPIC");
        }

        if is_wasm {
            let root = std::env::var("OCCT_WASM_ROOT").unwrap();
            println!("cargo:rustc-link-search={}/lib", root);
        } else if let Ok(root) = std::env::var("OCCT_ROOT") {
            println!("cargo:rustc-link-search={root}/lib");
        }

        build.compile("occt_bridge");
    } else {
        println!("cargo:warning=OCCT headers not found — set OCCT_ROOT or install libocct-*-dev. The crate will not link until the library is available.");
    }

    // Minimal OCCT modules for STEP import + tessellation
    for lib in &[
        "TKernel",
        "TKMath",
        "TKG2d",
        "TKG3d",
        "TKGeomBase",
        "TKBRep",
        "TKGeomAlgo",
        "TKTopAlgo",
        "TKMesh",
        "TKShHealing",
        "TKSTEP",
        "TKSTEP209",
        "TKSTEPAttr",
        "TKSTEPBase",
    ] {
        println!("cargo:rustc-link-lib={lib}");
    }

    println!("cargo:rerun-if-changed=cpp/occt_bridge.cpp");
    println!("cargo:rerun-if-changed=include/occt_bridge.h");
    println!("cargo:rerun-if-env-changed=OCCT_ROOT");
    println!("cargo:rerun-if-env-changed=OCCT_WASM_ROOT");
}
