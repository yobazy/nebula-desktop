fn main() {
    // The nebula release this app is built against: the nebula-core tag in
    // Cargo.toml. The app offers to install exactly that version.
    let manifest = std::fs::read_to_string("Cargo.toml").expect("read Cargo.toml");
    let pin = manifest
        .lines()
        .find(|l| l.trim_start().starts_with("nebula-core"))
        .and_then(|l| l.split("tag = \"v").nth(1))
        .and_then(|rest| rest.split('"').next())
        .expect("nebula-core in Cargo.toml is pinned by a vX.Y.Z tag");
    println!("cargo:rustc-env=NEBULA_PIN={pin}");
    println!("cargo:rerun-if-changed=Cargo.toml");
    tauri_build::build()
}
