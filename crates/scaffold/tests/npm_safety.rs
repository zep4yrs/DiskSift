//! Regression test for `scaffolds/npm.toml`: every scope glob must match the
//! cache buckets it names（_cacache / _prebuilds / _logs / _npx，含 POSIX 的
//! ~/.npm 命名、npm<5 的 %APPDATA%/npm-cache 旧位置、以及实测存在的搬迁根
//! D:/devTools/npm-cache），and **must not** match npm red lines（用户/项目
//! .npmrc、全局 prefix %APPDATA%/npm、项目 node_modules、缓存根自身、以及
//! 缓存根下未点名的目录/文件）。Globs are anchored to the {npm-cache,.npm}
//! root segment so relocated caches still hit，同时任何 "npm" 只作为完整
//! path segment 参与 match——"my-npm-cache-backup"、".npmrc"、".npm-cache"
//! 这类 substring 邻居必须 zero match。
//!
//! 注意：`_npx/*` 是 directory granularity——glob 层 `*` 会（literal_separator
//! = false）连内层文件一起命中，运行时由 find_matching_dirs 剪枝祖先/后代；
//! 本测试只覆盖 glob 层，所以 _npx 下的深层文件不作为红线候选。

use std::path::PathBuf;

fn workspace_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop(); // out of crates/scaffold
    p.pop(); // out of crates
    p
}

