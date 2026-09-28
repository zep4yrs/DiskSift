//! Regression test for `scaffolds/cargo.toml`: every scope glob must match the
//! cargo 产物 it names（~/.cargo 的 registry 三桶与 git 依赖缓存，含 crates.io
//! 与 rsproxy 镜像两种 <host>-<hash> 命名、POSIX 家目录布局，以及各 Rust 项目的
//! target/{debug,release} 构建缓存），and **must not** match cargo red lines
//! （~/.cargo/bin 工具链 shim 与 cargo install 命令、.crates.toml / .crates2.json
//! 安装清单、config.toml / credentials 凭据、.package-cache 等锁文件、项目源码与
//! Cargo.toml / Cargo.lock、target/ 根的 CACHEDIR.TAG 与未点名子项、Maven/Java 的
//! target/ 目录）。Globs are anchored to the .cargo / target segment——
//! "mytarget"、"targets"、"target-backup"、".cargo-mirror" 这类 substring 邻居
//! 必须 zero match。
//!
//! 注意：registry / git scope 的 glob 尾部 `*` 是 literal_separator(false)——
//! glob 层会连桶内深层文件一起命中，运行时由 find_matching_dirs 剪枝祖先/后代，
//! 实际回收单元是每个 <host>-<hash> 目录；本测试只覆盖 glob 层，所以两桶下的
//! 深层文件不作为红线候选。target scope 相反：glob 全串匹配终结在 profile
//! 目录自身，深层文件**不**命中——target/debug 内部文件因此可以放心当正向
//! 之外的路径看待，红线只放在 target/ 根下未点名位置。

use std::path::{Path, PathBuf};

fn workspace_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop(); // out of crates/scaffold
    p.pop(); // out of crates
    p
}

