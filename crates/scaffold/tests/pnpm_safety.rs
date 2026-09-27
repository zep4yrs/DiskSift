//! Safety test for `scaffolds/pnpm.toml`: every scope glob must match the
//! store/cache **directories** it targets (all three scopes are
//! directory-granularity), and must not match pnpm red lines:
//!
//! - `index.db` / `index` / `projects` inside a store version dir — the CAS
//!   index and prune bookkeeping (and `*.db` is a hard red line per CLAUDE.md)
//! - `pnpm/global` (globally installed packages) and `pnpm/bin` (command
//!   shims) — deleting them removes the user's global CLIs
//! - `pnpm/config/rc` and `pnpm/state` — user config and state
//! - per-project `node_modules/.pnpm` virtual store and `pnpm-lock.yaml`
//! - anything outside pnpm's own cache/store naming (generic CLAUDE.md
//!   fragments: db_storage / Msg / Accounts / login / config / Favorite /
//!   key / crypto)
//!
//! The store scopes deliberately target only `store/v*/files` (the CAS data
//! itself); `index.db` sits directly inside `store/v11/`, so a glob that
//! matched the version dir — or a legacy `**/store/**` — would fail here.
//!
//! Real-machine survey (2026-09-27, Windows 11, directory names only):
//! `%LOCALAPPDATA%/pnpm/store/v11` = {files, index.db, projects} (store/ holds only v11);
//! `D:/.pnpm-store` = {v3: files, v10: files+index+projects, v11: files+index.db+projects};
//! `%LOCALAPPDATA%/pnpm-cache` = {v11/{metadata, metadata-full},
//! metadata-v1.3/registry.npmjs.org, metadata-full-v1.3/registry.npmjs.org,
//! lockfile-verified.jsonl};
//! `%LOCALAPPDATA%/pnpm-state` = {pnpm-state.json} (sibling of the pnpm home).
//!
//! 运行时可达不变量（2026-09-27 复核新增）：每个 scope 的正向断言路径必须是某个
//! detect 根的**严格后代**——运行时 scope 匹配总是以 detect 命中的目录为扫描根
//! （CleanupModal.tsx 把每个 m.path 传给 scopeSizes / executeScope），且
//! find_matching_dirs 无条件丢弃 path == root（apps/desktop/src-tauri/src/lib.rs
//! 的防整根误删保护）。根不可达（等于 detect 根自身、或不在任何 detect 根子树内）
//! 的正向断言视为无效。metadata-cache 曾用根形态 glob `**/{pnpm-cache,...}` 命中
//! detect 根自身 → 两条运行时路径都永远零命中（pnpm-cache 卡片根下无子路径匹配
//! 根形态；pnpm home 卡片根的子树里没有 pnpm-cache——它是兄弟目录），已改为尾部
//! /** 的"根内内容"形态。pnpm 的 detect 含 `**` 通配兜底，本不变量在此以注释
//! 标注；python-tmp 的 detect 全是字面量，tests/python_tmp_safety.rs 里做了
//! 机械断言。

use std::collections::HashSet;
use std::path::PathBuf;

const SCAFFOLD_FILE: &str = "scaffolds/pnpm.toml";

fn workspace_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop(); // out of crates/scaffold
    p.pop(); // out of crates
    p
}

