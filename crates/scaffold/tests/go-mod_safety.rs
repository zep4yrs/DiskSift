//! Regression test for `scaffolds/go-mod.toml`: every scope glob must match the
//! Go 产物 it names（GOPATH/pkg/mod 模块缓存整树、pkg/sumdb 校验和缓存、
//! go-build 两位 hex 对象目录——含 Windows / POSIX 默认布局与仍叫 go /
//! go-build 的重定位位置），and **must not** match Go red lines（go install 的
//! GOPATH/bin、GOPATH 时代 src/ 源码工作区、项目 go.mod / go.sum / vendor/、
//! go-build 根的 README / trim.txt / fuzz 语料库、以及 CLAUDE.md 通用红线放进
//! GOPATH 下未点名位置）。Globs are anchored to the go / go-build segment——
//! "mygo"、"gopath"、"gomodcache"、"build-cache" 这类 substring 邻居必须
//! zero match。
//!
//! 注意 mod-cache 的 glob 是**精确锚定 pkg/mod 目录自身**（无尾部 /**）：
//! glob 层不命中树内任何深层文件——整树是 directory granularity 的一条回收站
//! 记录（`go clean -modcache` 语义），所以 pkg/mod 内部的 cache/lock 等不作为
//! 红线候选（它们不单独成为目标，而是随整树一起走）。sumdb / build-cache 恰
//! 相反：glob 尾部 * / /** 在 literal_separator(false) 下会命中深层路径，运行时
//! 由 find_matching_dirs（sumdb）与 file 粒度扫描（build-cache）处理。

use std::path::{Path, PathBuf};

fn workspace_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop(); // out of crates/scaffold
    p.pop(); // out of crates
    p
}