fn load_cargo() -> pinkbin_scaffold::Scaffold {
    let path = workspace_root().join("scaffolds/cargo.toml");
    let text = std::fs::read_to_string(&path).expect("read cargo.toml");
    toml::from_str(&text).expect("parse cargo.toml")
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
fn cargo_globs_are_safe() {
    // 固定 env 让测试在所有平台上路径一致。
    std::env::set_var("USERPROFILE", "C:/Users/test");
    std::env::set_var("APPDATA", "C:/Users/test/AppData/Roaming");
    std::env::set_var("LOCALAPPDATA", "C:/Users/test/AppData/Local");
    std::env::set_var("HOME", "/home/test");

    let scaffold = load_cargo();
    let scopes: Vec<(String, globset::GlobSet)> = scaffold
        .scopes
        .iter()
        .map(|s| (s.id.clone(), build_set(&expand(&s.glob))))
        .collect();

    // ========================================================================
    // 正向：每个 scope 至少一条命中路径（<host>-<hash> 两种命名 + POSIX 布局 +
    // target 的 directory 粒度单元都要覆盖）
    // ========================================================================
    let positives: &[(&str, &str)] = &[
        // registry — cache 桶：.crate 下载文件（crates.io 与 rsproxy 镜像并存）
        (
            "registry",
            "C:/Users/test/.cargo/registry/cache/index.crates.io-1949cf8c6b5b557f/serde-1.0.210.crate",
        ),
        (
            "registry",
            "C:/Users/test/.cargo/registry/cache/rsproxy.cn-e3de039b2554c837/anyhow-1.0.86.crate",
        ),
        // registry — cache 桶目录自身（directory 粒度的实际回收单元）
        (
            "registry",
            "C:/Users/test/.cargo/registry/cache/index.crates.io-1949cf8c6b5b557f",
        ),
        // registry — index 桶：sparse 索引缓存
        (
            "registry",
            "C:/Users/test/.cargo/registry/index/index.crates.io-1949cf8c6b5b557f/config.json",
        ),
        // registry — src 桶：解压后的源码树
        (
            "registry",
            "C:/Users/test/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/libc-0.2.158/src/lib.rs",
        ),
        (
            "registry",
            "C:/Users/test/.cargo/registry/src/rsproxy.cn-e3de039b2554c837/tokio-1.40.0/lib.rs",
        ),
        // registry — POSIX 家目录布局
        (
            "registry",
            "/home/test/.cargo/registry/cache/index.crates.io-1949cf8c6b5b557f/clap-4.5.0.crate",
        ),
        // git — db（裸仓库克隆）与 checkouts（工作副本）
        (
            "git",
            "/home/test/.cargo/git/db/serde-rs-slash-serde-a1b2c3d4e5f60718/HEAD",
        ),
        (
            "git",
            "/home/test/.cargo/git/checkouts/bevy-0a1b2c3d4e5f6071/0c1d2e3/Cargo.toml",
        ),
        (
            "git",
            "C:/Users/test/.cargo/git/checkouts/ripgrep-b2c3d4e5f6071829/11.2.3",
        ),
        // target — directory 粒度单元是 profile 目录自身（glob 全串终结于此）
        ("target", "C:/dev/myapp/target/debug"),
        ("target", "C:/dev/myapp/target/release"),
        ("target", "/home/test/code/myapp/target/debug"),
        ("target", "D:/devTools/pinkbinv2/pinkbin/target/release"),
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
    //     ~/.cargo 与 registry 下"未点名位置"，验证 scope 只命中点名桶
    //   - cargo 特有：bin/ 工具链 shim 与 cargo install 命令、安装清单
    //     .crates.toml / .crates2.json、凭据 credentials(.toml)、配置
    //     config.toml、env、锁文件 .package-cache* / .global-cache /
    //     advisory-db..lock、registry/CACHEDIR.TAG 标记
    //   - 桶结构自身：.cargo / registry / git / 各桶目录本身不是回收单元
    //   - 项目隔离：源码、Cargo.toml / Cargo.lock、项目级 .cargo/config.toml、
    //     target/ 根自身与 CACHEDIR.TAG / tmp / doc / 自定义 profile
    //   - 跨工具隔离：Maven/Java 的 target/、npm / pnpm / pip 缓存、.rustup
    //     工具链本体
    //   - segment 精确性：mytarget / targets / target-backup / .cargo-mirror /
    //     src-backup / 重定位后的 CARGO_TARGET_DIR（父目录不叫 target）
    // ========================================================================
    let red_lines: &[&str] = &[
        // 通用红线（CLAUDE.md）——~/.cargo 与 registry 下的未点名位置
        "C:/Users/test/.cargo/db_storage/MMKV/data.db",
        "C:/Users/test/.cargo/Msg/chat.db",
        "C:/Users/test/.cargo/MultiMsg/2/voicemail.db",
        "C:/Users/test/.cargo/Accounts/state.json",
        "C:/Users/test/.cargo/All Users/profile.dat",
        "C:/Users/test/.cargo/login/session.dat",
        "C:/Users/test/.cargo/config/settings.json",
        "C:/Users/test/.cargo/Favorite/bookmarks.json",
        "C:/Users/test/.cargo/Fav/shortcuts.json",
        "C:/Users/test/.cargo/key/registry.key",
        "C:/Users/test/.cargo/crypto/material.pem",
        "C:/Users/test/.cargo/registry/config/account.cfg",
        "C:/Users/test/.cargo/registry/registry.db-wal",
        // cargo 特有——bin/ 是 rustup 工具链 shim + cargo install 的命令
        "C:/Users/test/.cargo/bin/cargo.exe",
        "C:/Users/test/.cargo/bin/rustc.exe",
        "C:/Users/test/.cargo/bin/rust-analyzer.exe",
        "C:/Users/test/.cargo/bin/cargo-audit.exe",
        // cargo 特有——安装清单 / 配置 / 凭据 / env / 锁文件
        "C:/Users/test/.cargo/.crates.toml",
        "C:/Users/test/.cargo/.crates2.json",
        "C:/Users/test/.cargo/config.toml",
        "C:/Users/test/.cargo/credentials",
        "C:/Users/test/.cargo/credentials.toml",
        "C:/Users/test/.cargo/env",
        "C:/Users/test/.cargo/.package-cache",
        "C:/Users/test/.cargo/.package-cache-mutate",
        "C:/Users/test/.cargo/.global-cache",
        "C:/Users/test/.cargo/advisory-db..lock",
        "C:/Users/test/.cargo/registry/CACHEDIR.TAG",
        // 桶结构自身——scope 只回收桶内的 <host>-<hash> 目录，不整根删
        "C:/Users/test/.cargo",
        "C:/Users/test/.cargo/registry",
        "C:/Users/test/.cargo/registry/cache",
        "C:/Users/test/.cargo/registry/index",
        "C:/Users/test/.cargo/registry/src",
        "C:/Users/test/.cargo/git",
        "C:/Users/test/.cargo/git/db",
        "C:/Users/test/.cargo/git/checkouts",
        // registry 下未点名桶（如 src-backup）不进 scope
        "C:/Users/test/.cargo/registry/src-backup/lib.rs",
        // 项目隔离——源码与清单
        "C:/dev/myapp/Cargo.toml",
        "C:/dev/myapp/Cargo.lock",
        "C:/dev/myapp/src/main.rs",
        "C:/dev/myapp/benches/load.rs",
        // 项目隔离——项目级 cargo 配置（**/.cargo 检测得到的零命中卡片不能误删它）
        "C:/dev/myapp/.cargo/config.toml",
        // target/ 根自身与未点名子项（标记、tmp、doc、自定义 profile）
        "C:/dev/myapp/target",
        "C:/dev/myapp/target/CACHEDIR.TAG",
        "C:/dev/myapp/target/tmp/shared.bin",
        "C:/dev/myapp/target/doc/index.html",
        "C:/dev/myapp/target/custom-profile/lib.rmeta",
        // 跨工具隔离——Maven/Java 的 target/（无 CACHEDIR.TAG，也不叫 debug/release）
        "C:/dev/java-app/target",
        "C:/dev/java-app/target/classes/com/app/Main.class",
        "C:/dev/java-app/target/release.jar",
        // 跨工具隔离——npm / pnpm / pip / rustup 本体
        "C:/Users/test/AppData/Local/npm-cache/_cacache/index-v5/aa/bb/cc",
        "C:/Users/test/AppData/Local/pnpm/store/v3/files/ab/cdef1234",
        "C:/Users/test/AppData/Local/pip/cache/http-v2/ab/cd/ef",
        "C:/Users/test/.rustup/toolchains/stable-x86_64-pc-windows-msvc/lib/rustlib/components",
        // segment 精确性——substring 邻居不算命中
        "C:/dev/mytarget/debug/lib.rmeta",
        "C:/Users/test/Documents/targets/debug/clip.bin",
        "D:/devTools/target-backup/debug/app.exe",
        "C:/Users/test/.cargo-mirror/registry/cache/reg/some-1.0.0.crate",
        // 重定位后的 CARGO_TARGET_DIR（父目录不叫 target）检测不到，也不能误命中
        "D:/rust-build-cache/pinkbin/debug/pinkbin.exe",
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
        "cargo.toml glob hit red lines:\n  {}",
        violations.join("\n  ")
    );
}

/// detect / match 层回归（docker_detect_and_match 同款结构）：detect 正负
/// 路径 + [match] 兜底（真实临时目录验 must_have_child）+ 每个 scope 至少
/// 一条正向 glob 命中（防加 scope 忘测）。detect 正负均不落盘——detect 条目
/// 本身是纯 glob；[match] 必须落盘，must_have_child 要 stat 子项。
#[test]
fn cargo_detect_and_match() {
    // 与 cargo_globs_are_safe 同一套 env fixture：expand_env / detect_for 的
    // %VAR% / ${VAR} 展开在所有平台上路径一致。
    std::env::set_var("USERPROFILE", "C:/Users/test");
    std::env::set_var("APPDATA", "C:/Users/test/AppData/Roaming");
    std::env::set_var("LOCALAPPDATA", "C:/Users/test/AppData/Local");
    std::env::set_var("HOME", "/home/test");

    let scaffold = load_cargo();
    let scopes: Vec<(String, globset::GlobSet)> = scaffold
        .scopes
        .iter()
        .map(|s| (s.id.clone(), build_set(&expand(&s.glob))))
        .collect();
    let scaffolds = vec![scaffold];

    // ========================================================================
    // detect 正向：默认 CARGO_HOME（Windows %USERPROFILE% 与 POSIX ${HOME}）
    // + **/.cargo 通配兜底（CARGO_HOME 搬到别的盘仍叫 .cargo）。
    // ========================================================================
    for p in [
        "C:/Users/test/.cargo",
        "/home/test/.cargo",
        "D:/tools/rust/.cargo",
    ] {
        assert_eq!(
            pinkbin_scaffold::detect_for(&scaffolds, Path::new(p)).as_deref(),
            Some("cargo"),
            "detect missed `{p}`",
        );
    }

    // ========================================================================
    // detect 负向：segment 精确性（.cargo-mirror 不是 .cargo）、detect 根的
    // 子目录不是扫描根、无关项目目录。
    // ========================================================================
    for p in [
        "C:/Users/test/.cargo-mirror",
        "C:/Users/test/.cargo/bin",
        "C:/Users/test/Projects/demo",
    ] {
        assert_eq!(
            pinkbin_scaffold::detect_for(&scaffolds, Path::new(p)).as_deref(),
            None,
            "unrelated dir `{p}` must not be tagged as cargo",
        );
    }

    // ========================================================================
    // [match] 兜底（需真实落盘）：基名含 target + 必须真有 CACHEDIR.TAG 子项。
    // - 有标记的项目 target/ → cargo 卡片（[match] 层是 target scope 的唯一
    //   入口，detect 刻意不含 **/target）；
    // - 无标记的 target/（Maven/Java 的构建目录同形态）→ 不标。
    // ========================================================================
    let tmp = std::env::temp_dir().join(format!(
        "pinkbin-cargo-detect-test-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let tagged_target = tmp.join("myapp/target");
    std::fs::create_dir_all(&tagged_target).unwrap();
    std::fs::write(
        tagged_target.join("CACHEDIR.TAG"),
        "Signature: 8a477f597d28d172789f06886806bc55",
    )
    .unwrap();
    assert_eq!(
        pinkbin_scaffold::detect_for(&scaffolds, Path::new(&tagged_target)).as_deref(),
        Some("cargo"),
        "project target/ with CACHEDIR.TAG must be tagged via [match]",
    );

    let maven_target = tmp.join("maven-proj/target");
    std::fs::create_dir_all(maven_target.join("classes")).unwrap();
    assert_eq!(
        pinkbin_scaffold::detect_for(&scaffolds, Path::new(&maven_target)).as_deref(),
        None,
        "target/ without CACHEDIR.TAG must not be tagged (Maven/Java build dir)",
    );
    // Cleanup — best-effort, ignore errors.
    let _ = std::fs::remove_dir_all(&tmp);

    // ========================================================================
    // scope 覆盖：每个 [[scope]] 至少一条正向 glob 命中（样本取 cargo.toml
    // 头部实测布局：crates.io 与 rsproxy 两种 <host>-<hash>、git db/checkouts、
    // target 的 profile 目录）。
    // ========================================================================
    let positives: &[(&str, &str)] = &[
        // registry —— 三桶之一（directory 粒度回收单元 = <host>-<hash> 目录）
        (
            "registry",
            "C:/Users/test/.cargo/registry/cache/index.crates.io-1949cf8c6b5b557f",
        ),
        (
            "registry",
            "C:/Users/test/.cargo/registry/src/rsproxy.cn-e3de039b2554c837/tokio-1.40.0/lib.rs",
        ),
        // git —— 官方布局 glob（本机无 git 依赖仍保留）
        (
            "git",
            "C:/Users/test/.cargo/git/checkouts/ripgrep-b2c3d4e5f6071829/11.2.3",
        ),
        // target —— glob 全串终结在 profile 目录自身
        ("target", "C:/dev/myapp/target/debug"),
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
