//! Regression test for `scaffolds/nuget.toml`: every scope glob must match the
//! .NET 包缓存桶 it names（global-packages ~/.nuget/packages、http-cache
//! NuGet/v3-cache、plugins-cache——Windows / POSIX 默认布局），and **must not**
//! match NuGet red lines（用户配置 NuGet.Config 两处、Migrations 内部簿记、
//! 项目 .csproj / packages.config / obj / bin、packages.config 时代的项目内
//! packages/、解决方案本地源目录 nuget/、CLAUDE.md 通用红线放进缓存根下未点名
//! 位置）。Globs are anchored to the .nuget / NuGet 段——".nuget-backup"、改名
//! 的 NUGET_PACKAGES 路径这类 substring 邻居必须 zero match。
//!
//! 注意：三个桶的 glob 都**精确锚定桶目录自身**（无尾部 /**）：glob 层不命中
//! 桶内任何深层文件——整桶是 directory granularity 的一条回收站记录（=
//! `dotnet nuget locals <bucket> --clear`），所以 packages/<id>/<ver>/ 内的
//! .nupkg / .nuspec、v3-cache 的 <40hex>$source 缓存文件不作为红线候选
//! （它们不单独成为目标，而是随整桶一起走）。

use std::path::{Path, PathBuf};

fn workspace_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop(); // out of crates/scaffold
    p.pop(); // out of crates
    p
}

