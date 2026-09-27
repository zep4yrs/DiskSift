//! Regression test for `scaffolds/cursor.toml`: every scope glob must match the
//! bucket paths it targets (directory-form globs match the bucket dirs
//! themselves, file-form globs match plausible files inside), and **must not**
//! match Cursor red lines: `state.vscdb` / `.backup` / `-wal` / `-shm` /
//! `storage.json`（AI 聊天历史主库与全局状态，删了对话永久 infinite loading）、
//! globalStorage 扩展目录（anysphere.* / cursor.cursor-*，登录态与对话指针）、
//! User 配置与工作区数据（settings / keybindings / snippets / workspaceStorage /
//! History）、`~/.cursor/extensions/`（扩展本体）、Electron 壳层用户状态
//! （Network / Local Storage / Session Storage / Preferences / Local State /
//! machineid），以及 CLAUDE.md 通用红线片段（*.db / db_storage / Msg / Accounts /
//! login / config / Favorite / key / crypto）。
//!
//! Directory granularity: shell caches etc. target the bucket dir itself
//! (one Recycle Bin entry per bucket, rebuilt on next launch); days-prompt
//! scopes stay file-form so per-file mtime filtering is meaningful. Runtime
//! `find_matching_dirs` drops `path == root` (apps/desktop/src-tauri/src/lib.rs),
//! so a misconfigured glob can't recycle the data root. This test covers the
//! glob layer only.
//!
//! Cursor 本机未安装（勘测 2026-09-27，见 cursor.toml 头注释）——断言路径按
//! 调研文档 §2.2 布局构造；壳层桶名另经同壳 VS Code（%APPDATA%/Code）本机
//! 勘测交叉印证。glob 语义由 globset 本身保证，测试跑在同一 globset 上。

use std::path::PathBuf;

fn workspace_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop(); // out of crates/scaffold
    p.pop(); // out of crates
    p
}