fn load_scaffold() -> pinkbin_scaffold::Scaffold {
    let path = workspace_root().join(SCAFFOLD_FILE);
    let text = std::fs::read_to_string(&path).expect("read pnpm.toml");
    toml::from_str(&text).expect("parse pnpm.toml")
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
fn pnpm_globs_are_safe() {
    // 固定 env 让测试在所有平台上路径一致。
    std::env::set_var("USERPROFILE", "C:/Users/test");
    std::env::set_var("APPDATA", "C:/Users/test/AppData/Roaming");
    std::env::set_var("LOCALAPPDATA", "C:/Users/test/AppData/Local");
    std::env::set_var("HOME", "/home/test");

    let scaffold = load_scaffold();
    let scopes: Vec<(String, globset::GlobSet)> = scaffold
        .scopes
        .iter()
        .map(|s| (s.id.clone(), build_set(&expand(&s.glob))))
        .collect();

    // ========================================================================
    // 正向断言：每个 scope id 至少一条命中**目录**路径（directory granularity）
    // ========================================================================
    let positives: &[(&str, &str)] = &[
        // metadata-cache — pnpm cache 目录的**内容**（实测 Windows 形态
        // {v11/{metadata, metadata-full}, metadata-v1.3, metadata-full-v1.3} +
        // POSIX 同构）。glob 是尾部 /** 的内容形态：缓存根自身是扫描根且被
        // find_matching_dirs 丢弃（见文件头不变量），不能作为正向断言。
        (
            "metadata-cache",
            "C:/Users/test/AppData/Local/pnpm-cache/v11",
        ),
        (
            "metadata-cache",
            "C:/Users/test/AppData/Local/pnpm-cache/metadata-v1.3",
        ),
        (
            "metadata-cache",
            "/home/test/.cache/pnpm/metadata-full-v1.3",
        ),
        ("metadata-cache", "/home/test/Library/Caches/pnpm/v11"),
        // store-files — pnpm home 下的 CAS 数据本体（实测 %LOCALAPPDATA%/pnpm/store/v11/files）
        (
            "store-files",
            "C:/Users/test/AppData/Local/pnpm/store/v11/files",
        ),
        (
            "store-files",
            "C:/Users/test/AppData/Local/pnpm/store/v3/files",
        ),
        ("store-files", "/home/test/.local/share/pnpm/store/v3/files"),
        ("store-files", "/home/test/Library/pnpm/store/v11/files"),
        // store-files-legacy — per-drive 兜底（实测 D:/.pnpm-store/{v10,v3}/files）
        // 与 pnpm ≤6 POSIX legacy store
        ("store-files-legacy", "D:/.pnpm-store/v11/files"),
        ("store-files-legacy", "D:/.pnpm-store/v10/files"),
        ("store-files-legacy", "D:/.pnpm-store/v3/files"),
        ("store-files-legacy", "/home/test/.pnpm-store/v2/files"),
    ];

    for (expected_id, p) in positives {
        let hits = matching_scopes(&scopes, p);
        assert!(
            hits.contains(expected_id),
            "expected scope `{expected_id}` to match `{p}`, got {hits:?}",
        );
    }

    // 每个 [[scope]] 都必须被至少一条正向路径覆盖——防止加了 scope 忘了测。
    let covered: HashSet<&str> = positives.iter().map(|(id, _)| *id).collect();
    for s in &scaffold.scopes {
        assert!(
            covered.contains(s.id.as_str()),
            "scope `{}` has no positive path in the test",
            s.id,
        );
    }

    // ========================================================================
    // 红线断言：以下路径必须不被任何 scope 命中
    //   - store 的 index.db / index / projects（*.db 是 CLAUDE.md 硬红线；
    //     index/projects 是 prune 簿记，删了无收益）
    //   - pnpm home 根 / store 根 / 版本目录本身（directory granularity 下
    //     任何 scope 命中它们 = 整个 pnpm home 被搬进回收站）
    //   - pnpm 全局包 global/、命令 shim、config/rc、state
    //   - 项目内 node_modules/.pnpm 虚拟存储与 pnpm-lock.yaml
    //   - CLAUDE.md 通用红线片段：db_storage / Msg / Accounts / login /
    //     config / Favorite / key / crypto
    // ========================================================================
    let red_lines: &[&str] = &[
        // --- pnpm cache 三平台根自身：glob 是尾部 /** 的内容形态，根零命中；
        //     运行时它们就是扫描根，find_matching_dirs 无论如何都丢 path == root ---
        "C:/Users/test/AppData/Local/pnpm-cache",
        "/home/test/.cache/pnpm",
        "/home/test/Library/Caches/pnpm",
        // --- *.db（含实测的 store index.db，home / per-drive / POSIX 三形态）---
        "C:/Users/test/AppData/Local/pnpm/store/v11/index.db",
        "D:/.pnpm-store/v11/index.db",
        "/home/test/.local/share/pnpm/store/v11/index.db",
        "C:/Users/test/dev/legacy-app/db_storage/msg/0.db",
        // --- pnpm home 根 / store 根 / 版本目录 / 簿记目录 ---
        "C:/Users/test/AppData/Local/pnpm",
        "C:/Users/test/AppData/Local/pnpm/store",
        "C:/Users/test/AppData/Local/pnpm/store/v11",
        "C:/Users/test/AppData/Local/pnpm/store/v10/index",
        "C:/Users/test/AppData/Local/pnpm/store/v11/projects",
        "D:/.pnpm-store/v11/projects",
        // --- 全局安装的包与命令 shim ---
        "C:/Users/test/AppData/Local/pnpm/global/5/node_modules/typescript/lib/typescript.js",
        "C:/Users/test/AppData/Local/pnpm/bin/pnpm.cmd",
        "C:/Users/test/AppData/Local/pnpm/pnpm.cmd",
        // --- pnpm 配置 / 状态（config 片段同时是 CLAUDE.md 通用红线；
        //     实测 pnpm-state 是 pnpm home 的兄弟目录，不是子目录）---
        "C:/Users/test/AppData/Local/pnpm/config/rc",
        "C:/Users/test/AppData/Local/pnpm/state/pnpm-state.json",
        "C:/Users/test/AppData/Local/pnpm-state/pnpm-state.json",
        "C:/Users/test/.npmrc",
        // --- 项目级虚拟存储与 lockfile ---
        "C:/Users/test/dev/my-app/node_modules/.pnpm/react@19.0.0/node_modules/react/index.js",
        "C:/Users/test/dev/my-app/pnpm-lock.yaml",
        // --- CLAUDE.md 通用红线片段（跨应用形态，防 glob 未来放宽误命中）---
        "C:/Users/test/Documents/xwechat_files/wxid_x/Msg/Attach/img.dat",
        "C:/Users/test/AppData/Roaming/someapp/Accounts/session.json",
        "C:/Users/test/AppData/Roaming/someapp/login/token.json",
        "C:/Users/test/AppData/Roaming/someapp/Favorite/items.json",
        "C:/Users/test/.ssh/keys/id_ed25519",
        "C:/Users/test/AppData/Roaming/someapp/crypto/material.bin",
        // --- 非 pnpm 命名的同名片段（"files" 是常见目录名，必须锚在 store 形态里才命中）---
        "C:/Users/test/backup/files",
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
        "pnpm.toml glob hit red lines:\n  {}",
        violations.join("\n  ")
    );
}
