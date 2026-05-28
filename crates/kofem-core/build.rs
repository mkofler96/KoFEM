use std::path::PathBuf;

fn main() {
    let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    let is_wasm = target_arch == "wasm32";

    let include_dir: Option<PathBuf> = if is_wasm {
        let root = std::env::var("MFEM_WASM_ROOT")
            .expect("MFEM_WASM_ROOT must point to an Emscripten build of MFEM");
        Some(PathBuf::from(root).join("include"))
    } else if let Ok(root) = std::env::var("MFEM_DIR") {
        Some(PathBuf::from(root).join("include"))
    } else {
        // mfem.hpp lives directly under the include dir (not in a subdirectory)
        [
            PathBuf::from("/usr/include"),
            PathBuf::from("/usr/local/include"),
        ]
        .into_iter()
        .find(|p| p.join("mfem.hpp").exists())
    };

    if let Some(inc) = &include_dir {
        let mut build = cc::Build::new();
        build
            .cpp(true)
            .file("cpp/mfem_bridge.cpp")
            .include("include")
            .include(inc)
            .flag_if_supported("-std=c++14"); // MFEM requires C++14

        if is_wasm {
            build.flag("-fPIC");
        }

        // MFEM on Ubuntu is built with MPI + HYPRE; add their include dirs.
        for extra_inc in &[
            "/usr/lib/x86_64-linux-gnu/openmpi/include", // mpi.h
            "/usr/include/hypre",                        // HYPRE_config.h
            "/usr/include/mpi",
        ] {
            if std::path::Path::new(extra_inc).exists() {
                build.include(extra_inc);
            }
        }

        if is_wasm {
            let root = std::env::var("MFEM_WASM_ROOT").unwrap();
            println!("cargo:rustc-link-search={}/lib", root);
        } else if let Ok(root) = std::env::var("MFEM_DIR") {
            println!("cargo:rustc-link-search={root}/lib");
        } else {
            println!("cargo:rustc-link-search=/usr/local/lib");
        }

        build.compile("mfem_bridge");
    } else {
        println!("cargo:warning=MFEM headers not found — set MFEM_DIR or install libmfem-dev. The crate will not link until the library is available.");
    }

    println!("cargo:rustc-link-lib=mfem");

    // The Ubuntu system libmfem-dev is built with MPI + HYPRE; link those
    // runtimes on native targets only.  The WASM build uses a sequential
    // MFEM without MPI or HYPRE, so these are absent.
    if !is_wasm {
        println!("cargo:rustc-link-search=/usr/lib/x86_64-linux-gnu/openmpi/lib");
        println!("cargo:rustc-link-lib=mpi");
        println!("cargo:rustc-link-lib=mpi_cxx");
        println!("cargo:rustc-link-lib=HYPRE");
    }
    println!("cargo:rerun-if-changed=cpp/mfem_bridge.cpp");
    println!("cargo:rerun-if-changed=include/mfem_bridge.h");
    println!("cargo:rerun-if-env-changed=MFEM_DIR");
    println!("cargo:rerun-if-env-changed=MFEM_WASM_ROOT");
}