fn load_cursor() -> pinkbin_scaffold::Scaffold {
    let path = workspace_root().join("scaffolds/cursor.toml");
    let text = std::fs::read_to_string(&path).expect("read cursor.toml");
    toml::from_str(&text).expect("parse cursor.toml")
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

/// Mirror `scaffold::expand_env` for `%VAR%`-style substitution.
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
fn cursor_globs_are_safe() {
    // 固定 env 让测试在所有平台上路径一致（本 scaffold 的 glob 不含 env 占位，
    // 但 expand() 走 scaffold::expand_env 同一套逻辑，env 固定保证可复现）。
    std::env::set_var("USERPROFILE", "C:/Users/test");
    std::env::set_var("APPDATA", "C:/Users/test/AppData/Roaming");
    std::env::set_var("LOCALAPPDATA", "C:/Users/test/AppData/Local");
    std::env::set_var("HOME", "/home/test");

    let scaffold = load_cursor();
    let scopes: Vec<(String, globset::GlobSet)> = scaffold
        .scopes
        .iter()
        .map(|s| (s.id.clone(), build_set(&expand(&s.glob))))
        .collect();

    // ========================================================================
    // 正向：每个 scope 至少一条命中路径
    // （directory-granularity scope 命中的是桶目录本身；file-form 命中桶内文件）
    // ========================================================================
    let positives: &[(&str, &str)] = &[
        // shell-cache — config root 与 %LOCALAPPDATA% 镜像下的整桶目录；
        // DawnWebGPUCache 来自同壳 VS Code 本机勘测（见 cursor.toml 头注释）
        ("shell-cache", "C:/Users/test/AppData/Roaming/Cursor/Cache"),
        ("shell-cache", "C:/Users/test/AppData/Roaming/Cursor/Code Cache"),
        ("shell-cache", "C:/Users/test/AppData/Roaming/Cursor/GPUCache"),
        (
            "shell-cache",
            "C:/Users/test/AppData/Roaming/Cursor/DawnWebGPUCache",
        ),
        ("shell-cache", "C:/Users/test/AppData/Local/Cursor/Cache"),
        (
            "shell-cache",
            "/home/test/Library/Application Support/Cursor/Cache",
        ),
        // cached-data — 按版本哈希分目录的 V8 字节码（file 粒度，桶内文件）
        (
            "cached-data",
            "C:/Users/test/AppData/Roaming/Cursor/CachedData/31c8bcd6f8e6c9a1b2c3d4e5f60718293a4b5c6d/v8-compile-cache.bin",
        ),
        // cached-extensions — 桶内文件（per-file mtime 过滤）
        (
            "cached-extensions",
            "C:/Users/test/AppData/Roaming/Cursor/CachedExtensionVSIXs/ms-python-2024.1.5.vsix",
        ),
        (
            "cached-extensions",
            "C:/Users/test/AppData/Roaming/Cursor/CachedProfilesData/default-profile/cache.json",
        ),
        (
            "cached-extensions",
            "C:/Users/test/AppData/Roaming/Cursor/CachedConfigurations/20260926T101500/config.json",
        ),
        // service-worker — 整桶目录
        (
            "service-worker",
            "C:/Users/test/AppData/Roaming/Cursor/Service Worker",
        ),
        (
            "service-worker",
            "C:/Users/test/AppData/Local/Cursor/Service Worker",
        ),
        // electron-extras — blob 分区与崩溃 dump
        (
            "electron-extras",
            "C:/Users/test/AppData/Roaming/Cursor/blob_storage",
        ),
        (
            "electron-extras",
            "C:/Users/test/AppData/Local/Cursor/Crashpad",
        ),
        (
            "electron-extras",
            "/home/test/Library/Application Support/Cursor/Crashpad",
        ),
        // logs — 日期分区 + exthost（AI IDE 日志大头），镜像根同样命中
        (
            "logs",
            "C:/Users/test/AppData/Roaming/Cursor/logs/20260926T101500/exthost 2/window3.log",
        ),
        ("logs", "C:/Users/test/AppData/Roaming/Cursor/logs/main.log"),
        ("logs", "C:/Users/test/AppData/Local/Cursor/logs/main.log"),
        // corrupted-state — Cursor 自行丢弃的损坏库残片（含编号后缀变体）
        (
            "corrupted-state",
            "C:/Users/test/AppData/Roaming/Cursor/User/globalStorage/state.vscdb.corrupted",
        ),
        (
            "corrupted-state",
            "C:/Users/test/AppData/Roaming/Cursor/User/globalStorage/state.vscdb.corrupted.3",
        ),
        (
            "corrupted-state",
            "/home/test/Library/Application Support/Cursor/User/globalStorage/state.vscdb.corrupted",
        ),
    ];

    for (expected_id, p) in positives {
        let hits = matching_scopes(&scopes, p);
        assert!(
            hits.contains(expected_id),
            "expected scope `{expected_id}` to match `{p}`, got {hits:?}",
        );
    }

    // ========================================================================
    // 红线：必须 zero match
    //   - globalStorage 正库与 sidecar（corrupted-state 的 glob 只认 .corrupted 后缀）
    //   - globalStorage 扩展目录（登录态、对话指针）
    //   - User 配置与工作区数据（settings / keybindings / snippets /
    //     workspaceStorage / History）
    //   - ~/.cursor/extensions/（扩展本体，删除后必须重装）
    //   - Electron 壳层用户状态（本机同壳 VS Code 勘测确认存在的目录名）
    //   - CLAUDE.md 通用红线片段（*.db / db_storage / Msg / Accounts /
    //     login / config / Favorite / key / crypto）
    // ========================================================================
    let red_lines: &[&str] = &[
        // —— Cursor 特有：globalStorage 正库 / sidecar（-wal / -shm 是活库的
        //    SQLite sidecar，.backup 是 Cursor 的恢复源）
        "C:/Users/test/AppData/Roaming/Cursor/User/globalStorage/state.vscdb",
        "C:/Users/test/AppData/Local/Cursor/User/globalStorage/state.vscdb",
        "C:/Users/test/AppData/Roaming/Cursor/User/globalStorage/state.vscdb-wal",
        "C:/Users/test/AppData/Roaming/Cursor/User/globalStorage/state.vscdb-shm",
        "C:/Users/test/AppData/Roaming/Cursor/User/globalStorage/state.vscdb.backup",
        "C:/Users/test/AppData/Roaming/Cursor/User/globalStorage/storage.json",
        // —— globalStorage 扩展目录（AI 历史指针与登录态）
        "C:/Users/test/AppData/Roaming/Cursor/User/globalStorage/cursor.cursor-reasoning/models.json",
        "C:/Users/test/AppData/Roaming/Cursor/User/globalStorage/anysphere.cursor-retrieval/embeddings.bin",
        // —— User 配置（L3）
        "C:/Users/test/AppData/Roaming/Cursor/User/settings.json",
        "C:/Users/test/AppData/Roaming/Cursor/User/keybindings.json",
        "C:/Users/test/AppData/Roaming/Cursor/User/snippets/python.json",
        // —— 工作区数据与编辑历史（per-workspace state.vscdb 删了 sidebar 失忆）
        "C:/Users/test/AppData/Roaming/Cursor/User/workspaceStorage/1726051200000/workspace.json",
        "C:/Users/test/AppData/Roaming/Cursor/User/workspaceStorage/1726051200000/state.vscdb",
        "C:/Users/test/AppData/Roaming/Cursor/User/History/9a8b7c6d/entries.json",
        // —— ~/.cursor/ 扩展本体
        "C:/Users/test/.cursor/extensions/ms-python.python-2024.2.1-universal/package.json",
        "C:/Users/test/.cursor/extensions/ms-toolsai.jupyter-2024.1.0/out/extension.js",
        // —— Electron 壳层用户状态（桶名经同壳 VS Code 本机勘测确认）
        "C:/Users/test/AppData/Roaming/Cursor/Network/Cookies",
        "C:/Users/test/AppData/Roaming/Cursor/Local Storage/leveldb/000003.log",
        "C:/Users/test/AppData/Roaming/Cursor/Session Storage/000003.log",
        "C:/Users/test/AppData/Roaming/Cursor/Preferences",
        "C:/Users/test/AppData/Roaming/Cursor/Local State",
        "C:/Users/test/AppData/Roaming/Cursor/machineid",
        "C:/Users/test/AppData/Roaming/Cursor/argv.json",
        "C:/Users/test/AppData/Roaming/Cursor/DIPS",
        // —— CLAUDE.md 通用红线片段
        "C:/Users/test/AppData/Roaming/Cursor/User/db_storage/session.db",
        "C:/Users/test/AppData/Roaming/Cursor/User/db_storage/MMSGROUP00.db-wal",
        "C:/Users/test/AppData/Roaming/Cursor/User/Msg/Multi/1.db",
        "C:/Users/test/AppData/Roaming/Cursor/User/MultiMsg/0.db",
        "C:/Users/test/AppData/Roaming/Cursor/User/Accounts/accessToken.json",
        "C:/Users/test/AppData/Roaming/Cursor/User/All Users/profile.json",
        "C:/Users/test/AppData/Roaming/Cursor/User/login/state.json",
        "C:/Users/test/AppData/Roaming/Cursor/config/app.cfg",
        "C:/Users/test/AppData/Roaming/Cursor/User/config/settings.cfg",
        "C:/Users/test/AppData/Roaming/Cursor/User/Favorite/list.json",
        "C:/Users/test/AppData/Roaming/Cursor/User/Fav/list.json",
        "C:/Users/test/AppData/Roaming/Cursor/User/keys/auth.key",
        "C:/Users/test/AppData/Roaming/Cursor/User/key/secret.key",
        "C:/Users/test/AppData/Roaming/Cursor/User/globalStorage/crypto-material/keyring.bin",
        // —— macOS 布局下正库同样不可碰
        "/home/test/Library/Application Support/Cursor/User/globalStorage/state.vscdb",
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
        "cursor.toml glob hit red lines:\n  {}",
        violations.join("\n  ")
    );
}
