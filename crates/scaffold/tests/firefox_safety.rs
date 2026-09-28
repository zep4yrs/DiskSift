//! Regression test for `scaffolds/firefox.toml`: every scope glob must match the
//! paths it advertises, and **must not** match Firefox red lines（历史 / 书签 /
//! 密码 / Cookie / 表单 / 网站数据 / 扩展 / 同步 / 证书 / 设置 / DRM 插件）。
//!
//! 桶名与红线依据：2026-09-28 本机勘测（本机装有 Firefox，全部为真实目录名，
//! 只 ls 未 Read）：漫游根 %APPDATA%/Mozilla/Firefox/（Crash Reports、Pending Pings、
//! Profiles、profiles.ini、installs.ini、Profile Groups、Background Tasks Profiles）、
//! 本地根 %LOCALAPPDATA%/Mozilla/Firefox/Profiles/、两个真实 profile
//! ddrlwxs8.default 与 6uqnofos.zap-client-profile（后缀任意 → profile 段必须用
//! 单段 * 通配）。可清桶：cache2/{doomed,entries,index}、startupCache、shader-cache
//! （漫游 profile 内）、thumbnails、jumpListCache、minidumps、saved-telemetry-pings、
//! Crash Reports/pending（uuid.dmp + uuid.extra 实测存在）、Pending Pings。
//! 红线断言失败 = scaffold glob 写宽了——回去收紧 glob，不要放宽测试。
//!
//! 另外断言 detect 行为：`**/Mozilla/Firefox` 命中漫游/本地双根与重定位根；
//! Thunderbird / SeaMonkey / Chrome / Quark 树、安装目录、Firefox 根的子目录
//! （Crash Reports 等）一律不命中。

use std::path::{Path, PathBuf};

fn workspace_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop(); // out of crates/scaffold
    p.pop(); // out of crates
    p
}

fn load_firefox() -> pinkbin_scaffold::Scaffold {
    let path = workspace_root().join("scaffolds/firefox.toml");
    let text = std::fs::read_to_string(&path).expect("read firefox.toml");
    toml::from_str(&text).expect("parse firefox.toml")
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

fn matching_scopes<'a>(scopes: &'a [(String, globset::GlobSet)], path: &str) -> Vec<&'a str> {
    scopes
        .iter()
        .filter_map(|(id, gs)| {
            if gs.is_match(path) {
                Some(id.as_str())
            } else {
                None
            }
        })
        .collect()
}

