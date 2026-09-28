//! Regression test for `scaffolds/gradle.toml`: the single `caches` scope must
//! match the GRADLE_USER_HOME 缓存树（~/.gradle/caches，Windows / POSIX 默认
//! 布局与仍叫 .gradle 的重定位位置——directory granularity，回收单元就是
//! caches 目录自身），and **must not** match Gradle red lines（wrapper/dists
//! 当前在用的发行版、daemon 日志、native / android / .tmp、用户配置
//! gradle.properties、项目源码与 build.gradle / settings.gradle / gradlew、
//! 项目级 .gradle 与 build 输出、CLAUDE.md 通用红线放进 .gradle 下未点名
//! 位置）。Globs are anchored to the .gradle/caches 两段——"mygradle"、
//! ".gradle-backup"、改名的 GRADLE_USER_HOME（gradle-home）这类 substring
//! 邻居必须 zero match。
//!
//! 注意 caches 的 glob 是**精确锚定 caches 目录自身**（无尾部 /**）：glob 层
//! 不命中树内任何深层文件——整树是 directory granularity 的一条回收站记录，
//! 所以 modules-2/modules-2.lock、CACHEDIR.TAG 等桶内文件不作为红线候选
//! （它们不单独成为目标，而是随整树一起走）。

use std::path::PathBuf;

fn workspace_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop(); // out of crates/scaffold
    p.pop(); // out of crates
    p
}

