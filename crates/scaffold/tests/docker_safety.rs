//! Safety test for `scaffolds/docker.toml`：2026-05-05 被裁撤的 legacy docker
//! scaffold（无 safety test）的重做版断言。本卡只做一件事——Docker Desktop 的
//! 主机侧日志（Windows `%LOCALAPPDATA%/Docker/log/**`、macOS
//! `~/Library/Containers/com.docker.docker/Data/log/**`）。本文件断言：
//!
//! 1. 正向：logs glob 必须命中两个平台数据根下 log/ 里的日志文件，且每条正向
//!    路径都是某个 detect 根的严格后代（机械断言，python_tmp_safety.rs 同款）；
//! 2. 红线：Docker 的 VM 虚拟磁盘（vhdx / Docker.raw——镜像、容器、卷、build
//!    cache 全在里面，文件级删除 = 恢复出厂，卷内数据库一起没）、CLI 配置根
//!    ~/.docker（config.json 凭据、cli-plugins、buildx、trusts）、Desktop 设置
//!    （%APPDATA%/Docker）、数据根下未点名的位置（*.db / Accounts / config /
//!    key / crypto 等 CLAUDE.md 通用红线）、两个 detect 根自身，全部零命中。
//!
//! glob 层已知边界：`**/Docker/log/**` 对任何名为 `docker/log/` 的路径都成立
//! （如用户项目 `~/code/docker/log/`）——运行时不可达，因为 docker 没有
//! name_contains / `**` 通配 detect，没有任何扫描根会指到那里（见
//! docker_detect_and_match 对 `Projects/docker` 的断言）。npm.toml 的 `_npx`
//! 注记同一性质的边界：本测试只覆盖 glob 层，可达性由 detect 表面保证。
//!
//! 主机未装 Docker（2026-09-28 勘测，见 docker.toml 文件头）：布局依据 Docker
//! 官方文档；正负样本都是文档布局下的代表性路径，不是实测路径。

use std::path::{Path, PathBuf};

const SCAFFOLD_FILE: &str = "scaffolds/docker.toml";

fn workspace_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop(); // out of crates/scaffold
    p.pop(); // out of crates
    p
}

