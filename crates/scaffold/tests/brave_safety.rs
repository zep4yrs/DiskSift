//! Regression test for `scaffolds/brave.toml`: every scope glob must match the
//! paths it advertises, and **must not** match Brave red lines（书签 / 历史 /
//! 密码 / Cookies / 网站数据 / 扩展状态 / Brave 钱包与 Rewards / 隐私沙箱与加密物料）。
//!
//! 桶名依据：2026-09-28 本机勘测。本机未安装 Brave（%LOCALAPPDATA%/BraveSoftware、
//! %APPDATA%、Program Files 均无 brave/BraveSoftware 命名），用同机真实 Chromium 树
//! %LOCALAPPDATA%/Quark/User Data + %LOCALAPPDATA%/CEF/User Data 只列目录名验证
//! Chromium 通用桶（Brave 与 Chrome 同属 Chromium 上游，桶名一致）：
//! Cache/Cache_Data、Code Cache、GPUCache、DawnGraphiteCache、DawnWebGPUCache、
//! Service Worker/{Database,ScriptCache}、blob_storage、GrShaderCache、
//! GraphiteDawnCache、ShaderCache、Crashpad、component_crx_cache、
//! extensions_crx_cache。红线同批勘测确认存在；Brave 专属红线（BraveWallet /
//! Rewards / Tor Profile）为上游知名目录、本机无法勘测，zero-match 断言对
//! 不存在的路径天然成立，作用是防止未来 glob 放宽。
//! 红线断言失败 = scaffold glob 写宽了——回去收紧 glob，不要放宽测试。
//!
//! 另外断言 detect 行为：`**/BraveSoftware/Brave-Browser/User Data` 通配兜底命中
//! 重定位数据根；其它 Chromium 应用的树（Chrome / Quark / CEF / Edge）、
//! BraveSoftware/Update 兄弟目录与安装目录必须不命中。

use std::path::{Path, PathBuf};

fn workspace_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop(); // out of crates/scaffold
    p.pop(); // out of crates
    p
}

