//! End-to-end test of `inspect_at_with_clock` against a fake Steam install
//! constructed in a tempdir. Covers the orchestration glue between the
//! parser, libraryfolders.vdf reading, ghost detection, and recommendation
//! computation.

use std::fs;
use std::path::Path;

use pinkbin_steam_inspector::{inspect_at_with_clock, SteamInventory};

const NOW: u64 = 1_777_000_000; // ~2026-05-01

fn write(path: &Path, content: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, content).unwrap();
}

fn build_fake_steam(root: &Path) {
    // libraryfolders.vdf — two libraries, the second pointing at <root>/lib2.
    let lib2 = root.join("lib2");
    fs::create_dir_all(lib2.join("steamapps").join("common")).unwrap();
    let vdf = format!(
        r#"
"libraryfolders"
{{
    "0"
    {{
        "path"  "{root}"
        "apps"  {{ "730" "35000000000" }}
    }}
    "1"
    {{
        "path"  "{lib2}"
        "apps"  {{ "1091500" "70000000000" }}
    }}
}}
"#,
        root = root.to_string_lossy().replace('\\', "/"),
        lib2 = lib2.to_string_lossy().replace('\\', "/"),
    );
    write(&root.join("config").join("libraryfolders.vdf"), &vdf);

    // Library 0: CS2 — 35GB, played 1 day ago. Install dir exists.
    let day_ago = NOW - 86_400;
    fs::create_dir_all(
        root.join("steamapps")
            .join("common")
            .join("Counter-Strike Global Offensive"),
    )
    .unwrap();
    write(
        &root.join("steamapps").join("appmanifest_730.acf"),
        &format!(
            r#"
"AppState"
{{
    "appid"        "730"
    "name"         "Counter-Strike 2"
    "installdir"   "Counter-Strike Global Offensive"
    "StateFlags"   "4"
    "LastPlayed"   "{day_ago}"
    "LastUpdated"  "{day_ago}"
    "SizeOnDisk"   "35000000000"
    "BytesToDownload" "0"
    "BytesDownloaded" "35000000000"
}}
"#
        ),
    );

    // Library 0: a ghost game — ACF exists, but no install dir.
    write(
        &root.join("steamapps").join("appmanifest_999.acf"),
        r#"
"AppState"
{
    "appid"        "999"
    "name"         "Forgotten Game"
    "installdir"   "Forgotten Game Folder"
    "StateFlags"   "4"
    "LastPlayed"   "0"
    "SizeOnDisk"   "10000000000"
}
"#,
    );

    // Library 1: Cyberpunk 2077 — 70GB, never played. Install dir exists.
    fs::create_dir_all(lib2.join("steamapps").join("common").join("Cyberpunk 2077")).unwrap();
    write(
        &lib2.join("steamapps").join("appmanifest_1091500.acf"),
        r#"
"AppState"
{
    "appid"        "1091500"
    "name"         "Cyberpunk 2077"
    "installdir"   "Cyberpunk 2077"
    "StateFlags"   "4"
    "LastPlayed"   "0"
    "SizeOnDisk"   "70000000000"
}
"#,
    );

    // Noise: a non-acf file in steamapps that should be ignored.
    write(&root.join("steamapps").join("README.txt"), "ignore me");
}

#[test]
fn inspect_at_finds_two_libraries_and_three_games() {
    let tmp = tempfile::tempdir().unwrap();
    build_fake_steam(tmp.path());

    let inv: SteamInventory = inspect_at_with_clock(tmp.path(), NOW).expect("inspect ok");

    assert_eq!(inv.libraries.len(), 2, "expected 2 libraries");

    // Library 0: CS2 (recently played) + ghost game.
    let lib0 = &inv.libraries[0];
    assert_eq!(lib0.games.len(), 2);
    let cs2 = lib0
        .games
        .iter()
        .find(|g| g.appid == 730)
        .expect("CS2 present");
    assert_eq!(cs2.name_en, "Counter-Strike 2");
    assert!(!cs2.is_ghost);
    assert!(cs2.is_fully_installed);
    assert!(cs2.last_played_ts.is_some());
    // Played 1 day ago — well below any recommendation threshold.
    assert!(!cs2.default_recommended);
    assert!(cs2.recommendation_reason.is_none());

    let ghost = lib0
        .games
        .iter()
        .find(|g| g.appid == 999)
        .expect("ghost present");
    assert!(ghost.is_ghost);
    assert!(ghost.default_recommended);
    assert_eq!(
        ghost.recommendation_reason.as_deref(),
        Some("ACF 存在但安装目录缺失")
    );

    // Library 1: Cyberpunk — 70GB never played → recommended.
    let lib1 = &inv.libraries[1];
    assert_eq!(lib1.games.len(), 1);
    let cp = &lib1.games[0];
    assert_eq!(cp.appid, 1_091_500);
    assert!(cp.default_recommended);
    let reason = cp.recommendation_reason.as_deref().unwrap();
    assert!(reason.starts_with("70GB"), "got: {}", reason);
    assert!(reason.contains("从未启动"), "got: {}", reason);
}

#[test]
fn inspect_at_is_resilient_to_missing_libraryfolders_vdf() {
    // Steam fresh-install case: no config/libraryfolders.vdf yet, but
    // steamapps/ already has manifests. Should fall back to using the
    // steam_root itself as the only library.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    fs::create_dir_all(
        root.join("steamapps")
            .join("common")
            .join("Counter-Strike Global Offensive"),
    )
    .unwrap();
    write(
        &root.join("steamapps").join("appmanifest_730.acf"),
        r#"
"AppState"
{
    "appid"        "730"
    "name"         "Counter-Strike 2"
    "installdir"   "Counter-Strike Global Offensive"
    "StateFlags"   "4"
    "LastPlayed"   "0"
    "SizeOnDisk"   "35000000000"
}
"#,
    );

    let inv = inspect_at_with_clock(root, NOW).unwrap();
    assert_eq!(inv.libraries.len(), 1);
    assert_eq!(inv.libraries[0].games.len(), 1);
    assert_eq!(inv.libraries[0].games[0].appid, 730);
}

#[test]
fn inspect_at_skips_unparseable_acf_files_without_failing_whole_scan() {
    // One bad apple shouldn't break the whole library list — important for
    // robustness against malformed/partial Steam installs.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    fs::create_dir_all(root.join("steamapps").join("common").join("CS2")).unwrap();
    write(
        &root.join("steamapps").join("appmanifest_730.acf"),
        r#"
"AppState"
{
    "appid"      "730"
    "name"       "Counter-Strike 2"
    "installdir" "CS2"
    "StateFlags" "4"
    "SizeOnDisk" "35000000000"
}
"#,
    );
    write(
        &root.join("steamapps").join("appmanifest_500.acf"),
        "this is not valid keyvalues at all { unbalanced",
    );

    let inv = inspect_at_with_clock(root, NOW).unwrap();
    assert_eq!(inv.libraries.len(), 1);
    assert_eq!(
        inv.libraries[0].games.len(),
        1,
        "valid game should still surface despite malformed sibling"
    );
}
