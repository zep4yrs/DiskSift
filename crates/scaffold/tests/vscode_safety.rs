//! Regression test for `scaffolds/vscode.toml`: every scope glob must match the
//! paths it advertises, and **must not** match VS Code red lines (User/ 用户数据、
//! globalStorage state DBs、~/.vscode 扩展本体、登录/网络状态)。
//!
//! 这是 docs/research/python-dev-cleanup-landscape.md §2.2（vscode 系红线节）+
//! 2026-09-27 本机勘测结果（DIPS / clp / Shared Dictionary / machineid /
//! Network / Backups 等实测存在的目录全部划红线）的可执行形式。
//! 红线断言失败 = scaffold glob 写宽了——回去收紧 glob，不要放宽测试。
//!
//! 另外断言 detect / [match] 行为：`**/Code - Insiders`（带空格的 glob
//! alternation）能编译命中；basename 含 "code" 但不是真数据根的目录靠
//! must_have_child = ["User", "logs"] 拦截。

use std::path::{Path, PathBuf};

fn workspace_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop(); // out of crates/scaffold
    p.pop(); // out of crates
    p
}

fn load_vscode() -> pinkbin_scaffold::Scaffold {
    let path = workspace_root().join("scaffolds/vscode.toml");
    let text = std::fs::read_to_string(&path).expect("read vscode.toml");
    toml::from_str(&text).expect("parse vscode.toml")
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
fn vscode_globs_are_safe() {
    // 固定 env 让测试在所有平台上路径一致（scope glob 当前不含 %VAR%，保持与
    // 模板同款配置，日后若加 env 路径仍可复现）。
    std::env::set_var("USERPROFILE", "C:/Users/test");
    std::env::set_var("APPDATA", "C:/Users/test/AppData/Roaming");
    std::env::set_var("LOCALAPPDATA", "C:/Users/test/AppData/Local");
    std::env::set_var("HOME", "/home/test");

    let scaffold = load_vscode();
    let scopes: Vec<(String, globset::GlobSet)> = scaffold
        .scopes
        .iter()
        .map(|s| (s.id.clone(), build_set(&expand(&s.glob))))
        .collect();

    // ========================================================================
    // 正向断言：每个 scope id 至少一条命中路径
    // ========================================================================
    let positives: &[(&str, &str)] = &[
        // shell-cache：directory 粒度，glob 无 /**，正向路径是桶目录本身。
        // DawnGraphiteCache / DawnWebGPUCache 为 2026-09-27 实测名；DawnCache
        // 是老版 Electron 的名字，三者在 alternation 里并存。
        ("shell-cache", "C:/Users/test/AppData/Roaming/Code/Cache"),
        ("shell-cache", "C:/Users/test/AppData/Roaming/Code/Code Cache"),
        ("shell-cache", "C:/Users/test/AppData/Roaming/Code/GPUCache"),
        ("shell-cache", "C:/Users/test/AppData/Roaming/Code/DawnGraphiteCache"),
        ("shell-cache", "C:/Users/test/AppData/Roaming/Code/DawnWebGPUCache"),
        ("shell-cache", "C:/Users/test/AppData/Roaming/Code - Insiders/GPUCache"),
        // ** 通配兜底：数据根被搬到非默认盘符时依然命中。
        ("shell-cache", "D:/relocated/Profile/Code/Cache"),
        // detect 显式列出的 %LOCALAPPDATA%/Code 镜像（2026-09-27 本机未落盘，
        // 但 `**/Code/<桶>` 形态天然覆盖它——用固定 env 路径断言该覆盖）。
        ("shell-cache", "C:/Users/test/AppData/Local/Code/Cache"),
        // cached-data：file 粒度 + days 30，子目录是 per-version commit hash。
        ("cached-data", "C:/Users/test/AppData/Roaming/Code/CachedData/8f2a1b3c/cachedData.bin"),
        ("cached-data", "C:/Users/test/AppData/Roaming/Code - Insiders/CachedData/9c3d2e1f/x.bin"),
        // cached-extensions：实测含 CachedConfigurations（调研文档没列）。
        ("cached-extensions", "C:/Users/test/AppData/Roaming/Code/CachedExtensionVSIXs/ms-python.vscode-pylance-2026.5.1.vsix"),
        ("cached-extensions", "C:/Users/test/AppData/Roaming/Code/CachedExtensions/extensions.json"),
        ("cached-extensions", "C:/Users/test/AppData/Roaming/Code/CachedProfilesData/default-profile/x.json"),
        ("cached-extensions", "C:/Users/test/AppData/Roaming/Code/CachedConfigurations/x.json"),
        // service-worker：directory 粒度整桶。
        ("service-worker", "C:/Users/test/AppData/Roaming/Code/Service Worker"),
        ("service-worker", "C:/Users/test/AppData/Roaming/Code - Insiders/Service Worker"),
        // electron-extras：blob_storage / Crashpad 整桶。
        ("electron-extras", "C:/Users/test/AppData/Roaming/Code/blob_storage"),
        ("electron-extras", "C:/Users/test/AppData/Roaming/Code/Crashpad"),
        ("electron-extras", "C:/Users/test/AppData/Roaming/Code - Insiders/Crashpad"),
        // logs：file 粒度，目录名是会话时间戳（2026-09-27 实测形态）。
        ("logs", "C:/Users/test/AppData/Roaming/Code/logs/20260905T153211/window1/renderer.log"),
        ("logs", "C:/Users/test/AppData/Roaming/Code - Insiders/logs/20260905T153211/main.log"),
    ];

    for (expected_id, p) in positives {
        let hits = matching_scopes(&scopes, p);
        assert!(
            hits.contains(expected_id),
            "expected scope `{expected_id}` to match `{p}`, but matched {hits:?}",
        );
    }

    // ========================================================================
    // 红线断言：以下路径必须不被任何 scope 命中
    // 前半：CLAUDE.md 通用红线片段（*.db / db_storage / Msg / Accounts / login /
    //       config / Favorite / key / crypto / All Users），放进本 glob 树
    //       （%APPDATA%/Code 内）才有意义——那是 scope 够得着的地方。
    // 后半：VS Code 特有红线，其中带"实测"标记的是 2026-09-27 在本机
    //       %APPDATA%/Code 下列目录名确认存在的。
    // ========================================================================
    let red_lines: &[&str] = &[
        // ---- 通用红线（CLAUDE.md），置于 vscode 树内 ----
        // *.db / 中央状态库（globalStorage 的 state.vscdb 是所有扩展登录态所在）
        "C:/Users/test/AppData/Roaming/Code/User/globalStorage/state.vscdb",
        "C:/Users/test/AppData/Roaming/Code/User/globalStorage/state.vscdb.backup",
        "C:/Users/test/AppData/Roaming/Code/User/workspaceStorage/2f1a9c/state.vscdb",
        "C:/Users/test/AppData/Roaming/Code/User/globalStorage/example-ext/db_storage/MMKV/data.db",
        // Msg / MultiMsg（IM 聊天 DB 形态，防止日后 glob 放宽误伤）
        "C:/Users/test/AppData/Roaming/Code/User/globalStorage/Msg/MultiMsg/msg.db",
        // Accounts / login
        "C:/Users/test/AppData/Roaming/Code/User/globalStorage/Accounts/session.dat",
        "C:/Users/test/AppData/Roaming/Code/User/globalStorage/login/auth.dat",
        // config
        "C:/Users/test/AppData/Roaming/Code/User/globalStorage/config/account.cfg",
        // Favorite / Fav
        "C:/Users/test/AppData/Roaming/Code/User/globalStorage/Favorite/fav.dat",
        "C:/Users/test/AppData/Roaming/Code/User/globalStorage/Fav/list.json",
        // key / crypto（加密物料）
        "C:/Users/test/AppData/Roaming/Code/User/globalStorage/key/material.key",
        "C:/Users/test/AppData/Roaming/Code/User/globalStorage/crypto/store.bin",
        // All Users
        "C:/Users/test/AppData/Roaming/Code/All Users/x",
        // ---- VS Code 特有红线：User/ 用户数据 ----
        "C:/Users/test/AppData/Roaming/Code/User/settings.json",
        "C:/Users/test/AppData/Roaming/Code/User/keybindings.json",
        "C:/Users/test/AppData/Roaming/Code/User/snippets/python.json",
        "C:/Users/test/AppData/Roaming/Code/User/chatLanguageModels.json", // 实测
        "C:/Users/test/AppData/Roaming/Code/User/History/1a2b3c/entries.json", // 实测（本地编辑历史）
        "C:/Users/test/AppData/Roaming/Code/User/workspaceStorage/2f1a9c/workspace.json", // 实测
        "C:/Users/test/AppData/Roaming/Code/User/profiles/0abc/settings.json",
        // ---- VS Code 特有红线：globalStorage 扩展数据 / AI 数据 ----
        "C:/Users/test/AppData/Roaming/Code/User/globalStorage/storage.json",
        "C:/Users/test/AppData/Roaming/Code/User/globalStorage/github.copilot/auth/token.json",
        "C:/Users/test/AppData/Roaming/Code/User/globalStorage/ms-python.vscode-pylance/index/data",
        // ---- VS Code 特有红线：~/.vscode（扩展本体 / CLI / argv）----
        "C:/Users/test/.vscode/extensions/ms-python.python-2026.5.1/package.json",
        "C:/Users/test/.vscode/argv.json",     // 实测
        "C:/Users/test/.vscode/cli/data.json", // 实测（拿不准 → 红线）
        // ---- VS Code 特有红线：漫游根下的登录态 / 设备标识 / 未知目录 ----
        "C:/Users/test/AppData/Roaming/Code/machineid", // 实测
        "C:/Users/test/AppData/Roaming/Code/languagepacks.json", // 实测
        "C:/Users/test/AppData/Roaming/Code/Backups/workspace-backups/x.json", // 实测（工作区备份）
        "C:/Users/test/AppData/Roaming/Code/Network/Cookies", // 实测（登录 cookie）
        "C:/Users/test/AppData/Roaming/Code/Local State", // 实测
        "C:/Users/test/AppData/Roaming/Code/Preferences", // 实测
        "C:/Users/test/AppData/Roaming/Code/Local Storage/leveldb/000003.log", // 实测
        "C:/Users/test/AppData/Roaming/Code/Session Storage/000003.log", // 实测
        "C:/Users/test/AppData/Roaming/Code/WebStorage/x", // 实测
        "C:/Users/test/AppData/Roaming/Code/SharedStorage/x", // 实测
        "C:/Users/test/AppData/Roaming/Code/SharedStorage-wal", // 实测
        "C:/Users/test/AppData/Roaming/Code/Shared Dictionary/x", // 实测（压缩字典缓存，拿不准 → 红线）
        "C:/Users/test/AppData/Roaming/Code/DIPS/x",              // 实测（拿不准 → 红线）
        "C:/Users/test/AppData/Roaming/Code/clp/x",               // 实测（拿不准 → 红线）
        "C:/Users/test/AppData/Roaming/Code/Dictionaries/en_US.dic", // 实测
        // ---- Insiders 同款红线抽查 ----
        "C:/Users/test/AppData/Roaming/Code - Insiders/User/settings.json",
        "C:/Users/test/AppData/Roaming/Code - Insiders/User/globalStorage/state.vscdb",
        "C:/Users/test/AppData/Roaming/Code - Insiders/machineid",
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
        "vscode.toml glob hit red lines:\n  {}",
        violations.join("\n  ")
    );
}

/// detect / [match] 行为回归：
/// - `**/Code - Insiders`（带空格的 alternation）必须能编译并命中——若 globset
///   拒绝带空格的 brace 段，这条会在 detect 静默跳过后失败。
/// - [match] 兜底：basename 含 "code" 但不以 Code 结尾的重定位根，必须同时有
///   User/ + logs/ 才算真数据根；只有 User/ 或两者皆无的一律拒绝。
///
/// 本测试不固定 env：它只依赖 env 无关的 `**/Code`、`**/Code - Insiders`
/// glob 和 [match]，结论在任何宿主环境（%APPDATA% 指向哪都一样）下确定。
#[test]
fn vscode_matcher_distinguishes_data_from_installs() {
    let scaffolds = vec![load_vscode()];
    let tmp = std::env::temp_dir().join(format!(
        "pinkbin-vscode-matcher-test-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));

    // Positive：** 通配兜底命中 Insiders 数据根（空目录即可，detect 无 children 要求）。
    let pos_insiders = tmp.join("AppData/Roaming/Code - Insiders");
    std::fs::create_dir_all(&pos_insiders).unwrap();

    // Positive：matcher 兜底——重定位后改名的数据根（含 "code" 但不以 Code 结尾），
    // User/ + logs/ 两个标记子目录都在。
    let pos_matcher = tmp.join("Roaming/Code - Portable");
    std::fs::create_dir_all(pos_matcher.join("User")).unwrap();
    std::fs::create_dir_all(pos_matcher.join("logs")).unwrap();

    // Negative：名字像 VS Code 数据根（含 "code"），有 User/ 但缺 logs/。
    let neg_partial = tmp.join("Documents/VSCodeBackup");
    std::fs::create_dir_all(neg_partial.join("User")).unwrap();

    // Negative：纯项目目录，两个标记子目录都没有。
    let neg_project = tmp.join("Documents/CodeSamples");
    std::fs::create_dir_all(neg_project.join("src")).unwrap();

    // Negative：安装目录（basename 不含 "code"）。
    let neg_install = tmp.join("Program Files/Microsoft VS Code/resources");
    std::fs::create_dir_all(&neg_install).unwrap();

    let assert_match = |path: &Path, expected: Option<&str>, label: &str| {
        let got = pinkbin_scaffold::detect_for(&scaffolds, path);
        assert_eq!(
            got.as_deref(),
            expected,
            "{label}: detect_for({path:?}) = {got:?}, expected {expected:?}",
        );
    };

    assert_match(
        &pos_insiders,
        Some("vscode"),
        "**/Code - Insiders wildcard (space-containing alternation)",
    );
    assert_match(&pos_matcher, Some("vscode"), "matcher fallback (User+logs)");
    assert_match(&neg_partial, None, "missing logs child must not match");
    assert_match(&neg_project, None, "project dir must not match");
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
    assert_compiled(&pos_insiders, Some("vscode"), "wildcard root");
    assert_compiled(&pos_matcher, Some("vscode"), "matcher root");
    assert_compiled(&neg_partial, None, "missing logs child");
    assert_compiled(&neg_install, None, "install dir");

    // Cleanup — best-effort, ignore errors.
    let _ = std::fs::remove_dir_all(&tmp);
}
