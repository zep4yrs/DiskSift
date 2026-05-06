//! Integration tests that load real-shape Steam fixture files from disk and
//! run them through the parser. Complements the inline unit tests in
//! `lib.rs` — those cover edge cases of the parser itself; these verify the
//! fixture path (UTF-8 read, tab-indented Steam style, full field set) end
//! to end.

use pinkbin_steam_inspector::{parse_appmanifest, parse_libraryfolders};

const ACF_730: &str = include_str!("fixtures/appmanifest_730.acf");
const LIBRARYFOLDERS: &str = include_str!("fixtures/libraryfolders.vdf");

#[test]
fn cs2_appmanifest_round_trip() {
    let m = parse_appmanifest(ACF_730).expect("CS2 fixture parses");
    assert_eq!(m.appid, 730);
    assert_eq!(m.name, "Counter-Strike 2");
    assert_eq!(m.install_dir, "Counter-Strike Global Offensive");
    assert_eq!(m.size_on_disk, 35_123_456_789);
    assert_eq!(m.last_played, Some(1_735_000_000));
    assert_eq!(m.last_updated, Some(1_730_000_000));
    assert!(m.is_fully_installed());
    assert_eq!(m.bytes_to_download, 0);
    assert_eq!(m.bytes_downloaded, 35_123_456_789);
}

#[test]
fn libraryfolders_two_roots() {
    let roots = parse_libraryfolders(LIBRARYFOLDERS).expect("libraryfolders fixture parses");
    assert_eq!(roots.len(), 2, "expected exactly two library roots");
    let strs: Vec<String> = roots
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    assert!(strs[0].contains("Program Files"), "got: {:?}", strs);
    assert!(strs[1].contains("SteamLibrary"), "got: {:?}", strs);
}

/// Privacy red line check: `RawAppManifest` schema must not expose anything
/// outside the public Steam metadata set. If someone adds a field that pulls
/// from `userdata/`, `loginusers.vdf`, or game internals, this test should be
/// updated to assert the new field is also public-only — or the change should
/// be reverted.
#[test]
fn raw_appmanifest_only_exposes_public_fields() {
    let m = parse_appmanifest(ACF_730).unwrap();
    // Compile-time check by exhaustive match on the public fields. Adding a
    // private/sensitive field to RawAppManifest will require updating this
    // test, which forces a review.
    let pinkbin_steam_inspector::RawAppManifest {
        appid,
        name,
        install_dir,
        size_on_disk,
        last_played,
        last_updated,
        state_flags,
        bytes_to_download,
        bytes_downloaded,
    } = m;
    let _ = (
        appid,
        name,
        install_dir,
        size_on_disk,
        last_played,
        last_updated,
        state_flags,
        bytes_to_download,
        bytes_downloaded,
    );
}