fn load_docker() -> pinkbin_scaffold::Scaffold {
    let path = workspace_root().join(SCAFFOLD_FILE);
    let text = std::fs::read_to_string(&path).expect("read docker.toml");
    toml::from_str(&text).expect("parse docker.toml")
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

/// Mirror `scaffold::expand_env`：%VAR% 走 winpct 语义，${VAR} 走 shellexpand::env
/// 语义（本卡 detect 含 ${HOME}，机械可达性断言要能展开它；HOME 由 fixture 固定，
/// 两个平台分支都死得确定）。
fn expand(s: &str) -> String {
    // 先展开 %VAR%（winpct），再展开 ${VAR}（shellexpand），与 expand_env 的
    // 两段式顺序一致。
    let pct = {
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
    };
    let mut out = String::with_capacity(pct.len());
    let bytes = pct.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'$' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
            if let Some(end) = bytes[i + 2..].iter().position(|&b| b == b'}') {
                let var = std::str::from_utf8(&bytes[i + 2..i + 2 + end]).unwrap_or("");
                if let Ok(v) = std::env::var(var) {
                    out.push_str(&v.replace('\\', "/"));
                    i += end + 3;
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

fn set_fixture_env() {
    // 固定 env 让测试在所有平台上路径一致。
    std::env::set_var("USERPROFILE", "C:/Users/test");
    std::env::set_var("APPDATA", "C:/Users/test/AppData/Roaming");
    std::env::set_var("LOCALAPPDATA", "C:/Users/test/AppData/Local");
    std::env::set_var("HOME", "/home/test");
}

/// 运行时可达不变量的机械断言：docker 的 detect 展开后全是字面量路径，每条正向
/// 路径必须是某个 detect 根的严格后代（运行时以 detect 根为扫描根，
/// find_matching_dirs 丢 path == root）。
fn assert_positive_paths_are_reachable(
    scaffold: &pinkbin_scaffold::Scaffold,
    positives: &[(&str, &str)],
) {
    let roots: Vec<String> = scaffold
        .detect
        .iter()
        .map(|d| expand(d).replace('\\', "/").to_lowercase())
        .collect();
    for (scope_id, p) in positives {
        let p = p.replace('\\', "/").to_lowercase();
        assert!(
            roots
                .iter()
                .any(|r| p != *r && p.starts_with(&format!("{r}/"))),
            "positive path `{p}` (scope `{scope_id}`) is not a strict descendant of any \
             detect root {roots:?} — 根不可达的正向断言无效",
        );
    }
}

#[test]
fn docker_globs_are_safe() {
    set_fixture_env();

    let scaffold = load_docker();
    let scopes: Vec<(String, globset::GlobSet)> = scaffold
        .scopes
        .iter()
        .map(|s| (s.id.clone(), build_set(&expand(&s.glob))))
        .collect();

    // ========================================================================
    // 正向断言：每个 scope id 至少一条命中路径；每条路径都是某个 detect 根
    // （%LOCALAPPDATA%/Docker、${HOME}/Library/Containers/com.docker.docker/Data）
    // 的严格后代（机械断言见下）。
    // ========================================================================
    let positives: &[(&str, &str)] = &[
        // logs —— Windows：%LOCALAPPDATA%/Docker/log/ 的 host 侧与 vm 侧
        (
            "logs",
            "C:/Users/test/AppData/Local/Docker/log/host/com.docker.backend.exe.log",
        ),
        (
            "logs",
            "C:/Users/test/AppData/Local/Docker/log/host/com.docker.build.exe.log",
        ),
        (
            "logs",
            "C:/Users/test/AppData/Local/Docker/log/vm/dockerd.log",
        ),
        // logs —— macOS：com.docker.docker/Data/log/ 的 host 侧与 vm 侧
        (
            "logs",
            "/home/test/Library/Containers/com.docker.docker/Data/log/host/Docker.log",
        ),
        (
            "logs",
            "/home/test/Library/Containers/com.docker.docker/Data/log/vm/dockerd.log",
        ),
    ];

    for (expected_id, p) in positives {
        let hits = matching_scopes(&scopes, p);
        assert!(
            hits.contains(expected_id),
            "expected scope `{expected_id}` to match `{p}`, got {hits:?}",
        );
    }

    assert_positive_paths_are_reachable(&scaffold, positives);

    // 每个 [[scope]] 都必须被至少一条正向路径覆盖——防止加了 scope 忘了测。
    let covered: std::collections::HashSet<&str> = positives.iter().map(|(id, _)| *id).collect();
    for s in &scaffold.scopes {
        assert!(
            covered.contains(s.id.as_str()),
            "scope `{}` has no positive path in the test",
            s.id,
        );
    }

    // ========================================================================
    // 红线断言：以下路径必须不被任何 scope 命中
    //   - VM 虚拟磁盘（vhdx / Docker.raw / Linux desktop 盘——镜像、容器、卷、
    //     build cache 全在里面；删它 = Clean / Purge data 恢复出厂，卷内数据库
    //     一起没，L3。归 Docker Desktop Troubleshoot 或 docker system prune 管）
    //   - CLI 配置根 ~/.docker（config.json 凭据、cli-plugins、contexts、
    //     buildx、trusts 签名物料——本卡不 detect，glob 也不得命中）
    //   - Desktop 设置 %APPDATA%/Docker（settings-store.json / settings.json）
    //   - 通用红线（CLAUDE.md）放在数据根下"未点名位置"，验证 scope 只命中
    //     log/ 子树
    //   - 两个 detect 根自身、log/ 桶根自身（find_matching_dirs 丢 path == root
    //     是运行时保护；glob 层同样不应命中）
    //   - segment 精确性：my-docker-app / docker-compose / Docker-backup /
    //     predocker 等邻居不是 Docker Desktop 的数据根
    // ========================================================================
    let red_lines: &[&str] = &[
        // —— VM 虚拟磁盘：新版 wsl/disk/docker_data.vhdx + 旧版 wsl/data/ext4.vhdx
        //    + distro/ 系统盘 + macOS Docker.raw + Linux desktop 盘 ——
        "C:/Users/test/AppData/Local/Docker/wsl/disk/docker_data.vhdx",
        "C:/Users/test/AppData/Local/Docker/wsl/data/ext4.vhdx",
        "C:/Users/test/AppData/Local/Docker/wsl/distro/ext4.vhdx",
        "C:/Users/test/AppData/Local/Docker/wsl/main/ext4.vhdx",
        "C:/Users/test/AppData/Local/Docker/wsl",
        "/home/test/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw",
        "/home/test/.docker/desktop/vm-data/disk.img",
        // —— CLI 配置根 ~/.docker（本卡不 detect）——
        "/home/test/.docker/config.json",
        "/home/test/.docker/daemon.json",
        "/home/test/.docker/contexts/meta/8a2f11c0/meta.json",
        "/home/test/.docker/cli-plugins/docker-compose.exe",
        "/home/test/.docker/buildx/instances/builder0",
        "/home/test/.docker/trusts/tuf/docker.io/metadata.json",
        // —— Desktop 设置 ——
        "C:/Users/test/AppData/Roaming/Docker/settings-store.json",
        "C:/Users/test/AppData/Roaming/Docker/settings.json",
        // —— 通用红线（CLAUDE.md）：数据根下未点名位置 ——
        "C:/Users/test/AppData/Local/Docker/registry.db",
        "C:/Users/test/AppData/Local/Docker/registry.db-wal",
        "C:/Users/test/AppData/Local/Docker/registry.db-shm",
        "C:/Users/test/AppData/Local/Docker/db_storage/MMKV/data.db",
        "C:/Users/test/AppData/Local/Docker/All Users/profile.dat",
        "C:/Users/test/AppData/Local/Docker/Accounts/state.json",
        "C:/Users/test/AppData/Local/Docker/config/settings.json",
        "C:/Users/test/AppData/Local/Docker/login/session.dat",
        "C:/Users/test/AppData/Local/Docker/Favorite/bookmarks.json",
        "C:/Users/test/AppData/Local/Docker/key/registry.key",
        "C:/Users/test/AppData/Local/Docker/crypto/material.pem",
        "/home/test/Library/Containers/com.docker.docker/Data/Msg/chat.db",
        "/home/test/Library/Containers/com.docker.docker/Data/Accounts/state.json",
        "/home/test/Library/Containers/com.docker.docker/Data/config/settings.json",
        "/home/test/Library/Containers/com.docker.docker/Data/login/session.dat",
        "/home/test/Library/Containers/com.docker.docker/Data/Favorite/bookmarks.json",
        "/home/test/Library/Containers/com.docker.docker/Data/key/registry.key",
        "/home/test/Library/Containers/com.docker.docker/Data/crypto/material.pem",
        // —— 数据根本身、log/ 桶根自身（scope 只清 log/ 的内容）——
        "C:/Users/test/AppData/Local/Docker",
        "/home/test/Library/Containers/com.docker.docker/Data",
        "C:/Users/test/AppData/Local/Docker/log",
        "/home/test/Library/Containers/com.docker.docker/Data/log",
        // —— segment 精确性：邻居目录（用户自己的项目/备份）不是 Docker 数据根 ——
        "C:/Users/test/Projects/my-docker-app/logs/backend.log",
        "C:/Users/test/Projects/docker-compose/log/app.log",
        "C:/Users/test/Documents/Docker-backup/log/a.log",
        "C:/Users/test/AppData/Local/predocker/log/x.log",
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
        "docker.toml glob hit red lines:\n  {}",
        violations.join("\n  ")
    );
}

#[test]
fn docker_detect_and_match() {
    set_fixture_env();

    let scaffold = load_docker();
    let scaffolds = vec![scaffold];

    // detect 覆盖两个平台的数据根——运行时扫描根即由此而来。
    for p in [
        "C:/Users/test/AppData/Local/Docker",
        "c:/users/test/appdata/local/docker", // Windows 实际大小写不定
        "/home/test/Library/Containers/com.docker.docker/Data",
    ] {
        assert_eq!(
            pinkbin_scaffold::detect_for(&scaffolds, Path::new(p)).as_deref(),
            Some("docker"),
            "detect missed `{p}`",
        );
    }

    // 无 [match] 兜底（"docker" 是高频项目名，name_contains 会把用户自己的
    // docker 项目目录标成扫描根）：项目目录、CLI 配置根 ~/.docker、npm/pip 的
    // 缓存根都不得被标成 docker。
    for p in [
        "C:/Users/test/Projects/docker",
        "C:/Users/test/Projects/my-docker-app",
        "/home/test/.docker",
        "C:/Users/test/AppData/Local/npm-cache",
        "C:/Users/test/AppData/Local/pip/cache",
    ] {
        assert_eq!(
            pinkbin_scaffold::detect_for(&scaffolds, Path::new(p)).as_deref(),
            None,
            "unrelated dir `{p}` must not be tagged as docker",
        );
    }
}
