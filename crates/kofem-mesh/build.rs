use std::path::PathBuf;

fn main() {
    let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    let is_wasm = target_arch == "wasm32";

    // Determine the Netgen include directory
    let include_dir: Option<PathBuf> = if is_wasm {
        let root = std::env::var("NETGEN_WASM_ROOT")
            .expect("NETGEN_WASM_ROOT must point to an Emscripten build of Netgen");
        Some(PathBuf::from(root).join("include"))
    } else if let Ok(root) = std::env::var("NETGEN_ROOT") {
        Some(PathBuf::from(root).join("include"))
    } else {
        // Try standard system paths in priority order
        [
            PathBuf::from("/usr/include/netgen"),
            PathBuf::from("/usr/local/include/netgen"),
        ]
        .into_iter()
        .find(|p| p.exists())
    };

    // Only compile the C++ bridge when headers are available.
    // Without them `cargo check` still succeeds; linking fails at `cargo build`
    // time with a clear "symbol not found" error pointing at this bridge.
    if let Some(inc) = &include_dir {
        let mut build = cc::Build::new();
        build
            .cpp(true)
            .file("cpp/netgen_bridge.cpp")
            .include("include")
            .include(inc)
            .flag_if_supported("-std=c++17");

        if is_wasm {
            build.flag("-fPIC");
        }

        if is_wasm {
            let root = std::env::var("NETGEN_WASM_ROOT").unwrap();
            println!("cargo:rustc-link-search={}/lib", root);
        } else if let Ok(root) = std::env::var("NETGEN_ROOT") {
            println!("cargo:rustc-link-search={root}/lib");
        }

        build.compile("netgen_bridge");
    } else {
        println!("cargo:warning=Netgen headers not found — set NETGEN_ROOT or install libnetgen-dev. The crate will not link until the library is available.");
    }

    println!("cargo:rustc-link-lib=nglib");
    println!("cargo:rerun-if-changed=cpp/netgen_bridge.cpp");
    println!("cargo:rerun-if-changed=include/netgen_bridge.h");
    println!("cargo:rerun-if-env-changed=NETGEN_ROOT");
    println!("cargo:rerun-if-env-changed=NETGEN_WASM_ROOT");
}