fn load_nuget() -> pinkbin_scaffold::Scaffold {
    let path = workspace_root().join("scaffolds/nuget.toml");
    let text = std::fs::read_to_string(&path).expect("read nuget.toml");
    toml::from_str(&text).expect("parse nuget.toml")
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
fn nuget_globs_are_safe() {
    // 固定 env 让测试在所有平台上路径一致。
    std::env::set_var("USERPROFILE", "C:/Users/test");
    std::env::set_var("APPDATA", "C:/Users/test/AppData/Roaming");
    std::env::set_var("LOCALAPPDATA", "C:/Users/test/AppData/Local");
    std::env::set_var("HOME", "/home/test");

    let scaffold = load_nuget();
    let scopes: Vec<(String, globset::GlobSet)> = scaffold
        .scopes
        .iter()
        .map(|s| (s.id.clone(), build_set(&expand(&s.glob))))
        .collect();

    // ========================================================================
    // 正向：每个 scope 至少一条命中路径（回收单元是桶目录自身；
    // Windows / POSIX / 重定位同名的根都要覆盖）
    // ========================================================================
    let positives: &[(&str, &str)] = &[
        // global-packages — Windows / POSIX / 重定位同名的三种根
        ("global-packages", "C:/Users/test/.nuget/packages"),
        ("global-packages", "/home/test/.nuget/packages"),
        ("global-packages", "D:/devTools/.nuget/packages"),
        // http-cache — Windows %LOCALAPPDATA% 与 POSIX XDG 两种布局
        ("http-cache", "C:/Users/test/AppData/Local/NuGet/v3-cache"),
        ("http-cache", "/home/test/.local/share/NuGet/v3-cache"),
        // plugins-cache — 凭据插件按需创建（本机无，官方布局保留）
        (
            "plugins-cache",
            "C:/Users/test/AppData/Local/NuGet/plugins-cache",
        ),
        (
            "plugins-cache",
            "/home/test/.local/share/NuGet/plugins-cache",
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
    //     .nuget 与 %LOCALAPPDATA%/NuGet 下"未点名位置"
    //   - nuget 特有：NuGet.Config 两处（%APPDATA%/NuGet 与 ~/.nuget/NuGet）、
    //     Migrations 内部簿记、缓存根自身（.nuget / Local/NuGet）
    //   - 项目隔离：.csproj / .sln / packages.config / obj / bin、
    //     packages.config 时代的项目内 packages/、解决方案本地源目录 nuget/
    //   - segment 精确性：.nuget-backup / dotnet-packages（改名 NUGET_PACKAGES，
    //     检测不到，也不能误命中）
    //   - 跨工具隔离：gradle / cargo / npm / pnpm / pip / go-build / maven
    // ========================================================================
    let red_lines: &[&str] = &[
        // 通用红线（CLAUDE.md）——缓存根下未点名位置
        "C:/Users/test/.nuget/db_storage/MMKV/data.db",
        "C:/Users/test/.nuget/Msg/chat.db",
        "C:/Users/test/.nuget/MultiMsg/2/voicemail.db",
        "C:/Users/test/.nuget/Accounts/state.json",
        "C:/Users/test/.nuget/All Users/profile.dat",
        "C:/Users/test/.nuget/login/session.dat",
        "C:/Users/test/.nuget/config/settings.json",
        "C:/Users/test/.nuget/Favorite/bookmarks.json",
        "C:/Users/test/.nuget/Fav/shortcuts.json",
        "C:/Users/test/.nuget/key/registry.key",
        "C:/Users/test/.nuget/crypto/material.pem",
        "C:/Users/test/AppData/Local/NuGet/Migrations/1/bookkeeping.db",
        "C:/Users/test/AppData/Local/NuGet/unnamed-bucket/x.dat",
        // nuget 特有——用户配置（两处官方位置）
        "C:/Users/test/AppData/Roaming/NuGet/NuGet.Config",
        "C:/Users/test/AppData/Roaming/NuGet",
        "/home/test/.nuget/NuGet/NuGet.Config",
        // nuget 结构自身——三个桶是回收单元，缓存根不是
        "C:/Users/test/.nuget",
        "C:/Users/test/AppData/Local/NuGet",
        "/home/test/.local/share/NuGet",
        // 项目隔离——清单 / 源码 / 构建输出
        "C:/dev/myapp/myapp.csproj",
        "C:/dev/myapp/myapp.sln",
        "C:/dev/myapp/packages.config",
        "C:/dev/myapp/obj/project.assets.json",
        "C:/dev/myapp/bin/Debug/net8.0/myapp.dll",
        "C:/dev/myapp/Program.cs",
        // 项目隔离——packages.config 时代的项目内 packages/ 与解决方案本地源目录
        "C:/dev/legacy-app/packages/Newtonsoft.Json/13.0.3/Newtonsoft.Json.dll",
        "C:/dev/myapp/nuget/mylib.1.0.0.nupkg",
        // segment 精确性——substring 邻居与改名重定位（检测不到，也不能误命中）
        "C:/Users/test/.nuget-backup/packages/x/1.0.0/x.dll",
        "D:/dotnet-packages/godotsharp/4.7.1/lib/net6.0/GodotSharp.dll",
        // 跨工具隔离——gradle 正向（此处必须零命中）与本机其余工具链
        "C:/Users/test/.gradle/caches",
        "C:/Users/test/.cargo/registry/cache/index.crates.io-1949cf8c6b5b557f/serde-1.0.210.crate",
        "C:/Users/test/AppData/Local/npm-cache/_cacache/index-v5/aa/bb/cc",
        "C:/Users/test/AppData/Local/pnpm/store/v3/files/ab/cdef1234",
        "C:/Users/test/AppData/Local/pip/cache/http-v2/ab/cd/ef",
        "C:/Users/test/AppData/Local/go-build/00/3f9a2b1c8d7e6f5a-d/x.a",
        "C:/Users/test/.m2/repository",
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
        "nuget.toml glob hit red lines:\n  {}",
        violations.join("\n  ")
    );
}

/// detect 层回归（docker_detect_and_match 同款结构）：detect 正负路径 + 每个
/// scope 至少一条正向 glob 命中。[match] 刻意留空（文件头"设计取舍"：nuget
/// 片段会命中本地源目录与克隆的客户端仓库），匹配器不参与，无落盘断言可做。
#[test]
fn nuget_detect_and_match() {
    // 与 nuget_globs_are_safe 同一套 env fixture。
    std::env::set_var("USERPROFILE", "C:/Users/test");
    std::env::set_var("APPDATA", "C:/Users/test/AppData/Roaming");
    std::env::set_var("LOCALAPPDATA", "C:/Users/test/AppData/Local");
    std::env::set_var("HOME", "/home/test");

    let scaffold = load_nuget();
    let scopes: Vec<(String, globset::GlobSet)> = scaffold
        .scopes
        .iter()
        .map(|s| (s.id.clone(), build_set(&expand(&s.glob))))
        .collect();
    let scaffolds = vec![scaffold];

    // ========================================================================
    // detect 正向：三大平台默认路径 + **/.nuget 通配兜底（缓存根换盘仍叫
    // .nuget）。%LOCALAPPDATA%/NuGet 与 POSIX XDG 两处 http-cache 根都算。
    // ========================================================================
    for p in [
        "C:/Users/test/.nuget",
        "/home/test/.nuget",
        "C:/Users/test/AppData/Local/NuGet",
        "/home/test/.local/share/NuGet",
        "D:/dotnet-home/.nuget",
    ] {
        assert_eq!(
            pinkbin_scaffold::detect_for(&scaffolds, Path::new(p)).as_deref(),
            Some("nuget"),
            "detect missed `{p}`",
        );
    }

    // ========================================================================
    // detect 负向：解决方案本地源目录 nuget/（disclaimer 点名，nuget ≠ .nuget，
    // segment 精确性）、NUGET_PACKAGES 改名的缓存根（检测不到，disclaimer 已
    // 说明）、packages 子目录不是 detect 根（detect 标的是 .nuget 自身）。
    // ========================================================================
    for p in [
        "C:/Users/test/Projects/nuget",
        "C:/Users/test/nuget-packages",
        "C:/Users/test/.nuget/packages",
    ] {
        assert_eq!(
            pinkbin_scaffold::detect_for(&scaffolds, Path::new(p)).as_deref(),
            None,
            "unrelated dir `{p}` must not be tagged as nuget",
        );
    }

    // ========================================================================
    // scope 覆盖：三个官方桶各至少一条正向 glob 命中（glob 精确锚定桶目录
    // 自身；http-cache 用小写 nuget 段验证 case_insensitive 编译——nuget.toml
    // 文头声明的实测大小写变体）。
    // ========================================================================
    let positives: &[(&str, &str)] = &[
        ("global-packages", "C:/Users/test/.nuget/packages"),
        ("http-cache", "C:/Users/test/AppData/Local/nuget/v3-cache"),
        (
            "plugins-cache",
            "C:/Users/test/AppData/Local/NuGet/plugins-cache",
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