#[test]
fn firefox_globs_are_safe() {
    // 固定 env 让测试在所有平台上路径一致（scope glob 当前不含 %VAR%，保持与
    // 模板同款配置，日后若加 env 路径仍可复现）。
    std::env::set_var("USERPROFILE", "C:/Users/test");
    std::env::set_var("APPDATA", "C:/Users/test/AppData/Roaming");
    std::env::set_var("LOCALAPPDATA", "C:/Users/test/AppData/Local");
    std::env::set_var("HOME", "/home/test");

    let scaffold = load_firefox();
    let scopes: Vec<(String, globset::GlobSet)> = scaffold
        .scopes
        .iter()
        .map(|s| (s.id.clone(), build_set(&expand(&s.glob))))
        .collect();

    // ========================================================================
    // 正向断言：每个 scope id 至少一条命中路径。
    // directory 粒度的 scope glob 无 /**，正向路径是桶目录本身；file 粒度的
    // scope 正向路径是桶内文件。
    // ========================================================================
    let roaming = "C:/Users/test/AppData/Roaming/Mozilla/Firefox";
    let local = "C:/Users/test/AppData/Local/Mozilla/Firefox";
    let positives: Vec<(&str, String)> = vec![
        // http-cache：directory 粒度；本机实测桶在本地根，glob 根无关 →
        // 本地 / 漫游两根 + 两种 profile 命名（.default 与自定义后缀）都要命中。
        ("http-cache", format!("{local}/Profiles/ddrlwxs8.default/cache2")),
        (
            "http-cache",
            format!("{local}/Profiles/6uqnofos.zap-client-profile/cache2"),
        ),
        ("http-cache", format!("{roaming}/Profiles/ddrlwxs8.default/cache2")),
        // ** 重定位兜底（改盘符 + 中间多级目录）。
        (
            "http-cache",
            "D:/relocated/FirefoxData/Mozilla/Firefox/Profiles/a1b2c3d4.default/cache2".to_string(),
        ),
        // macOS / Linux 布局不设正向断言：Firefox 的 macOS 根是 `Caches/Firefox`
        // （无 Mozilla 段）、Linux 根是 `.mozilla/firefox`（.mozilla ≠ Mozilla），
        // 与 scope 锚 `Mozilla/Firefox/Profiles/*` 结构性不匹配——与 edge.toml 同款
        // 取舍（scope Windows 锚定；detect 列 macOS/Linux 路径仅供 UI 显示，
        // 见 firefox.toml 注）。
        // startup-cache：directory 粒度；桶内文件为 2026-09-28 实测名。
        ("startup-cache", format!("{local}/Profiles/ddrlwxs8.default/startupCache")),
        (
            "startup-cache",
            format!("{roaming}/Profiles/6uqnofos.zap-client-profile/startupCache"),
        ),
        // shader-cache：2026-09-28 实测位于漫游 profile（glob 根无关，本地也覆盖）。
        ("shader-cache", format!("{roaming}/Profiles/ddrlwxs8.default/shader-cache")),
        (
            "shader-cache",
            format!("{local}/Profiles/6uqnofos.zap-client-profile/shader-cache"),
        ),
        // thumbnail-cache：本地 profile 实测 thumbnails + jumpListCache 两个桶。
        ("thumbnail-cache", format!("{local}/Profiles/ddrlwxs8.default/thumbnails")),
        (
            "thumbnail-cache",
            format!("{local}/Profiles/ddrlwxs8.default/jumpListCache"),
        ),
        (
            "thumbnail-cache",
            format!("{roaming}/Profiles/6uqnofos.zap-client-profile/thumbnails"),
        ),
        // crash-minidumps：file 粒度 + days 30（.dmp 为 minidump 标准后缀）。
        (
            "crash-minidumps",
            format!("{roaming}/Profiles/ddrlwxs8.default/minidumps/52cbb342-2769-4477-bb6b-832765e81eda.dmp"),
        ),
        // telemetry-pings：file 粒度 + days 30。
        (
            "telemetry-pings",
            format!("{roaming}/Profiles/ddrlwxs8.default/saved-telemetry-pings/20260928-ping.json"),
        ),
        // crash-reports-pending：2026-09-28 实测 uuid.dmp + uuid.extra 两类文件。
        (
            "crash-reports-pending",
            format!("{roaming}/Crash Reports/pending/52cbb342-2769-4477-bb6b-832765e81eda.dmp"),
        ),
        (
            "crash-reports-pending",
            format!("{roaming}/Crash Reports/pending/52cbb342-2769-4477-bb6b-832765e81eda.extra"),
        ),
        // pending-pings：漫游根桶。
        (
            "pending-pings",
            format!("{roaming}/Pending Pings/20260928-event-ping.json"),
        ),
    ];

    for (expected_id, p) in &positives {
        let hits = matching_scopes(&scopes, p);
        assert!(
            hits.contains(expected_id),
            "expected scope `{expected_id}` to match `{p}`, but matched {hits:?}",
        );
    }

    // ========================================================================
    // 红线断言：以下路径必须不被任何 scope 命中。
    // 前段：CLAUDE.md 通用红线片段（*.db / db_storage / Msg / Accounts / login /
    //       config / Favorite / key / crypto / All Users），放进 Firefox 树内
    //       才有意义——那是 scope 够得着的地方。
    // 中段：Firefox 特有红线，全部为 2026-09-28 本机真实 profile 列目录名确认
    //       存在的（标注"实测"）；Firefox 根的元数据（profiles.ini 等）同批实测。
    // 后段：其它应用的树（Thunderbird / SeaMonkey / Chrome / Quark）——scope 锚定
    //       Mozilla/Firefox 不得外溢；Crash Reports 下 pending 以外的内容；
    //       以及 directory 粒度契约（桶内文件不被 glob 单独命中）。
    // ========================================================================
    let rp = "C:/Users/test/AppData/Roaming/Mozilla/Firefox/Profiles/ddrlwxs8.default";
    let lp = "C:/Users/test/AppData/Local/Mozilla/Firefox/Profiles/ddrlwxs8.default";
    let red_lines: Vec<String> = vec![
        // ---- 通用红线（CLAUDE.md），置于 Firefox 树内 ----
        // *.db / *.sqlite 家族（Firefox 的用户库全是 .sqlite，一律不碰）
        format!("{rp}/places.sqlite"),                     // 实测
        format!("{rp}/places.sqlite-wal"),                 // 实测
        format!("{rp}/places.sqlite-shm"),                 // 实测
        format!("{rp}/cookies.sqlite"),                    // 实测
        format!("{rp}/cookies.sqlite-wal"),                // 实测
        format!("{rp}/cookies.sqlite-shm"),                // 实测
        format!("{rp}/formhistory.sqlite"),                // 实测
        format!("{rp}/favicons.sqlite"),                   // 实测
        format!("{rp}/webappsstore.sqlite"),               // 实测
        format!("{rp}/storage.sqlite"),                    // 实测
        format!("{rp}/storage-sync-v2.sqlite"),            // 实测
        format!("{rp}/synced-tabs.db"),                    // 实测
        format!("{rp}/tabnotes.sqlite"),                   // 实测
        format!("{rp}/content-prefs.sqlite"),              // 实测
        format!("{rp}/permissions.sqlite"),                // 实测
        format!("{rp}/protections.sqlite"),                // 实测
        format!("{rp}/breach-alerts.db"),                  // 实测
        format!("{rp}/chat-store.sqlite"),                 // 实测
        format!("{rp}/bounce-tracking-protection.sqlite"), // 实测
        format!("{rp}/domain_to_categories.sqlite"),       // 实测
        format!("{rp}/key4.db"),                           // 实测（密码密钥库）
        format!("{rp}/logins.db"),                         // 实测
        // db_storage / Msg / Accounts / login / config / Favorite / Fav / key / crypto / All Users
        format!("{rp}/db_storage/MMKV/data.db"),
        format!("{rp}/Msg/MultiMsg/msg.db"),
        format!("{rp}/Accounts/session.dat"),
        format!("{rp}/login/auth.dat"),
        format!("{rp}/config/account.cfg"),
        format!("{rp}/Favorite/fav.dat"),
        format!("{rp}/Fav/list.json"),
        format!("{rp}/key/material.key"),
        format!("{rp}/crypto/store.bin"),
        format!("{rp}/All Users/x"),
        // ---- Firefox 特有红线：历史 / 书签 / 会话（用户原始数据及其备份）----
        format!("{rp}/bookmarkbackups/bookmarks-2026-09-28.jsonlz4"), // 实测（bookmarkbackups）
        format!("{rp}/sessionstore-backups/recovery.jsonlz4"), // 实测（sessionstore-backups）
        format!("{rp}/sessionCheckpoints.json"),               // 实测
        // ---- Firefox 特有红线：密码 / 证书 / 同步 ----
        format!("{rp}/logins.json"),        // 实测
        format!("{rp}/logins-backup.json"), // 实测
        format!("{rp}/cert9.db"),           // 实测
        format!("{rp}/cert_override.txt"),  // 实测
        format!("{rp}/pkcs11.txt"),         // 实测
        format!("{rp}/weave/x"),            // 实测（weave = 同步）
        format!("{rp}/signedInUser.json"),  // 实测
        // ---- Firefox 特有红线：网站数据 / 扩展 / 设置 ----
        format!("{rp}/storage/default/https+++example.com/idb/x"), // 实测（storage）
        format!("{rp}/containers.json"),                           // 实测
        format!("{rp}/handlers.json"),                             // 实测
        format!("{rp}/search.json.mozlz4"),                        // 实测
        format!("{rp}/prefs.js"),                                  // 实测
        format!("{rp}/xulstore.json"),                             // 实测
        format!("{rp}/downloads.json"),                            // 实测
        format!("{rp}/extensions/SomeExt.xpi"),                    // 实测（extensions）
        format!("{rp}/extensions.json"),                           // 实测
        format!("{rp}/extension-preferences.json"),                // 实测
        format!("{rp}/extension-store/x"),                         // 实测
        format!("{rp}/extension-store-menus/x"),                   // 实测
        format!("{rp}/addons.json"),                               // 实测
        format!("{rp}/gmp-widevinecdm/1.0/x"),                     // 实测（DRM 插件）
        format!("{rp}/gmp-gmpopenh264/1.0/x"),                     // 实测（编解码插件）
        format!("{rp}/datareporting/x"),                           // 实测
        format!("{rp}/settings/x"),                                // 实测
        format!("{lp}/settings/x"),                                // 实测（本地根也有 settings）
        format!("{rp}/features/x"),                                // 实测
        format!("{rp}/taskbartabs/x"),                             // 实测
        format!("{rp}/crashes/Event-1.json"), // 实测（crashes，与 minidumps 不同桶）
        format!("{lp}/safebrowsing/x"),       // 实测（本地根 safebrowsing）
        // ---- Firefox 特有红线：Firefox 根元数据（2026-09-28 实测）----
        format!("{roaming}/profiles.ini"),
        format!("{roaming}/installs.ini"),
        format!("{roaming}/Profile Groups/x"),
        format!("{roaming}/Background Tasks Profiles/x"),
        format!("{roaming}/Crash Reports/events/x"), // 实测（events）
        format!("{roaming}/Crash Reports/glean/x"),  // 实测（glean）
        format!("{roaming}/Crash Reports/crashreporter_settings.json"), // 实测
        format!("{roaming}/Crash Reports/submit.log"), // 实测
        // ---- 其它应用的树（不得外溢）----
        "C:/Users/anyone/AppData/Roaming/Thunderbird/Profiles/abc123.default/cache2".to_string(),
        "C:/Users/anyone/AppData/Roaming/Mozilla/SeaMonkey/Profiles/abc123.default/cache2"
            .to_string(),
        "C:/Users/anyone/AppData/Local/Google/Chrome/User Data/Default/Cache".to_string(),
        "C:/Users/anyone/AppData/Local/Quark/User Data/Default/Cache/Cache_Data/f_000001"
            .to_string(),
        // ---- 安装目录 ----
        "C:/Users/anyone/Program Files/Mozilla Firefox/firefox.exe".to_string(),
        // ---- directory 粒度契约：桶内文件不被 glob 单独命中（回收以桶目录展开）----
        format!("{lp}/cache2/entries/0123456789abcdef"),
        format!("{lp}/startupCache/startupCache.8.little"),
        format!("{roaming}/Profiles/ddrlwxs8.default/shader-cache/x.bin"),
        format!("{lp}/thumbnails/thumb.png"),
    ];

    let mut violations = Vec::new();
    for p in &red_lines {
        let hits = matching_scopes(&scopes, p);
        if !hits.is_empty() {
            violations.push(format!("`{p}` -> {hits:?}"));
        }
    }
    assert!(
        violations.is_empty(),
        "firefox.toml glob hit red lines:\n  {}",
        violations.join("\n  ")
    );
}

