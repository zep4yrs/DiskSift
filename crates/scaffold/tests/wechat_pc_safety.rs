//! Regression test for `scaffolds/wechat-pc.toml`: every scope glob must match
//! the paths it advertises, and **must not** match WeChat red lines (chat DBs,
//! account state, favorites, Moments, etc.). This file is the executable form
//! of the red-line clauses in `docs/scaffold-requirements/messaging.md`.

use std::path::PathBuf;

fn workspace_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop(); // out of crates/scaffold
    p.pop(); // out of crates
    p
}

fn load_wechat_pc() -> diskwise_scaffold::Scaffold {
    let path = workspace_root().join("scaffolds/wechat-pc.toml");
    let text = std::fs::read_to_string(&path).expect("read wechat-pc.toml");
    toml::from_str(&text).expect("parse wechat-pc.toml")
}

fn build_set(pattern: &str) -> globset::GlobSet {
    let g = globset::GlobBuilder::new(pattern)
        .literal_separator(false)
        .case_insensitive(true)
        .build()
        .unwrap_or_else(|e| panic!("bad glob `{pattern}`: {e}"));
    let mut b = globset::GlobSetBuilder::new();
    b.add(g);
    b.build().unwrap()
}

/// Mirror the env-var expansion used by `scaffold::expand_env` for `%VAR%` syntax.
fn expand(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if let Some(end) = bytes[i + 1..].iter().position(|&b| b == b'%') {
                let var = std::str::from_utf8(&bytes[i + 1..i + 1 + end]).unwrap_or("");
                if let Ok(v) = std::env::var(var) {
                    out.push_str(&v.replace('\\', "/"));
                    i += end + 2;
                    continue;
                }
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

fn matching_scopes<'a>(
    scopes: &'a [(String, globset::GlobSet)],
    path: &str,
) -> Vec<&'a str> {
    scopes
        .iter()
        .filter_map(|(id, gs)| if gs.is_match(path) { Some(id.as_str()) } else { None })
        .collect()
}