fn load_gradle() -> pinkbin_scaffold::Scaffold {
    let path = workspace_root().join("scaffolds/gradle.toml");
    let text = std::fs::read_to_string(&path).expect("read gradle.toml");
    toml::from_str(&text).expect("parse gradle.toml")
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
fn gradle_globs_are_safe() {
    // 固定 env 让测试在所有平台上路径一致。
    std::env::set_var("USERPROFILE", "C:/Users/test");
    std::env::set_var("APPDATA", "C:/Users/test/AppData/Roaming");
    std::env::set_var("LOCALAPPDATA", "C:/Users/test/AppData/Local");
    std::env::set_var("HOME", "/home/test");

    let scaffold = load_gradle();
    let scopes: Vec<(String, globset::GlobSet)> = scaffold
        .scopes
        .iter()
        .map(|s| (s.id.clone(), build_set(&expand(&s.glob))))
        .collect();

    // ========================================================================
    // 正向：每个 scope 至少一条命中路径（回收单元是 caches 目录自身；
    // Windows / POSIX / 重定位同名的三种根都要覆盖）
    // ========================================================================
    let positives: &[(&str, &str)] = &[
        ("caches", "C:/Users/test/.gradle/caches"),
        ("caches", "/home/test/.gradle/caches"),
        ("caches", "D:/devTools/.gradle/caches"),
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
    //     .gradle 下"未点名位置"
    //   - gradle 特有：wrapper/dists（当前在用发行版）、daemon（运行中日志）、
    //     native / android / .tmp、用户配置 gradle.properties、.gradle 根自身
    //   - 项目隔离：build.gradle / settings.gradle / gradlew / gradle/wrapper、
    //     项目级 .gradle（version 目录）与 build 输出
    //   - segment 精确性：mygradle / .gradle-backup / 改名的 GRADLE_USER_HOME
    //     （检测不到，也不能误命中）
    //   - 跨工具隔离：maven ~/.m2（最近邻）、cargo / npm / pnpm / pip / go-build
    // ========================================================================
    let red_lines: &[&str] = &[
        // 通用红线（CLAUDE.md）——.gradle 下未点名位置
        "C:/Users/test/.gradle/db_storage/MMKV/data.db",
        "C:/Users/test/.gradle/Msg/chat.db",
        "C:/Users/test/.gradle/MultiMsg/2/voicemail.db",
        "C:/Users/test/.gradle/Accounts/state.json",
        "C:/Users/test/.gradle/All Users/profile.dat",
        "C:/Users/test/.gradle/login/session.dat",
        "C:/Users/test/.gradle/config/settings.json",
        "C:/Users/test/.gradle/Favorite/bookmarks.json",
        "C:/Users/test/.gradle/Fav/shortcuts.json",
        "C:/Users/test/.gradle/key/registry.key",
        "C:/Users/test/.gradle/crypto/material.pem",
        // gradle 特有——用户配置
        "C:/Users/test/.gradle/gradle.properties",
        // gradle 特有——wrapper 发行版（当前构建在用）
        "C:/Users/test/.gradle/wrapper",
        "C:/Users/test/.gradle/wrapper/dists",
        "C:/Users/test/.gradle/wrapper/dists/gradle-8.14.3-bin/4xc5vhtu6pfuv0imweb6b9v9/gradle-8.14.3/bin/gradle.bat",
        "C:/Users/test/.gradle/wrapper/dists/gradle-8.14.3-bin/CACHEDIR.TAG",
        // gradle 特有——daemon / native / android / .tmp（未点名目录）
        "C:/Users/test/.gradle/daemon",
        "C:/Users/test/.gradle/daemon/8.14.3/daemon-11644.out.log",
        "C:/Users/test/.gradle/daemon/CACHEDIR.TAG",
        "C:/Users/test/.gradle/native/jansi/jansi.dll",
        "C:/Users/test/.gradle/native",
        "C:/Users/test/.gradle/android/FakeDependency.jar",
        "C:/Users/test/.gradle/android",
        "C:/Users/test/.gradle/.tmp/x.lock",
        "C:/Users/test/.gradle/.tmp",
        // gradle 结构自身——caches 是唯一回收单元，.gradle 根不是
        "C:/Users/test/.gradle",
        "C:/Users/test/.gradle/caches/CACHEDIR.TAG",
        // 项目隔离——构建脚本 / wrapper / 源码 / 输出
        "C:/dev/myapp/build.gradle",
        "C:/dev/myapp/settings.gradle",
        "C:/dev/myapp/gradlew",
        "C:/dev/myapp/gradlew.bat",
        "C:/dev/myapp/gradle/wrapper/gradle-wrapper.properties",
        "C:/dev/myapp/src/main/java/app/Main.java",
        "C:/dev/myapp/build/classes/java/main/app/Main.class",
        "C:/dev/myapp/build/libs/app.jar",
        // 项目隔离——项目级 .gradle（version 目录布局，无 caches/ 子树）
        "C:/dev/myapp/.gradle",
        "C:/dev/myapp/.gradle/8.14.3/taskHistory/taskHistory.bin",
        "C:/dev/myapp/.gradle/8.14.3/checksums/checksums.lock",
        // segment 精确性——substring 邻居与改名重定位（检测不到，也不能误命中）
        "C:/dev/mygradle/caches/modules-2/files-2.1/x",
        "C:/Users/test/.gradle-backup/caches/x.jar",
        "D:/gradle-home/caches/modules-2/files-2.1/g/a/1.0/a-1.0.jar",
        // 跨工具隔离——maven ~/.m2（最近邻）与本机其余工具链
        "C:/Users/test/.m2",
        "C:/Users/test/.m2/repository/org/apache/commons/commons-lang3/3.14.0/commons-lang3-3.14.0.jar",
        "C:/Users/test/.cargo/registry/cache/index.crates.io-1949cf8c6b5b557f/serde-1.0.210.crate",
        "C:/Users/test/AppData/Local/npm-cache/_cacache/index-v5/aa/bb/cc",
        "C:/Users/test/AppData/Local/pnpm/store/v3/files/ab/cdef1234",
        "C:/Users/test/AppData/Local/pip/cache/http-v2/ab/cd/ef",
        "C:/Users/test/AppData/Local/go-build/00/3f9a2b1c8d7e6f5a-d/x.a",
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
        "gradle.toml glob hit red lines:\n  {}",
        violations.join("\n  ")
    );
}
