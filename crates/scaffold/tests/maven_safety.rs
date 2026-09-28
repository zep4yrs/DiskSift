//! Regression test for `scaffolds/maven.toml`: the single `repository` scope
//! must match the Maven 本地仓库（~/.m2/repository，Windows / POSIX 默认布局
//! 与仍叫 .m2 的重定位位置——directory granularity，回收单元就是 repository
//! 目录自身），and **must not** match Maven red lines（用户配置 settings.xml /
//! settings-security.xml、wrapper/dists 在用发行版、项目 pom.xml / .mvn/ /
//! target/ 构建输出、CLAUDE.md 通用红线放进 .m2 下未点名位置）。Globs are
//! anchored to the .m2/repository 两段——".m2-backup"、"m2repo"、改名重定位的
//! -Dmaven.repo.local（maven-repo）这类 substring 邻居必须 zero match。
//!
//! 注意：本机（2026-09-28 勘测）没有 Maven 安装，.m2 不存在——正向路径是
//! Apache Maven 官方目录布局的合成样例（maven.toml 文件头已声明，同 cargo
//! git scope 先例）。repository 的 glob 是**精确锚定 repository 目录自身**
//! （无尾部 /**）：glob 层不命中树内任何深层文件——整树是 directory
//! granularity 的一条回收站记录，所以 _remote.repositories、*.lastUpdated
//! 等桶内文件不作为红线候选（它们不单独成为目标，而是随整树一起走）。

use std::path::PathBuf;

fn workspace_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop(); // out of crates/scaffold
    p.pop(); // out of crates
    p
}

fn load_maven() -> pinkbin_scaffold::Scaffold {
    let path = workspace_root().join("scaffolds/maven.toml");
    let text = std::fs::read_to_string(&path).expect("read maven.toml");
    toml::from_str(&text).expect("parse maven.toml")
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
fn maven_globs_are_safe() {
    // 固定 env 让测试在所有平台上路径一致。
    std::env::set_var("USERPROFILE", "C:/Users/test");
    std::env::set_var("APPDATA", "C:/Users/test/AppData/Roaming");
    std::env::set_var("LOCALAPPDATA", "C:/Users/test/AppData/Local");
    std::env::set_var("HOME", "/home/test");

    let scaffold = load_maven();
    let scopes: Vec<(String, globset::GlobSet)> = scaffold
        .scopes
        .iter()
        .map(|s| (s.id.clone(), build_set(&expand(&s.glob))))
        .collect();

    // ========================================================================
    // 正向：每个 scope 至少一条命中路径（回收单元是 repository 目录自身；
    // Windows / POSIX / 重定位同名的三种根都要覆盖）
    // ========================================================================
    let positives: &[(&str, &str)] = &[
        ("repository", "C:/Users/test/.m2/repository"),
        ("repository", "/home/test/.m2/repository"),
        ("repository", "D:/devTools/.m2/repository"),
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
    //     .m2 下"未点名位置"
    //   - maven 特有：settings.xml（镜像/代理/服务器凭据）、
    //     settings-security.xml（主口令加密载体）、wrapper/dists 在用发行版、
    //     .m2 根自身
    //   - 项目隔离：pom.xml / .mvn/ / 源码 / target/ 构建输出
    //   - segment 精确性：.m2-backup / m2repo / 改名重定位的本地仓库
    //     （-Dmaven.repo.local 指到不叫 .m2 的路径，检测不到，也不能误命中）
    //   - 跨工具隔离：gradle ~/.gradle/caches（gradle scaffold 的正向，这里
    //     必须零命中）、cargo / npm / pnpm / pip / go-build
    // ========================================================================
    let red_lines: &[&str] = &[
        // 通用红线（CLAUDE.md）——.m2 下未点名位置
        "C:/Users/test/.m2/db_storage/MMKV/data.db",
        "C:/Users/test/.m2/Msg/chat.db",
        "C:/Users/test/.m2/MultiMsg/2/voicemail.db",
        "C:/Users/test/.m2/Accounts/state.json",
        "C:/Users/test/.m2/All Users/profile.dat",
        "C:/Users/test/.m2/login/session.dat",
        "C:/Users/test/.m2/config/settings.json",
        "C:/Users/test/.m2/Favorite/bookmarks.json",
        "C:/Users/test/.m2/Fav/shortcuts.json",
        "C:/Users/test/.m2/key/registry.key",
        "C:/Users/test/.m2/crypto/material.pem",
        // maven 特有——用户配置与 wrapper 在用发行版
        "C:/Users/test/.m2/settings.xml",
        "C:/Users/test/.m2/settings-security.xml",
        "C:/Users/test/.m2/wrapper",
        "C:/Users/test/.m2/wrapper/dists/apache-maven-3.9.9-bin/1rsn2vc7p6qcl2v9b9m0q4mfhb/apache-maven-3.9.9/bin/mvn.cmd",
        // maven 结构自身——repository 是唯一回收单元，.m2 根不是
        "C:/Users/test/.m2",
        // 项目隔离——构建脚本 / wrapper 配置 / 源码 / target 输出
        "C:/dev/java-app/pom.xml",
        "C:/dev/java-app/.mvn/wrapper/maven-wrapper.properties",
        "C:/dev/java-app/src/main/java/app/Main.java",
        "C:/dev/java-app/target/classes/app/Main.class",
        "C:/dev/java-app/target/app-1.0.0.jar",
        // segment 精确性——substring 邻居与改名重定位（检测不到，也不能误命中）
        "C:/Users/test/.m2-backup/repository/x.jar",
        "C:/dev/m2repo/repository/org/x/y/1.0/y.jar",
        "D:/maven-repo/org/apache/commons/commons-lang3/3.14.0/commons-lang3-3.14.0.jar",
        // 跨工具隔离——gradle（gradle scaffold 的正向，这里必须零命中）与本机其余工具链
        "C:/Users/test/.gradle/caches",
        "C:/Users/test/.gradle/caches/modules-2/files-2.1/x",
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
        "maven.toml glob hit red lines:\n  {}",
        violations.join("\n  ")
    );
}
