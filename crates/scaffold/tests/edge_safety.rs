//! Regression test for `scaffolds/edge.toml`: every scope glob must match the
//! paths it advertises, and **must not** match Edge red lines（收藏夹 / 历史 /
//! 密码 / 自动填充 / Cookies / 网站数据 / 扩展状态 / 隐私沙箱与加密物料）。
//!
//! 桶名依据：2026-09-28 本机勘测。本机 Edge 已被彻底移除（%LOCALAPPDATA%/Microsoft
//! 下无 Edge 条目、`ls -d Microsoft/Edge*` 无命中、Program Files 无安装目录），
//! 用同机真实 Chromium 树 %LOCALAPPDATA%/Quark/User Data + %LOCALAPPDATA%/CEF/User Data
//! 只列目录名验证 Chromium 通用桶（Edge 与 Chrome 同属 Chromium 上游，桶名一致）：
//! Cache/Cache_Data、Code Cache、GPUCache、DawnGraphiteCache、DawnWebGPUCache、
//! Service Worker/{Database,ScriptCache}、blob_storage、GrShaderCache、
//! GraphiteDawnCache、ShaderCache、Crashpad、component_crx_cache、
//! extensions_crx_cache。红线同批勘测确认存在。
//! 红线断言失败 = scaffold glob 写宽了——回去收紧 glob，不要放宽测试。
//!
//! 另外断言 detect 行为：`**/Microsoft/Edge/User Data` 通配兜底命中重定位数据根；
//! Chrome / Quark / CEF 的树与安装目录必须不命中（scope 锚定 Microsoft/Edge*
//! 且要求 /User Data/ 段，Microsoft/EdgeUpdate 等兄弟目录同样不命中）。

use std::path::{Path, PathBuf};

fn workspace_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop(); // out of crates/scaffold
    p.pop(); // out of crates
    p
}

