fn main() {
    // Tauri's default manifest only enables Common Controls. Keep our Windows
    // execution policy and long-path opt-in explicit in the final PE resource.
    println!("cargo:rerun-if-changed=windows-app-manifest.xml");
    let windows = tauri_build::WindowsAttributes::new()
        .app_manifest(include_str!("windows-app-manifest.xml"));
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to build Voxa resources");
}