/// detect 行为回归（不固定 env：只依赖 env 无关的 `**/Mozilla/Firefox` 通配，
/// 结论在任何宿主环境下确定）：
/// - `**/Mozilla/Firefox` 命中漫游根、本地根与重定位根（Gecko 双根布局都由它点亮）。
/// - Thunderbird / SeaMonkey（同在 Mozilla 下）与 Firefox 根的子目录、安装目录、
///   Chrome / Quark 的树一律不命中。
///
/// 本机装有 Firefox（2026-09-28 实测 %APPDATA%/Mozilla/Firefox 存在），
/// detect 的 env 路径在真实机器上会点亮 UI 卡片。
#[test]
fn firefox_detect_anchors_mozilla_firefox_roots_only() {
    let scaffolds = vec![load_firefox()];
    let tmp = std::env::temp_dir().join(format!(
        "pinkbin-firefox-detect-test-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));

    // Positive：漫游根（%APPDATA% 形态）。
    let pos_roaming = tmp.join("AppData/Roaming/Mozilla/Firefox");
    std::fs::create_dir_all(&pos_roaming).unwrap();

    // Positive：本地根（%LOCALAPPDATA% 形态）。
    let pos_local = tmp.join("AppData/Local/Mozilla/Firefox");
    std::fs::create_dir_all(&pos_local).unwrap();

    // Positive：重定位（改盘符 + 中间多级目录）。
    let pos_relocated = tmp.join("Disk2/Portable/Mozilla/Firefox");
    std::fs::create_dir_all(&pos_relocated).unwrap();

    // Negative：Mozilla 下的兄弟应用与其它浏览器（Thunderbird / SeaMonkey /
    // Chrome / Quark，2026-09-28 勘测到的真实根形态）。
    let neg_thunderbird = tmp.join("AppData/Roaming/Thunderbird");
    std::fs::create_dir_all(&neg_thunderbird).unwrap();
    let neg_seamonkey = tmp.join("AppData/Roaming/Mozilla/SeaMonkey");
    std::fs::create_dir_all(&neg_seamonkey).unwrap();
    let neg_chrome = tmp.join("AppData/Local/Google/Chrome/User Data");
    std::fs::create_dir_all(&neg_chrome).unwrap();
    let neg_quark = tmp.join("AppData/Local/Quark/User Data");
    std::fs::create_dir_all(&neg_quark).unwrap();

    // Negative：Firefox 根的子目录与安装目录（glob 全路径匹配，不前缀匹配）。
    let neg_subdir = tmp.join("AppData/Roaming/Mozilla/Firefox/Crash Reports");
    std::fs::create_dir_all(&neg_subdir).unwrap();
    let neg_install = tmp.join("Program Files/Mozilla Firefox");
    std::fs::create_dir_all(&neg_install).unwrap();

    let assert_match = |path: &Path, expected: Option<&str>, label: &str| {
        let got = pinkbin_scaffold::detect_for(&scaffolds, path);
        assert_eq!(
            got.as_deref(),
            expected,
            "{label}: detect_for({path:?}) = {got:?}, expected {expected:?}",
        );
    };

    assert_match(&pos_roaming, Some("firefox"), "** wildcard roaming root");
    assert_match(&pos_local, Some("firefox"), "** wildcard local root");
    assert_match(
        &pos_relocated,
        Some("firefox"),
        "** wildcard relocated root",
    );
    assert_match(&neg_thunderbird, None, "Thunderbird must not match");
    assert_match(&neg_seamonkey, None, "SeaMonkey must not match");
    assert_match(&neg_chrome, None, "Chrome User Data must not match");
    assert_match(&neg_quark, None, "Quark User Data must not match");
    assert_match(&neg_subdir, None, "Firefox root subdir must not match");
    assert_match(&neg_install, None, "install dir must not match");

    // compile_all / detect_compiled（生产热路径）与 detect_for 结论一致。
    let compiled = pinkbin_scaffold::compile_all(&scaffolds);
    let assert_compiled = |path: &Path, expected: Option<&str>, label: &str| {
        let got = pinkbin_scaffold::detect_compiled(&compiled, path);
        assert_eq!(
            got.as_deref(),
            expected,
            "{label} (compiled): detect_compiled({path:?}) = {got:?}, expected {expected:?}",
        );
    };
    assert_compiled(&pos_roaming, Some("firefox"), "roaming root");
    assert_compiled(&pos_local, Some("firefox"), "local root");
    assert_compiled(&pos_relocated, Some("firefox"), "relocated root");
    assert_compiled(&neg_seamonkey, None, "SeaMonkey root");
    assert_compiled(&neg_subdir, None, "Firefox root subdir");
    assert_compiled(&neg_install, None, "install dir");

    // Cleanup — best-effort, ignore errors.
    let _ = std::fs::remove_dir_all(&tmp);
}
