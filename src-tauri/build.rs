fn main() {
    sideload_conpty();
    // In debug builds tauri-build would also copy `bundle.resources` (the ConPTY
    // binaries) next to the exe — which fails while a dev instance has conpty.dll
    // loaded. `sideload_conpty` already handles dev (tolerating locked files), so drop
    // the resources for debug. Release builds keep them for the installer.
    if std::env::var("PROFILE").as_deref() == Ok("debug") && std::env::var_os("TAURI_CONFIG").is_none() {
        // SAFETY: build scripts are single-threaded at this point.
        unsafe { std::env::set_var("TAURI_CONFIG", r#"{"bundle":{"resources":[]}}"#) };
    }
    tauri_build::build()
}

/// Copy the vendored ConPTY (conpty.dll + OpenConsole.exe) next to the built exe so
/// `cargo run` / `tauri dev` pick it up. portable-pty prefers a side-by-side
/// conpty.dll over the (much slower) inbox one in kernel32. Release bundles ship
/// the same files via `bundle.resources` in tauri.conf.json.
fn sideload_conpty() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("x86_64") => "x64",
        Ok("aarch64") => "arm64",
        _ => return,
    };
    let src = std::path::Path::new("vendor/conpty").join(arch);
    println!("cargo:rerun-if-changed={}", src.display());
    // OUT_DIR = target/<profile>/build/<pkg>-<hash>/out -> target/<profile>
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let Some(profile_dir) = out.ancestors().nth(3) else { return };
    for f in ["conpty.dll", "OpenConsole.exe"] {
        let from = src.join(f);
        let to = profile_dir.join(f);
        if from.exists() {
            // Ignore failures (e.g. file locked by a running instance).
            let _ = std::fs::copy(&from, &to);
        }
    }
}