#[test]
fn wechat_pc_globs_are_safe() {
    // Force env vars so the test is reproducible regardless of host.
    std::env::set_var("USERPROFILE", "C:/Users/test");
    std::env::set_var("APPDATA", "C:/Users/test/AppData/Roaming");

    let scaffold = load_wechat_pc();
    let scopes: Vec<(String, globset::GlobSet)> = scaffold
        .scopes
        .iter()
        .map(|s| (s.id.clone(), build_set(&expand(&s.glob))))
        .collect();

    // Every scope id should appear at least once in either positives or the
    // schema-only set. We assert positives below; a missing positive would
    // mean an unreachable scope.
    let positives: &[(&str, &str)] = &[
        ("chat-media-cache", "C:/Users/test/Documents/xwechat_files/wxid_aaa_bbb/cache/2026-05/Message/abc123/foo.dat"),
        ("web-resource-cache", "C:/Users/test/Documents/xwechat_files/wxid_aaa_bbb/cache/2026-04/HttpResource/x.png"),
        ("web-resource-cache", "C:/Users/test/Documents/xwechat_files/wxid_aaa_bbb/cache/2026-04/WeAppIcon/01/y.png"),
        ("sticker-cache", "C:/Users/test/Documents/xwechat_files/wxid_aaa_bbb/cache/2026-05/Emoticon/sticker.dat"),
        ("sticker-cache", "C:/Users/test/Documents/xwechat_files/wxid_aaa_bbb/business/emoticon/pack/x"),
        ("temp-files", "C:/Users/test/Documents/xwechat_files/wxid_aaa_bbb/temp/ImageTemp/x.jpg"),
        ("avatar-cache", "C:/Users/test/Documents/xwechat_files/all_users/head_imgs/aa/foo"),
        ("apm-records", "C:/Users/test/Documents/xwechat_files/wxid_aaa_bbb/apm_record/process_duration/x"),
        ("received-files", "C:/Users/test/Documents/xwechat_files/wxid_aaa_bbb/msg/file/2026-05/note.pdf"),
        ("received-videos", "C:/Users/test/Documents/xwechat_files/wxid_aaa_bbb/msg/video/2026-05/clip.mp4"),
        ("voice-attachments", "C:/Users/test/Documents/xwechat_files/wxid_aaa_bbb/msg/attach/abc/voice.amr"),
        ("chat-backups", "C:/Users/test/Documents/xwechat_files/Backup/wxid_aaa/data.bak"),
        ("app-logs-crashes", "C:/Users/test/AppData/Roaming/Tencent/xwechat/log/player/x.log"),
        ("app-logs-crashes", "C:/Users/test/AppData/Roaming/Tencent/xwechat/crashinfo/reports/x.dmp"),
        ("app-update-leftover", "C:/Users/test/AppData/Roaming/Tencent/xwechat/update/download/x.exe"),
        ("app-update-leftover", "C:/Users/test/AppData/Roaming/Tencent/xwechat/confsdk/x.cfg"),
        ("image-cache-3x", "C:/Users/test/Documents/WeChat Files/wxid_legacy/FileStorage/Image/2026-05/img.dat"),
        ("video-cache-3x", "C:/Users/test/Documents/WeChat Files/wxid_legacy/FileStorage/Video/clip.mp4"),
        ("file-cache-3x", "C:/Users/test/Documents/WeChat Files/wxid_legacy/FileStorage/File/note.pdf"),
        ("cache-misc-3x", "C:/Users/test/Documents/WeChat Files/wxid_legacy/FileStorage/Cache/x"),
    ];

    for (expected_id, p) in positives {
        let hits = matching_scopes(&scopes, p);
        assert!(
            hits.contains(expected_id),
            "expected scope `{expected_id}` to match `{p}`, but matched {hits:?}",
        );
    }

    // Red lines: chat history, account state, favorites, Moments, web-view K-V,
    // plugin/runtime dirs, and 3.x equivalents. None of these may match any scope.
    let red_lines: &[&str] = &[
        // 4.x chat DBs
        "C:/Users/test/Documents/xwechat_files/wxid_aaa_bbb/db_storage/MMKV/data.db",
        "C:/Users/test/Documents/xwechat_files/wxid_aaa_bbb/db_storage/message/msg.db",
        "C:/Users/test/Documents/xwechat_files/wxid_aaa_bbb/db_storage/contact/contact.db",
        "C:/Users/test/Documents/xwechat_files/wxid_aaa_bbb/db_storage/emoticon/em.db",
        "C:/Users/test/Documents/xwechat_files/wxid_aaa_bbb/db_storage/favorite/fav.db",
        "C:/Users/test/Documents/xwechat_files/all_users/sqlite/lock.ini",
        "C:/Users/test/Documents/xwechat_files/all_users/sqlite/global.db",
        // 4.x account / login state
        "C:/Users/test/Documents/xwechat_files/wxid_aaa_bbb/config/account.cfg",
        "C:/Users/test/Documents/xwechat_files/all_users/login/login.dat",
        "C:/Users/test/Documents/xwechat_files/all_users/config/global.cfg",
        // 4.x user-irreplaceable: favorites, moments, web-view K-V, editor
        "C:/Users/test/Documents/xwechat_files/wxid_aaa_bbb/business/favorite/fav.dat",
        "C:/Users/test/Documents/xwechat_files/wxid_aaa_bbb/business/sns/moments.db",
        "C:/Users/test/Documents/xwechat_files/wxid_aaa_bbb/business/xweb/mmkv/x.kv",
        "C:/Users/test/Documents/xwechat_files/wxid_aaa_bbb/business/xeditor/state.dat",
        "C:/Users/test/Documents/xwechat_files/wxid_aaa_bbb/business/migrate/x",
        // 4.x Roaming red lines
        "C:/Users/test/AppData/Roaming/Tencent/xwechat/All Users/x",
        "C:/Users/test/AppData/Roaming/Tencent/xwechat/XPlugin/plugin.dll",
        "C:/Users/test/AppData/Roaming/Tencent/xwechat/login/auth.dat",
        "C:/Users/test/AppData/Roaming/Tencent/xwechat/config/app.cfg",
        "C:/Users/test/AppData/Roaming/Tencent/xwechat/ilink/x",
        "C:/Users/test/AppData/Roaming/Tencent/xwechat/radium/x",
        "C:/Users/test/AppData/Roaming/Tencent/xwechat/net/x",
        "C:/Users/test/AppData/Roaming/Tencent/xwechat/net_1/x",
        "C:/Users/test/AppData/Roaming/Tencent/xwechat/uh/x",
        // 3.x red lines
        "C:/Users/test/Documents/WeChat Files/wxid_legacy/Msg/MSG_DB.sqlite",
        "C:/Users/test/Documents/WeChat Files/wxid_legacy/MultiMsg/x.db",
        "C:/Users/test/Documents/WeChat Files/wxid_legacy/config/account.cfg",
        "C:/Users/test/Documents/WeChat Files/wxid_legacy/Accounts/x.dat",
        "C:/Users/test/Documents/WeChat Files/wxid_legacy/FileStorage/Fav/x",
        "C:/Users/test/Documents/WeChat Files/wxid_legacy/Favorites/x",
    ];

    let mut violations = Vec::new();
    for p in red_lines {
        let hits = matching_scopes(&scopes, p);
        if !hits.is_empty() {
            violations.push(format!("`{p}` -> {hits:?}"));
        }
    }
    assert!(
        violations.is_empty(),
        "wechat-pc.toml glob hit red lines:\n  {}",
        violations.join("\n  ")
    );
}