fn load_go_mod() -> pinkbin_scaffold::Scaffold {
    let path = workspace_root().join("scaffolds/go-mod.toml");
    let text = std::fs::read_to_string(&path).expect("read go-mod.toml");
    toml::from_str(&text).expect("parse go-mod.toml")
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
fn go_mod_globs_are_safe() {
    // 固定 env 让测试在所有平台上路径一致。
    std::env::set_var("USERPROFILE", "C:/Users/test");
    std::env::set_var("APPDATA", "C:/Users/test/AppData/Roaming");
    std::env::set_var("LOCALAPPDATA", "C:/Users/test/AppData/Local");
    std::env::set_var("HOME", "/home/test");

    let scaffold = load_go_mod();
    let scopes: Vec<(String, globset::GlobSet)> = scaffold
        .scopes
        .iter()
        .map(|s| (s.id.clone(), build_set(&expand(&s.glob))))
        .collect();

    // ========================================================================
    // 正向：每个 scope 至少一条命中路径（默认布局 + 重定位同名的位置都覆盖）
    // ========================================================================
    let positives: &[(&str, &str)] = &[
        // mod-cache — 回收单元就是 pkg/mod 目录自身（directory granularity，
        // 精确锚定，无尾部 /**）。Windows / POSIX / 重定位同名三种根。
        ("mod-cache", "C:/Users/test/go/pkg/mod"),
        ("mod-cache", "/home/test/go/pkg/mod"),
        ("mod-cache", "D:/devTools/go/pkg/mod"),
        // sumdb — 新版布局 pkg/sumdb/<db>，单元是 <db> 目录
        ("sumdb", "C:/Users/test/go/pkg/sumdb/sum.golang.org"),
        ("sumdb", "/home/test/go/pkg/sumdb/sum.golang.org"),
        // build-cache — 两位 hex 对象目录下的编译产物（file granularity +
        // days 30；对象 mtime = 编译时间）。三平台默认布局 + 重定位同名。
        (
            "build-cache",
            "C:/Users/test/AppData/Local/go-build/00/3f9a2b1c8d7e6f5a-d/x.a",
        ),
        (
            "build-cache",
            "C:/Users/test/AppData/Local/go-build/ff/0b1c2d3e4f5a6b7c/main.exe",
        ),
        (
            "build-cache",
            "/home/test/.cache/go-build/ab/cd1234abcd5678ef/prog",
        ),
        (
            "build-cache",
            "D:/devTools/go-build/9e/deadbeef01234567/lib.o",
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
    //   - 通用红线（CLAUDE.md）：*.db / db_storage / Msg / MultiMsg / Accounts /
    //     All Users / login / config / Favorite / Fav / key / crypto——放进
    //     GOPATH 下"未点名位置"，验证 scope 只命中点名的三个桶
    //   - go 特有：GOPATH/bin（go install 命令）、GOPATH/src（modules 之前的
    //     源码工作区）、go 根与 pkg/ 自身、go-build 根自身与 README / trim.txt /
    //     fuzz 语料库、pkg/sumdb 根自身
    //   - 项目隔离：go.mod / go.sum / 源码 / vendor/
    //   - segment 精确性：mygo / gopath / gomodcache / build-cache / 重定位改名
    //     的 GOPATH / GOCACHE（检测不到，也不能误命中）
    //   - 跨工具隔离：cargo / npm / pnpm / pip / .rustup
    // ========================================================================
    let red_lines: &[&str] = &[
        // 通用红线（CLAUDE.md）——GOPATH 下未点名位置
        "C:/Users/test/go/db_storage/MMKV/data.db",
        "C:/Users/test/go/Msg/chat.db",
        "C:/Users/test/go/MultiMsg/2/voicemail.db",
        "C:/Users/test/go/Accounts/state.json",
        "C:/Users/test/go/All Users/profile.dat",
        "C:/Users/test/go/login/session.dat",
        "C:/Users/test/go/config/settings.json",
        "C:/Users/test/go/Favorite/bookmarks.json",
        "C:/Users/test/go/Fav/shortcuts.json",
        "C:/Users/test/go/key/registry.key",
        "C:/Users/test/go/crypto/material.pem",
        "C:/Users/test/go/pkg/unnamed-bucket/x.dat",
        // go 特有——go install 的命令与 GOPATH 时代源码工作区
        "C:/Users/test/go/bin/dlv.exe",
        "C:/Users/test/go/bin/staticcheck.exe",
        "C:/Users/test/go/bin/govulncheck.exe",
        "C:/Users/test/go/src/github.com/user/proj/main.go",
        // go 特有——GOPATH 结构自身（mod-cache 的单元是 pkg/mod，pkg/ 与 go 根不是）
        "C:/Users/test/go",
        "C:/Users/test/go/pkg",
        "C:/Users/test/go/pkg/sumdb",
        // go-build 结构自身与未点名子项（说明文档、trim 记账、fuzz 语料库）
        "C:/Users/test/AppData/Local/go-build",
        "C:/Users/test/AppData/Local/go-build/README",
        "C:/Users/test/AppData/Local/go-build/trim.txt",
        "C:/Users/test/AppData/Local/go-build/fuzz/cnb.cool/corpus.zip",
        // 项目隔离——源码与清单
        "C:/dev/myapp/go.mod",
        "C:/dev/myapp/go.sum",
        "C:/dev/myapp/main.go",
        "C:/dev/myapp/vendor/github.com/x/y/y.go",
        "C:/dev/myapp",
        // segment 精确性——substring 邻居与改名重定位（检测不到，也不能误命中）
        "C:/dev/mygo/pkg/mod/github.com/x@v1.0.0/y.go",
        "C:/Users/test/Documents/gopath/pkg/mod/x@v1.2.3/a.go",
        "D:/gomodcache/github.com/x/y@v1.0.0/y.go",
        "D:/build-cache/00/obj.o",
        "C:/Users/test/Documents/my-go-build/ab/cd1234/obj.o",
        // 跨工具隔离——cargo / npm / pnpm / pip / rustup 本体
        "C:/Users/test/.cargo/registry/cache/index.crates.io-1949cf8c6b5b557f/serde-1.0.210.crate",
        "C:/Users/test/AppData/Local/npm-cache/_cacache/index-v5/aa/bb/cc",
        "C:/Users/test/AppData/Local/pnpm/store/v3/files/ab/cdef1234",
        "C:/Users/test/AppData/Local/pip/cache/http-v2/ab/cd/ef",
        "C:/Users/test/.rustup/toolchains/stable-x86_64-pc-windows-msvc/lib/rustlib/components",
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
        "go-mod.toml glob hit red lines:\n  {}",
        violations.join("\n  ")
    );
}

/// detect 层回归（docker_detect_and_match 同款结构）：detect 正负路径 + 每个
/// scope 至少一条正向 glob 命中（防加 scope 忘测）。[match] 刻意留空（文件头
/// "设计取舍"：没有安全的基名片段），匹配器不参与，无落盘断言可做。
#[test]
fn go_mod_detect_and_match() {
    // 与 go_mod_globs_are_safe 同一套 env fixture。
    std::env::set_var("USERPROFILE", "C:/Users/test");
    std::env::set_var("APPDATA", "C:/Users/test/AppData/Roaming");
    std::env::set_var("LOCALAPPDATA", "C:/Users/test/AppData/Local");
    std::env::set_var("HOME", "/home/test");

    let scaffold = load_go_mod();
    let scopes: Vec<(String, globset::GlobSet)> = scaffold
        .scopes
        .iter()
        .map(|s| (s.id.clone(), build_set(&expand(&s.glob))))
        .collect();
    let scaffolds = vec![scaffold];

    // ========================================================================
    // detect 正向：GOPATH 三平台默认 + GOCACHE 三平台默认 + ** 通配兜底
    // （GOPATH 搬到仍叫 go 的位置、GOCACHE 搬到仍叫 go-build 的位置）。
    // ========================================================================
    for p in [
        "C:/Users/test/go",
        "/home/test/go",
        "C:/Users/test/AppData/Local/go-build",
        "/home/test/.cache/go-build",
        "/home/test/Library/Caches/go-build",
        // 重定位：GOPATH 换盘但仍叫 go —— 兜底锚的是 go/pkg/mod 两级深，不是裸 **/go
        "D:/gopath/go/pkg/mod",
        // 重定位：GOCACHE 换盘但仍叫 go-build
        "E:/ci/go-build",
    ] {
        assert_eq!(
            pinkbin_scaffold::detect_for(&scaffolds, Path::new(p)).as_deref(),
            Some("go-mod"),
            "detect missed `{p}`",
        );
    }

    // ========================================================================
    // detect 负向：用户项目目录（裸 **/go 刻意不用）、前缀邻居（segment
    // 精确性）、GOPATH 结构自身不是扫描根、GOPATH src 工作区（红线）也不是
    // detect 根。
    // ========================================================================
    for p in [
        "C:/Users/test/Projects/go",
        "C:/Users/test/Projects/my-go-build",
        "C:/Users/test/go/pkg",
        "C:/Users/test/go/src",
    ] {
        assert_eq!(
            pinkbin_scaffold::detect_for(&scaffolds, Path::new(p)).as_deref(),
            None,
            "unrelated dir `{p}` must not be tagged as go-mod",
        );
    }

    // ========================================================================
    // scope 覆盖：每个 [[scope]] 至少一条正向 glob 命中（样本取 go-mod.toml
    // 头部 2026-09-28 实测布局）。
    // ========================================================================
    let positives: &[(&str, &str)] = &[
        // mod-cache —— 精确锚定 pkg/mod 目录自身（整树一条回收站记录）
        ("mod-cache", "C:/Users/test/go/pkg/mod"),
        // sumdb —— 单元是 pkg/sumdb/<db> 目录
        ("sumdb", "C:/Users/test/go/pkg/sumdb/sum.golang.org"),
        // build-cache —— 两位 hex 对象目录下的编译产物（file 粒度 + days 30）
        (
            "build-cache",
            "C:/Users/test/AppData/Local/go-build/00/3f9a2b1c8d7e6f5a-d/x.a",
        ),
        (
            "build-cache",
            "/home/test/.cache/go-build/ab/cd1234abcd5678ef/prog",
        ),
    ];
    for (expected_id, p) in positives {
        let hits = matching_scopes(&scopes, p);
        assert!(
            hits.contains(expected_id),
            "expected scope `{expected_id}` to match `{p}`, got {hits:?}",
        );
    }
    let covered: std::collections::HashSet<&str> = positives.iter().map(|(id, _)| *id).collect();
    let all_ids: Vec<&str> = scaffolds[0].scopes.iter().map(|s| s.id.as_str()).collect();
    for id in &all_ids {
        assert!(
            covered.contains(id),
            "scope `{id}` has no positive path in the test",
        );
    }
}