fn load_edge() -> pinkbin_scaffold::Scaffold {
    let path = workspace_root().join("scaffolds/edge.toml");
    let text = std::fs::read_to_string(&path).expect("read edge.toml");
    toml::from_str(&text).expect("parse edge.toml")
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
fn edge_globs_are_safe() {
    // 固定 env 让测试在所有平台上路径一致（scope glob 当前不含 %VAR%，保持与
    // 模板同款配置，日后若加 env 路径仍可复现）。
    std::env::set_var("USERPROFILE", "C:/Users/test");
    std::env::set_var("APPDATA", "C:/Users/test/AppData/Roaming");
    std::env::set_var("LOCALAPPDATA", "C:/Users/test/AppData/Local");
    std::env::set_var("HOME", "/home/test");

    let scaffold = load_edge();
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
    let ud = "C:/Users/test/AppData/Local/Microsoft/Edge/User Data";
    let positives: Vec<(&str, String)> = vec![
        // http-cache：directory 粒度；Default + Profile N 多 profile + channel 通配
        // （Edge* 覆盖 Edge / Edge Beta / Edge Dev / Edge SxS / Edge Core）+ ** 重定位兜底。
        ("http-cache", format!("{ud}/Default/Cache")),
        ("http-cache", format!("{ud}/Profile 1/Cache")),
        ("http-cache", format!("{ud}/Profile 2/Cache")),
        (
            "http-cache",
            "C:/Users/test/AppData/Local/Microsoft/Edge Beta/User Data/Default/Cache".to_string(),
        ),
        (
            "http-cache",
            "C:/Users/test/AppData/Local/Microsoft/Edge SxS/User Data/Default/Cache".to_string(),
        ),
        (
            "http-cache",
            "D:/relocated/Browsers/Microsoft/Edge/User Data/Default/Cache".to_string(),
        ),
        // macOS 布局不设正向断言：Edge 的 macOS 根是 `Microsoft Edge`（空格、单段），
        // 与 scope 锚 `Microsoft/Edge*`（两段）结构性不匹配——与 vscode.toml 同款取舍
        // （scope Windows 锚定；detect 列 macOS/Linux 路径仅供 UI 显示，见 edge.toml 注）。
        // js-bytecode-cache：Code Cache 整桶（桶名含空格，brace 分支同
        // vscode.toml {Code,Code - Insiders} 先例）。
        ("js-bytecode-cache", format!("{ud}/Default/Code Cache")),
        ("js-bytecode-cache", format!("{ud}/Profile 1/Code Cache")),
        // gpu-shader-cache：DawnGraphiteCache / DawnWebGPUCache 为 2026-09-28 实测名。
        ("gpu-shader-cache", format!("{ud}/Default/GPUCache")),
        (
            "gpu-shader-cache",
            format!("{ud}/Default/DawnGraphiteCache"),
        ),
        ("gpu-shader-cache", format!("{ud}/Default/DawnWebGPUCache")),
        ("gpu-shader-cache", format!("{ud}/Profile 1/GPUCache")),
        // service-worker-cache：整桶；桶内 Database/ + ScriptCache/ 为 2026-09-28 实测名。
        (
            "service-worker-cache",
            format!("{ud}/Default/Service Worker"),
        ),
        (
            "service-worker-cache",
            format!("{ud}/Profile 1/Service Worker"),
        ),
        // blob-storage：整桶。
        ("blob-storage", format!("{ud}/Default/blob_storage")),
        ("blob-storage", format!("{ud}/Profile 2/blob_storage")),
        // shader-cache：User Data 顶层三个着色器缓存桶（2026-09-28 实测名，
        // 老 Chromium 只有 ShaderCache 一个，三者并存于 alternation）。
        ("shader-cache", format!("{ud}/GrShaderCache")),
        ("shader-cache", format!("{ud}/GraphiteDawnCache")),
        ("shader-cache", format!("{ud}/ShaderCache")),
        // component-crx-cache：file 粒度 + days 30，路径是桶内文件（fixture 名）。
        (
            "component-crx-cache",
            format!("{ud}/component_crx_cache/0a1b2c3d.crx"),
        ),
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
    // 中段：Edge 特有红线，其中带"实测"标记的是 2026-09-28 在本机 Quark
    //       （Chromium 同源布局）User Data 下列目录名确认存在的；Edge 专属的
    //       Collections（集锦）与 EdgeUpdate 一并断言。
    // 后段：其它 Chromium 应用的树（Chrome / Quark / CEF / Edge 的兄弟 channel
    //       目录 EdgeUpdate）——scope 锚定 Microsoft/Edge* 且要求 /User Data/ 段，
    //       不得外溢；以及 directory 粒度契约（桶内文件不被 glob 单独命中）。
    // ========================================================================
    let red_lines: Vec<String> = vec![
        // ---- 通用红线（CLAUDE.md），置于 Edge 树内 ----
        // *.db / 聊天 DB 形态（防日后 glob 放宽误伤）
        format!("{ud}/Default/heavy_ad_intervention_opt_out.db"), // 实测
        format!("{ud}/Default/db_storage/MMKV/data.db"),
        format!("{ud}/Default/Msg/MultiMsg/msg.db"),
        // Accounts / login / config
        format!("{ud}/Accounts/session.dat"),
        format!("{ud}/login/auth.dat"),
        format!("{ud}/config/account.cfg"),
        // Favorite / Fav（收藏夹即收藏）
        format!("{ud}/Favorite/fav.dat"),
        format!("{ud}/Fav/list.json"),
        // key / crypto（加密物料）
        format!("{ud}/key/material.key"),
        format!("{ud}/crypto/store.bin"),
        // All Users
        format!("{ud}/All Users/x"),
        // ---- Edge 特有红线：User Data 顶层状态 ----
        format!("{ud}/Local State"),                     // 实测
        format!("{ud}/First Run"),                       // 实测
        format!("{ud}/Last Browser"),                    // 实测
        format!("{ud}/Last Version"),                    // 实测
        format!("{ud}/BrowserMetrics-spare.pma"),        // 实测
        format!("{ud}/Safe Browsing/Cert Chains.bin"),   // 实测（Safe Browsing）
        format!("{ud}/WidevineCdm/1.0.0/manifest.json"), // 实测（WidevineCdm）
        format!("{ud}/Variations/seed.json"),            // 实测（Variations）
        // ---- Edge 特有红线：profile 用户数据 ----
        format!("{ud}/Default/Bookmarks"),                 // 实测
        format!("{ud}/Default/Bookmarks.bak"),             // 实测
        format!("{ud}/Default/History"),                   // 实测
        format!("{ud}/Default/History-journal"),           // 实测
        format!("{ud}/Default/Login Data"),                // 实测
        format!("{ud}/Default/Login Data-journal"),        // 实测
        format!("{ud}/Default/Login Data For Account"),    // 实测
        format!("{ud}/Default/Web Data"),                  // 实测
        format!("{ud}/Default/Web Data-journal"),          // 实测
        format!("{ud}/Default/Favicons"),                  // 实测
        format!("{ud}/Default/Favicons-journal"),          // 实测
        format!("{ud}/Default/Preferences"),               // 实测
        format!("{ud}/Default/Secure Preferences"),        // 实测
        format!("{ud}/Default/Shortcuts"),                 // 实测
        format!("{ud}/Default/Top Sites"),                 // 实测
        format!("{ud}/Default/Sessions/1a2b3c"),           // 实测（Sessions）
        format!("{ud}/Default/Sync Data/SyncData.sqlite"), // 实测（Sync Data）
        format!("{ud}/Default/Account Web Data/x"),        // 实测
        format!("{ud}/Default/Affiliation Database/x"),    // 实测
        // Edge 专属：集锦（用户数据，scaffold 无法验证落盘名 → 整树不碰，此处断言常见形态）
        format!("{ud}/Default/Collections/collections.sqlite"),
        // ---- Edge 特有红线：登录态 / 网站数据 ----
        format!("{ud}/Default/Network/Cookies"), // 实测（Network）
        format!("{ud}/Default/Local Storage/leveldb/000003.log"), // 实测
        format!("{ud}/Default/Session Storage/000003.log"), // 实测
        format!("{ud}/Default/IndexedDB/https_example/x"), // 实测
        format!("{ud}/Default/WebStorage/x"),    // 实测
        // ---- Edge 特有红线：扩展状态（扩展登录 token 所在）----
        format!("{ud}/Default/Extension State/x"), // 实测
        format!("{ud}/Default/Local Extension Settings/x"), // 实测
        format!("{ud}/Default/Extension Rules/x"), // 实测
        format!("{ud}/Default/Extension Scripts/x"), // 实测
        format!("{ud}/Default/GCM Store/x"),       // 实测
        // ---- Edge 特有红线：隐私沙箱 / 拿不准 → 红线 ----
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
        // ---- Edge 特有红线：证书 / 加密物料 ----
        format!("{ud}/Default/ClientCertificates/x"), // 实测
        format!("{ud}/Default/MediaDeviceSalts"),     // 实测
        format!("{ud}/Default/MediaDeviceSalts-journal"), // 实测
        format!("{ud}/Default/passkey_enclave_state/x"), // 实测
        format!("{ud}/Default/trusted_vault.pb"),     // 实测
        // ---- Edge 特有红线：Profile 1 同款抽查 ----
        format!("{ud}/Profile 1/Bookmarks"),
        format!("{ud}/Profile 1/History"),
        format!("{ud}/Profile 1/Login Data"),
        format!("{ud}/Profile 1/Network/Cookies"),
        format!("{ud}/Profile 1/Preferences"),
        // ---- 其它 Chromium 应用的树（2026-09-28 本机实测存在同名根）----
        "C:/Users/anyone/AppData/Local/Google/Chrome/User Data/Default/Cache".to_string(),
        "C:/Users/anyone/AppData/Local/Google/Chrome/User Data/Default/Cache/Cache_Data/f_000001"
            .to_string(),
        "C:/Users/anyone/AppData/Local/Google/Chrome/User Data/GrShaderCache/x".to_string(),
        "C:/Users/anyone/AppData/Local/Quark/User Data/Default/Cache/Cache_Data/f_000001"
            .to_string(),
        "C:/Users/anyone/AppData/Local/Quark/User Data/Default/Code Cache/x".to_string(),
        "C:/Users/anyone/AppData/Local/Quark/User Data/GrShaderCache/x".to_string(),
        "C:/Users/anyone/AppData/Local/CEF/User Data/Default/Cache/x".to_string(),
        "C:/Users/anyone/AppData/Local/Tabbit Browser/User Data/Default/Cache/x".to_string(),
        // ---- Edge 兄弟目录：更新器（无 /User Data/ 段，不得被 Edge* 前缀外溢命中）----
        "C:/Users/anyone/AppData/Local/Microsoft/EdgeUpdate/Download/edge_installer.exe"
            .to_string(),
        "C:/Users/anyone/AppData/Local/Microsoft/EdgeCore/x".to_string(),
        // ---- 安装目录（无 User Data 段）----
        "C:/Users/anyone/Program Files (x86)/Microsoft/Edge/Application/msedge.dll".to_string(),
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
        "edge.toml glob hit red lines:\n  {}",
        violations.join("\n  ")
    );
}

/// detect 行为回归（不固定 env：只依赖 env 无关的 `**/Microsoft/...` 通配，
/// 结论在任何宿主环境下确定）：
/// - `**/Microsoft/Edge/User Data` 命中重定位数据根（改盘 / 便携版）。
/// - `**/Microsoft/Edge SxS/User Data`（带空格的通配段）必须能编译并命中。
/// - Chrome / Quark / CEF 的 User Data 根、安装目录（Application/）、
///   Microsoft/EdgeUpdate 兄弟目录一律不命中。
///
/// 本机 Edge 已被移除（2026-09-28 实测），detect 的 env 路径在该机器上自然
/// 0 命中，UI 卡片由 ** 通配或真实安装路径点亮。
#[test]
fn edge_detect_anchors_data_roots_not_installs_or_other_chromium_apps() {
    let scaffolds = vec![load_edge()];
    let tmp = std::env::temp_dir().join(format!(
        "pinkbin-edge-detect-test-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));

    // Positive：默认布局（%LOCALAPPDATA% 形态，由 ** 通配兜底命中）。
    let pos_default = tmp.join("AppData/Local/Microsoft/Edge/User Data");
    std::fs::create_dir_all(&pos_default).unwrap();

    // Positive：Canary channel（带空格通配段）。
    let pos_canary = tmp.join("AppData/Local/Microsoft/Edge SxS/User Data");
    std::fs::create_dir_all(&pos_canary).unwrap();

    // Positive：重定位（改盘符 + 中间多级目录）。
    let pos_relocated = tmp.join("Disk2/Portable/Microsoft/Edge/User Data");
    std::fs::create_dir_all(&pos_relocated).unwrap();

    // Negative：其它 Chromium 应用的 User Data 根（2026-09-28 实测存在 / Chrome 常见布局）。
    let neg_chrome = tmp.join("AppData/Local/Google/Chrome/User Data");
    std::fs::create_dir_all(&neg_chrome).unwrap();
    let neg_quark = tmp.join("AppData/Local/Quark/User Data");
    std::fs::create_dir_all(&neg_quark).unwrap();
    let neg_cef = tmp.join("AppData/Local/CEF/User Data");
    std::fs::create_dir_all(&neg_cef).unwrap();

    // Negative：Edge 兄弟目录（EdgeUpdate，无 /User Data/ 段）与安装目录。
    let neg_update = tmp.join("AppData/Local/Microsoft/EdgeUpdate");
    std::fs::create_dir_all(&neg_update).unwrap();
    let neg_install = tmp.join("Program Files (x86)/Microsoft/Edge/Application");
    std::fs::create_dir_all(&neg_install).unwrap();

    let assert_match = |path: &Path, expected: Option<&str>, label: &str| {
        let got = pinkbin_scaffold::detect_for(&scaffolds, path);
        assert_eq!(
            got.as_deref(),
            expected,
            "{label}: detect_for({path:?}) = {got:?}, expected {expected:?}",
        );
    };

    assert_match(&pos_default, Some("edge"), "** wildcard default root");
    assert_match(&pos_canary, Some("edge"), "** wildcard Edge SxS root");
    assert_match(&pos_relocated, Some("edge"), "** wildcard relocated root");
    assert_match(&neg_chrome, None, "Chrome User Data must not match");
    assert_match(&neg_quark, None, "Quark User Data must not match");
    assert_match(&neg_cef, None, "CEF User Data must not match");
    assert_match(&neg_update, None, "EdgeUpdate dir must not match");
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
    assert_compiled(&pos_default, Some("edge"), "default root");
    assert_compiled(&pos_canary, Some("edge"), "Edge SxS root");
    assert_compiled(&pos_relocated, Some("edge"), "relocated root");
    assert_compiled(&neg_chrome, None, "Chrome root");
    assert_compiled(&neg_install, None, "install dir");

    // Cleanup — best-effort, ignore errors.
    let _ = std::fs::remove_dir_all(&tmp);
}