fn load_brave() -> pinkbin_scaffold::Scaffold {
    let path = workspace_root().join("scaffolds/brave.toml");
    let text = std::fs::read_to_string(&path).expect("read brave.toml");
    toml::from_str(&text).expect("parse brave.toml")
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
fn brave_globs_are_safe() {
    // 固定 env 让测试在所有平台上路径一致（scope glob 当前不含 %VAR%，保持与
    // 模板同款配置，日后若加 env 路径仍可复现）。
    std::env::set_var("USERPROFILE", "C:/Users/test");
    std::env::set_var("APPDATA", "C:/Users/test/AppData/Roaming");
    std::env::set_var("LOCALAPPDATA", "C:/Users/test/AppData/Local");
    std::env::set_var("HOME", "/home/test");

    let scaffold = load_brave();
    let scopes: Vec<(String, globset::GlobSet)> = scaffold
        .scopes
        .iter()
        .map(|s| (s.id.clone(), build_set(&expand(&s.glob))))
        .collect();

    // ========================================================================
    // 正向断言：每个 scope id 至少一条命中路径。
    // directory 粒度的 scope glob 无 /**，正向路径是桶目录本身；file 粒度的
    // scope（component-crx-cache / crash-dumps）正向路径是桶内文件。
    // ========================================================================
    let ud = "C:/Users/test/AppData/Local/BraveSoftware/Brave-Browser/User Data";
    let positives: Vec<(&str, String)> = vec![
        // http-cache：directory 粒度；Default + Profile N 多 profile + channel 通配
        // （Brave-Browser* 覆盖 Brave-Browser / -Beta / -Nightly / -Dev）+ ** 重定位兜底。
        ("http-cache", format!("{ud}/Default/Cache")),
        ("http-cache", format!("{ud}/Profile 1/Cache")),
        ("http-cache", format!("{ud}/Profile 2/Cache")),
        (
            "http-cache",
            "C:/Users/test/AppData/Local/BraveSoftware/Brave-Browser-Beta/User Data/Default/Cache"
                .to_string(),
        ),
        (
            "http-cache",
            "C:/Users/test/AppData/Local/BraveSoftware/Brave-Browser-Nightly/User Data/Default/Cache"
                .to_string(),
        ),
        (
            "http-cache",
            "D:/relocated/Browsers/BraveSoftware/Brave-Browser/User Data/Default/Cache".to_string(),
        ),
        // macOS / Linux 布局：Brave 保持 BraveSoftware/Brave-Browser 两段式结构，
        // Windows 锚三平台通吃（根名为上游文档知名命名，本机未安装未勘测）。
        (
            "http-cache",
            "/Users/test/Library/Application Support/BraveSoftware/Brave-Browser/User Data/Default/Cache"
                .to_string(),
        ),
        (
            "http-cache",
            "/home/test/.config/BraveSoftware/Brave-Browser/User Data/Default/Cache".to_string(),
        ),
        // js-bytecode-cache：Code Cache 整桶（桶名含空格，brace 分支同
        // vscode.toml {Code,Code - Insiders} 先例）。
        ("js-bytecode-cache", format!("{ud}/Default/Code Cache")),
        ("js-bytecode-cache", format!("{ud}/Profile 1/Code Cache")),
        // gpu-shader-cache：DawnGraphiteCache / DawnWebGPUCache 为 2026-09-28 实测名。
        ("gpu-shader-cache", format!("{ud}/Default/GPUCache")),
        ("gpu-shader-cache", format!("{ud}/Default/DawnGraphiteCache")),
        ("gpu-shader-cache", format!("{ud}/Default/DawnWebGPUCache")),
        ("gpu-shader-cache", format!("{ud}/Profile 1/GPUCache")),
        // service-worker-cache：整桶；桶内 Database/ + ScriptCache/ 为 2026-09-28 实测名。
        ("service-worker-cache", format!("{ud}/Default/Service Worker")),
        ("service-worker-cache", format!("{ud}/Profile 1/Service Worker")),
        // blob-storage：整桶。
        ("blob-storage", format!("{ud}/Default/blob_storage")),
        ("blob-storage", format!("{ud}/Profile 2/blob_storage")),
        // shader-cache：User Data 顶层三个着色器缓存桶（2026-09-28 实测名）。
        ("shader-cache", format!("{ud}/GrShaderCache")),
        ("shader-cache", format!("{ud}/GraphiteDawnCache")),
        ("shader-cache", format!("{ud}/ShaderCache")),
        // component-crx-cache：file 粒度 + days 30，路径是桶内文件（fixture 名）。
        ("component-crx-cache", format!("{ud}/component_crx_cache/0a1b2c3d.crx")),
        (
            "component-crx-cache",
            format!("{ud}/extensions_crx_cache/nkbihfbeogaeaoehlefnkodbefgpgknn/1.2.3.crx"),
        ),
        // crash-dumps：file 粒度 + days 30，reports/*.dmp 为 Crashpad 标准布局。
        ("crash-dumps", format!("{ud}/Crashpad/reports/1a2b3c4d.dmp")),
        ("crash-dumps", format!("{ud}/Crashpad/reports/9f8e7d6c.dmp")),
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
    //       config / Favorite / key / crypto / All Users），放进 User Data 树内
    //       才有意义——那是 scope 够得着的地方。
    // 中段：Chromium 通用红线，带"实测"标记的是 2026-09-28 在本机 Quark
    //       （Chromium 同源布局）User Data 下列目录名确认存在的；Brave 专属红线
    //       （BraveWallet / Rewards / Tor Profile）为上游知名目录、本机无法勘测，
    //       zero-match 断言防未来 glob 放宽。
    // 后段：其它 Chromium 应用的同构树（Chrome / Edge / Quark / CEF / Tabbit，
    //       2026-09-28 本机实测存在同名根）、BraveSoftware/Update 兄弟目录、
    //       安装目录——scope 锚定 BraveSoftware/Brave-Browser* 且要求 /User Data/
    //       段，不得外溢；以及 directory 粒度契约（桶内文件不被 glob 单独命中）。
    // ========================================================================
    let red_lines: Vec<String> = vec![
        // ---- 通用红线（CLAUDE.md），置于 Brave 树内 ----
        // *.db / 聊天 DB 形态（防日后 glob 放宽误伤）
        format!("{ud}/Default/heavy_ad_intervention_opt_out.db"), // 实测
        format!("{ud}/Default/db_storage/MMKV/data.db"),
        format!("{ud}/Default/Msg/MultiMsg/msg.db"),
        // Accounts / login / config
        format!("{ud}/Accounts/session.dat"),
        format!("{ud}/login/auth.dat"),
        format!("{ud}/config/account.cfg"),
        // Favorite / Fav（书签即收藏）
        format!("{ud}/Favorite/fav.dat"),
        format!("{ud}/Fav/list.json"),
        // key / crypto（加密物料）
        format!("{ud}/key/material.key"),
        format!("{ud}/crypto/store.bin"),
        // All Users
        format!("{ud}/All Users/x"),
        // ---- Chromium 通用红线：User Data 顶层状态 ----
        format!("{ud}/Local State"),                      // 实测
        format!("{ud}/First Run"),                        // 实测
        format!("{ud}/Last Browser"),                     // 实测
        format!("{ud}/Last Version"),                     // 实测
        format!("{ud}/BrowserMetrics-spare.pma"),         // 实测
        format!("{ud}/Safe Browsing/Cert Chains.bin"),    // 实测（Safe Browsing）
        format!("{ud}/WidevineCdm/1.0.0/manifest.json"),  // 实测（WidevineCdm）
        format!("{ud}/Variations/seed.json"),             // 实测（Variations）
        // ---- Chromium 通用红线：profile 用户数据 ----
        format!("{ud}/Default/Bookmarks"),                // 实测
        format!("{ud}/Default/Bookmarks.bak"),            // 实测
        format!("{ud}/Default/History"),                  // 实测
        format!("{ud}/Default/History-journal"),          // 实测
        format!("{ud}/Default/Login Data"),               // 实测
        format!("{ud}/Default/Login Data-journal"),       // 实测
        format!("{ud}/Default/Login Data For Account"),   // 实测
        format!("{ud}/Default/Web Data"),                 // 实测
        format!("{ud}/Default/Web Data-journal"),         // 实测
        format!("{ud}/Default/Favicons"),                 // 实测
        format!("{ud}/Default/Favicons-journal"),         // 实测
        format!("{ud}/Default/Preferences"),              // 实测
        format!("{ud}/Default/Secure Preferences"),       // 实测
        format!("{ud}/Default/Shortcuts"),                // 实测
        format!("{ud}/Default/Top Sites"),                // 实测
        format!("{ud}/Default/Sessions/1a2b3c"),          // 实测（Sessions）
        format!("{ud}/Default/Sync Data/SyncData.sqlite"), // 实测（Sync Data）
        format!("{ud}/Default/Account Web Data/x"),       // 实测
        format!("{ud}/Default/Affiliation Database/x"),   // 实测
        // ---- Chromium 通用红线：登录态 / 网站数据 ----
        format!("{ud}/Default/Network/Cookies"),          // 实测（Network）
        format!("{ud}/Default/Local Storage/leveldb/000003.log"), // 实测
        format!("{ud}/Default/Session Storage/000003.log"), // 实测
        format!("{ud}/Default/IndexedDB/https_example/x"), // 实测
        format!("{ud}/Default/WebStorage/x"),             // 实测
        // ---- Chromium 通用红线：扩展状态（扩展登录 token 所在）----
        format!("{ud}/Default/Extension State/x"),          // 实测
        format!("{ud}/Default/Local Extension Settings/x"), // 实测
        format!("{ud}/Default/Extension Rules/x"),          // 实测
        format!("{ud}/Default/Extension Scripts/x"),        // 实测
        format!("{ud}/Default/GCM Store/x"),                // 实测
        // ---- Chromium 通用红线：隐私沙箱 / 拿不准 → 红线 ----
        format!("{ud}/Default/DIPS/x"),                     // 实测
        format!("{ud}/Default/DIPS-wal"),                   // 实测
        format!("{ud}/Default/SharedStorage/x"),            // 实测
        format!("{ud}/Default/SharedStorage-wal"),          // 实测
        format!("{ud}/Default/Shared Dictionary/x"),        // 实测
        format!("{ud}/Default/BrowsingTopicsSiteData/x"),   // 实测
        format!("{ud}/Default/BrowsingTopicsState/x"),      // 实测
        format!("{ud}/Default/BudgetDatabase/x"),           // 实测
        format!("{ud}/Default/chrome_cart_db/x"),           // 实测
        format!("{ud}/Default/discounts_db/x"),             // 实测
        format!("{ud}/Default/commerce_subscription_db/x"), // 实测
        format!("{ud}/Default/parcel_tracking_db/x"),       // 实测
        format!("{ud}/Default/optimization_guide_hint_cache_store/x"), // 实测
        // ---- Chromium 通用红线：证书 / 加密物料 ----
        format!("{ud}/Default/ClientCertificates/x"),     // 实测
        format!("{ud}/Default/MediaDeviceSalts"),         // 实测
        format!("{ud}/Default/MediaDeviceSalts-journal"), // 实测
        format!("{ud}/Default/passkey_enclave_state/x"),  // 实测
        format!("{ud}/Default/trusted_vault.pb"),         // 实测
        // ---- Brave 专属红线（上游知名目录，本机未安装无法勘测；断言防 glob 放宽）----
        format!("{ud}/Default/BraveWallet/x"),  // 钱包助记词 / 私钥
        format!("{ud}/Profile 1/BraveWallet/x"),
        format!("{ud}/Default/Rewards/rewards.db"), // BAT 账本
        format!("{ud}/Default/Rewards/x"),
        format!("{ud}/Tor Profile/x"),
        // ---- Chromium 通用红线：Profile 1 同款抽查 ----
        format!("{ud}/Profile 1/Bookmarks"),
        format!("{ud}/Profile 1/History"),
        format!("{ud}/Profile 1/Login Data"),
        format!("{ud}/Profile 1/Network/Cookies"),
        format!("{ud}/Profile 1/Preferences"),
        // ---- 其它 Chromium 应用的同构 User Data 树（2026-09-28 本机实测存在同名根）----
        "C:/Users/anyone/AppData/Local/Google/Chrome/User Data/Default/Cache".to_string(),
        "C:/Users/anyone/AppData/Local/Google/Chrome/User Data/Default/Cache/Cache_Data/f_000001"
            .to_string(),
        "C:/Users/anyone/AppData/Local/Google/Chrome/User Data/GrShaderCache/x".to_string(),
        "C:/Users/anyone/AppData/Local/Microsoft/Edge/User Data/Default/Cache/x".to_string(),
        "C:/Users/anyone/AppData/Local/Quark/User Data/Default/Cache/Cache_Data/f_000001"
            .to_string(),
        "C:/Users/anyone/AppData/Local/Quark/User Data/GrShaderCache/x".to_string(),
        "C:/Users/anyone/AppData/Local/CEF/User Data/Default/Cache/x".to_string(),
        "C:/Users/anyone/AppData/Local/Tabbit Browser/User Data/Default/Cache/x".to_string(),
        // ---- Brave 兄弟目录：更新器（无 /User Data/ 段）----
        "C:/Users/anyone/AppData/Local/BraveSoftware/Update/brave_installer.exe".to_string(),
        // ---- 安装目录（无 User Data 段）----
        "C:/Users/anyone/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe"
            .to_string(),
        // ---- directory 粒度契约：桶内文件不被 glob 单独命中（回收以桶目录展开）----
        format!("{ud}/Default/Cache/Cache_Data/f_000001"),
        format!("{ud}/Default/Code Cache/js/x"),
        format!("{ud}/Default/Service Worker/ScriptCache/x"),
        format!("{ud}/GrShaderCache/x"),
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
        "brave.toml glob hit red lines:\n  {}",
        violations.join("\n  ")
    );
}

/// detect 行为回归（不固定 env：只依赖 env 无关的 `**/BraveSoftware/...` 通配，
/// 结论在任何宿主环境下确定）：
/// - `**/BraveSoftware/Brave-Browser/User Data` 命中重定位数据根（改盘 / 便携版）。
/// - `**/BraveSoftware/Brave-Browser-Nightly/User Data`（channel 后缀）必须能编译并命中。
/// - 其它 Chromium 应用的 User Data 根、BraveSoftware/Update 兄弟目录、安装目录
///   一律不命中。
///
/// 本机未装 Brave（2026-09-28 实测 %LOCALAPPDATA%/BraveSoftware 不存在），detect
/// 的 env 路径在该机器上自然 0 命中，UI 卡片由 ** 通配或真实安装路径点亮。
#[test]
fn brave_detect_anchors_data_roots_not_installs_or_other_chromium_apps() {
    let scaffolds = vec![load_brave()];
    let tmp = std::env::temp_dir().join(format!(
        "pinkbin-brave-detect-test-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));

    // Positive：默认布局（%LOCALAPPDATA% 形态，由 ** 通配兜底命中）。
    let pos_default = tmp.join("AppData/Local/BraveSoftware/Brave-Browser/User Data");
    std::fs::create_dir_all(&pos_default).unwrap();

    // Positive：Nightly channel（channel 后缀通配）。
    let pos_nightly = tmp.join("AppData/Local/BraveSoftware/Brave-Browser-Nightly/User Data");
    std::fs::create_dir_all(&pos_nightly).unwrap();

    // Positive：重定位（改盘符 + 中间多级目录）。
    let pos_relocated = tmp.join("Disk2/Portable/BraveSoftware/Brave-Browser/User Data");
    std::fs::create_dir_all(&pos_relocated).unwrap();

    // Negative：其它 Chromium 应用的同名 User Data 根（2026-09-28 实测存在）。
    let neg_chrome = tmp.join("AppData/Local/Google/Chrome/User Data");
    std::fs::create_dir_all(&neg_chrome).unwrap();
    let neg_quark = tmp.join("AppData/Local/Quark/User Data");
    std::fs::create_dir_all(&neg_quark).unwrap();
    let neg_cef = tmp.join("AppData/Local/CEF/User Data");
    std::fs::create_dir_all(&neg_cef).unwrap();

    // Negative：BraveSoftware 兄弟目录（Update，无 /User Data/ 段）与安装目录。
    let neg_update = tmp.join("AppData/Local/BraveSoftware/Update");
    std::fs::create_dir_all(&neg_update).unwrap();
    let neg_install = tmp.join("Program Files/BraveSoftware/Brave-Browser/Application");
    std::fs::create_dir_all(&neg_install).unwrap();

    let assert_match = |path: &Path, expected: Option<&str>, label: &str| {
        let got = pinkbin_scaffold::detect_for(&scaffolds, path);
        assert_eq!(
            got.as_deref(),
            expected,
            "{label}: detect_for({path:?}) = {got:?}, expected {expected:?}",
        );
    };

    assert_match(&pos_default, Some("brave"), "** wildcard default root");
    assert_match(&pos_nightly, Some("brave"), "** wildcard Nightly root");
    assert_match(&pos_relocated, Some("brave"), "** wildcard relocated root");
    assert_match(&neg_chrome, None, "Chrome User Data must not match");
    assert_match(&neg_quark, None, "Quark User Data must not match");
    assert_match(&neg_cef, None, "CEF User Data must not match");
    assert_match(&neg_update, None, "BraveSoftware Update dir must not match");
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
    assert_compiled(&pos_default, Some("brave"), "default root");
    assert_compiled(&pos_nightly, Some("brave"), "Nightly root");
    assert_compiled(&pos_relocated, Some("brave"), "relocated root");
    assert_compiled(&neg_chrome, None, "Chrome root");
    assert_compiled(&neg_update, None, "BraveSoftware Update dir");
    assert_compiled(&neg_install, None, "install dir");

    // Cleanup — best-effort, ignore errors.
    let _ = std::fs::remove_dir_all(&tmp);
}