fn load_npm() -> pinkbin_scaffold::Scaffold {
    let path = workspace_root().join("scaffolds/npm.toml");
    let text = std::fs::read_to_string(&path).expect("read npm.toml");
    toml::from_str(&text).expect("parse npm.toml")
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
fn npm_globs_are_safe() {
    // 固定 env 让测试在所有平台上路径一致。
    std::env::set_var("USERPROFILE", "C:/Users/test");
    std::env::set_var("APPDATA", "C:/Users/test/AppData/Roaming");
    std::env::set_var("LOCALAPPDATA", "C:/Users/test/AppData/Local");
    std::env::set_var("HOME", "/home/test");

    let scaffold = load_npm();
    let scopes: Vec<(String, globset::GlobSet)> = scaffold
        .scopes
        .iter()
        .map(|s| (s.id.clone(), build_set(&expand(&s.glob))))
        .collect();

    // ========================================================================
    // 正向：每个 scope 至少一条命中路径（三种根命名 + 实测搬迁根都覆盖）
    // ========================================================================
    let positives: &[(&str, &str)] = &[
        // cacache — 内容寻址存储（content-v2）与索引（index-v5）
        (
            "cacache",
            "C:/Users/test/AppData/Local/npm-cache/_cacache/content-v2/sha512/ab/cd/3f5a9c8d1e2f",
        ),
        (
            "cacache",
            "C:/Users/test/AppData/Local/npm-cache/_cacache/index-v5/ab/cd/3f5a9c8d1e2f",
        ),
        (
            "cacache",
            "/home/test/.npm/_cacache/content-v2/sha512/ff/ee/0b1c2d3e4f5a",
        ),
        // cacache — _prebuilds（prebuild-install 的预编译二进制缓存）
        (
            "cacache",
            "/home/test/.npm/_prebuilds/node-v20.9.0-win32-x64.tar.gz",
        ),
        // cacache — 搬迁根（实测：npm config set cache 指到非默认盘符后，
        // 默认位置的旧 npm-cache 也还在，两处都要命中）
        (
            "cacache",
            "D:/devTools/npm-cache/_cacache/index-v5/00/11/2f3a4b5c6d7e",
        ),
        // logs — 实测文件名形态：debug log 与 eresolve report
        (
            "logs",
            "C:/Users/test/AppData/Local/npm-cache/_logs/2026-09-24T18_40_28_566Z-debug-0.log",
        ),
        (
            "logs",
            "/home/test/.npm/_logs/2026-08-06T23_27_04_874Z-eresolve-report.txt",
        ),
        // logs — npm<5 的 Windows legacy 缓存位置（%APPDATA%/npm-cache）
        (
            "logs",
            "C:/Users/test/AppData/Roaming/npm-cache/_logs/2020-01-01T00_00_00Z-debug-0.log",
        ),
        // npx-cache — hash 命名的实例目录本身（directory granularity 单元）
        (
            "npx-cache",
            "C:/Users/test/AppData/Local/npm-cache/_npx/1415fee72ff6294b",
        ),
        ("npx-cache", "D:/devTools/npm-cache/_npx/1d6e82a4126006c4"),
        ("npx-cache", "/home/test/.npm/_npx/1bf7c3c15bf47d04"),
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
    //   - 通用红线（CLAUDE.md）：*.db / db_storage / Msg / Accounts / All Users /
    //     login / config / Favorite / key / crypto——放进缓存根下"未点名位置"，
    //     验证 scope 只命中点名的四个桶
    //   - npm 特有：.npmrc（含 registry 登录令牌）、全局 prefix %APPDATA%/npm、
    //     项目 node_modules / package*.json、缓存根自身
    //   - 跨工具隔离：node-gyp / nvm / pnpm store / yarn cache
    //   - segment 精确性："my-npm-cache-backup"、".npm-cache" 这类邻居
    //     不是 npm-cache；~/.npm 下 npm v1-3 的 legacy 每包缓存未点名，不清
    // ========================================================================
    let red_lines: &[&str] = &[
        // 通用红线（CLAUDE.md）——缓存根下的未点名位置
        "C:/Users/test/AppData/Local/npm-cache/registry.db",
        "C:/Users/test/AppData/Local/npm-cache/registry.db-wal",
        "C:/Users/test/AppData/Local/npm-cache/registry.db-shm",
        "C:/Users/test/.npm/db_storage/MMKV/data.db",
        "C:/Users/test/AppData/Local/npm-cache/All Users/profile.dat",
        "C:/Users/test/.npm/Msg/chat.db",
        "C:/Users/test/.npm/Accounts/state.json",
        "C:/Users/test/.npm/config/registry-auth.json",
        "C:/Users/test/.npm/login/session.dat",
        "C:/Users/test/.npm/Favorite/bookmarks.json",
        "C:/Users/test/.npm/key/registry.key",
        "C:/Users/test/.npm/crypto/material.pem",
        "C:/Users/test/AppData/Local/npm-cache/config/settings.json",
        // npm 特有——用户/项目/全局 .npmrc（登录令牌）
        "C:/Users/test/.npmrc",
        "C:/Users/test/Projects/webapp/.npmrc",
        "C:/Users/test/AppData/Roaming/npm/etc/npmrc",
        // npm 特有——全局 prefix（全局包与命令 shim，不是缓存）
        "C:/Users/test/AppData/Roaming/npm",
        "C:/Users/test/AppData/Roaming/npm/node_modules/typescript/package.json",
        "C:/Users/test/AppData/Roaming/npm/tsc.cmd",
        // 缓存根自身（scope 只清点名桶，不整根删）
        "C:/Users/test/AppData/Local/npm-cache",
        "C:/Users/test/AppData/Roaming/npm-cache",
        "/home/test/.npm",
        // 项目隔离——node_modules 与项目清单是依赖，不是缓存
        "C:/Users/test/Projects/webapp/node_modules/express/index.js",
        "C:/Users/test/Projects/webapp/node_modules/.bin/tsc",
        "C:/Users/test/Projects/webapp/package-lock.json",
        "C:/Users/test/Projects/webapp/package.json",
        // 跨工具隔离
        "C:/Users/test/AppData/Local/node-gyp/20.9.0/include/node/node.h",
        "C:/Users/test/AppData/Roaming/nvm/v20.11.0/node.exe",
        "C:/Users/test/AppData/Local/pnpm/store/v3/files/ab/cdef1234",
        "C:/Users/test/AppData/Local/Yarn/Cache/v6/npm-left-pad-1.3.0-12e1fed6c4/index.js",
        // 未点名桶 / segment 精确性
        "/home/test/.npm/lodash/4.17.21/package/package.tgz",
        "C:/Users/test/Documents/my-npm-cache-backup/_cacache/index-v5/aa/bb/cc",
        "C:/Users/test/Projects/webapp/node_modules/.npm-cache/_cacache/content-v2/sha512/aa/bb/cc",
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
        "npm.toml glob hit red lines:\n  {}",
        violations.join("\n  ")
    );
}
