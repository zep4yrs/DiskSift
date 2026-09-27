//! Regression test for `scaffolds/jetbrains.toml`: every scope glob must match
//! the buckets it advertises (bucket layout measured on a real machine,
//! 2026-09-27: PyCharm / CLion 2026.2 under `%LOCALAPPDATA%\JetBrains`), and
//! must not match JetBrains red lines — the config side (`%APPDATA%\JetBrains`:
//! options / keymaps / codestyles / inspection / workspace / plugins / license
//! keys / device ids, plus the measured tasks / event-log-metadata / light-edit
//! / crl dirs), plugins on BOTH sides (Local-side `plugins/` measured 2026-09-27),
//! LocalHistory, the Toolbox install dirs, plus the CLAUDE.md generic red-line
//! fragments.
//!
//! This file is the executable form of the red-line clauses in
//! `docs/research/python-dev-cleanup-landscape.md` §2.1.8 / §2.4 (P0) plus the
//! CLAUDE.md hard rules. A red-line failure means a glob is too wide — tighten
//! the glob, do not relax the test.

use std::path::PathBuf;

fn workspace_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop(); // out of crates/scaffold
    p.pop(); // out of crates
    p
}

fn load_jetbrains() -> pinkbin_scaffold::Scaffold {
    let path = workspace_root().join("scaffolds/jetbrains.toml");
    let text = std::fs::read_to_string(&path).expect("read jetbrains.toml");
    toml::from_str(&text).expect("parse jetbrains.toml")
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
fn jetbrains_globs_are_safe() {
    // Force env vars so the test is reproducible regardless of host.
    std::env::set_var("USERPROFILE", "C:/Users/test");
    std::env::set_var("APPDATA", "C:/Users/test/AppData/Roaming");
    std::env::set_var("LOCALAPPDATA", "C:/Users/test/AppData/Local");
    std::env::set_var("HOME", "C:/Users/test");

    let scaffold = load_jetbrains();
    assert_eq!(scaffold.id, "jetbrains");

    let scopes: Vec<(String, globset::GlobSet)> = scaffold
        .scopes
        .iter()
        .map(|s| (s.id.clone(), build_set(&expand(&s.glob))))
        .collect();

    // ========================================================================
    // 正向断言：每个 scope id 至少一条命中路径（实测 2026.2 布局：
    // %LOCALAPPDATA%/JetBrains/<Product><Ver>/<bucket>，无 system/ 中间层）。
    // ========================================================================
    let positives: &[(&str, &str)] = &[
        // ide-caches：caches（产品）/ index（平台索引）/ cache（Daemon）
        (
            "ide-caches",
            "C:/Users/test/AppData/Local/JetBrains/PyCharm2026.2/caches",
        ),
        (
            "ide-caches",
            "C:/Users/test/AppData/Local/JetBrains/CLion2026.2/caches",
        ),
        (
            "ide-caches",
            "C:/Users/test/AppData/Local/JetBrains/PyCharm2026.2/index",
        ),
        (
            "ide-caches",
            "C:/Users/test/AppData/Local/JetBrains/CLion2026.2/index",
        ),
        (
            "ide-caches",
            "C:/Users/test/AppData/Local/JetBrains/Daemon/cache",
        ),
        // ide-logs：产品目录 log/ + Daemon logs/
        (
            "ide-logs",
            "C:/Users/test/AppData/Local/JetBrains/PyCharm2026.2/log/idea.log",
        ),
        (
            "ide-logs",
            "C:/Users/test/AppData/Local/JetBrains/CLion2026.2/log/threadDump-20260927.txt",
        ),
        (
            "ide-logs",
            "C:/Users/test/AppData/Local/JetBrains/Daemon/logs/daemon.log",
        ),
        // ide-tmp
        (
            "ide-tmp",
            "C:/Users/test/AppData/Local/JetBrains/PyCharm2026.2/tmp",
        ),
        // webview-cache：jcef_cache（PyCharm 实测）/ jcef_cache_temp（CLion 实测）
        (
            "webview-cache",
            "C:/Users/test/AppData/Local/JetBrains/PyCharm2026.2/jcef_cache",
        ),
        (
            "webview-cache",
            "C:/Users/test/AppData/Local/JetBrains/CLion2026.2/jcef_cache_temp",
        ),
        // ai-model-caches：full-line / global-model-cache（2026.2 实测）
        (
            "ai-model-caches",
            "C:/Users/test/AppData/Local/JetBrains/PyCharm2026.2/full-line",
        ),
        (
            "ai-model-caches",
            "C:/Users/test/AppData/Local/JetBrains/CLion2026.2/full-line",
        ),
        (
            "ai-model-caches",
            "C:/Users/test/AppData/Local/JetBrains/PyCharm2026.2/global-model-cache",
        ),
        // pycharm-python-caches：实测两个产品都有 python_stubs / python_packages
        (
            "pycharm-python-caches",
            "C:/Users/test/AppData/Local/JetBrains/PyCharm2026.2/python_stubs",
        ),
        (
            "pycharm-python-caches",
            "C:/Users/test/AppData/Local/JetBrains/CLion2026.2/python_packages",
        ),
        // toolbox-download-cache：未装 Toolbox 的机器 zero match；路径形态来自
        // research §2.4 P1（%LOCALAPPDATA%/JetBrains/Toolbox/{cache,download-cache}）
        (
            "toolbox-download-cache",
            "C:/Users/test/AppData/Local/JetBrains/Toolbox/download-cache",
        ),
        (
            "toolbox-download-cache",
            "C:/Users/test/AppData/Local/JetBrains/Toolbox/cache",
        ),
        // `**` 通配兜底：改盘 / 自定义数据根也要命中
        ("ide-caches", "D:/DevData/JetBrains/PyCharm2026.2/caches"),
    ];

    for (expected_id, p) in positives {
        let hits = matching_scopes(&scopes, p);
        assert!(
            hits.contains(expected_id),
            "expected scope `{expected_id}` to match `{p}`, but matched {hits:?}",
        );
    }

    // 每个 scope 都必须出现在 positives 里——漏掉说明有 scope 永远 zero match
    //（id 写错 / glob 写窄），属于不可达 scope。
    let covered: std::collections::HashSet<&str> = positives.iter().map(|(id, _)| *id).collect();
    for s in &scaffold.scopes {
        assert!(
            covered.contains(s.id.as_str()),
            "scope `{}` has no positive assertion (unreachable scope)",
            s.id,
        );
    }

    // ========================================================================
    // 红线断言：以下路径必须不被任何 scope 命中。
    // config 侧（%APPDATA%/JetBrains）整体 + LocalHistory + Toolbox 安装目录 +
    // CLAUDE.md 通用红线片段（*.db / db_storage / Msg / Accounts / login /
    // config / Favorite / key / crypto）。
    // ========================================================================
    let red_lines: &[&str] = &[
        // ---- CLAUDE.md 通用红线（在 JetBrains 树内的形态）----
        // *.db：Roaming 侧实测存在的两个 IDE 状态库 + Local 侧图标缓存库
        "C:/Users/test/AppData/Roaming/JetBrains/PyCharm2026.2/app-internal-state.db",
        "C:/Users/test/AppData/Roaming/JetBrains/PyCharm2026.2/updatedBrokenPlugins.db",
        "C:/Users/test/AppData/Local/JetBrains/PyCharm2026.2/icon-cache-v2.db",
        // db_storage / Msg / MultiMsg（IM 聊天 DB 片段，JetBrains 树内也不得命中）
        "C:/Users/test/AppData/Roaming/JetBrains/PyCharm2026.2/db_storage/message/msg.db",
        "C:/Users/test/AppData/Roaming/JetBrains/PyCharm2026.2/Msg/MSG_DB.sqlite",
        "C:/Users/test/AppData/Roaming/JetBrains/PyCharm2026.2/MultiMsg/x.db",
        // config / login / Accounts / All Users（账号状态）
        "C:/Users/test/AppData/Roaming/JetBrains/PyCharm2026.2/config/settings.dat",
        "C:/Users/test/AppData/Roaming/JetBrains/PyCharm2026.2/login/auth.dat",
        "C:/Users/test/AppData/Roaming/JetBrains/PyCharm2026.2/Accounts/x.dat",
        "C:/Users/test/AppData/Roaming/JetBrains/PyCharm2026.2/All Users/x.dat",
        // Favorite / Fav（收藏）
        "C:/Users/test/AppData/Roaming/JetBrains/PyCharm2026.2/Favorite/x.dat",
        "C:/Users/test/AppData/Roaming/JetBrains/PyCharm2026.2/Fav/x.dat",
        // key / crypto（加密物料）
        "C:/Users/test/AppData/Roaming/JetBrains/PyCharm2026.2/key/store.key",
        "C:/Users/test/AppData/Roaming/JetBrains/PyCharm2026.2/crypto/x.dat",
        // ---- JetBrains config 侧（research §2.1.1 L3，2026.2 实测目录名）----
        "C:/Users/test/AppData/Roaming/JetBrains/PyCharm2026.2/options/editor.xml",
        "C:/Users/test/AppData/Roaming/JetBrains/PyCharm2026.2/options/colors/my.theme.xml",
        "C:/Users/test/AppData/Roaming/JetBrains/PyCharm2026.2/keymaps/windows.xml",
        "C:/Users/test/AppData/Roaming/JetBrains/PyCharm2026.2/codestyles/Default.xml",
        "C:/Users/test/AppData/Roaming/JetBrains/PyCharm2026.2/inspection/MyProfile.xml",
        "C:/Users/test/AppData/Roaming/JetBrains/PyCharm2026.2/workspace/D--demo-proj.xml",
        // plugins：用户手装插件，删了无法重生（research §2.1.7 强制红线）
        "C:/Users/test/AppData/Roaming/JetBrains/PyCharm2026.2/plugins/statistic/lib/statistic.jar",
        "C:/Users/test/AppData/Roaming/JetBrains/PyCharm2026.2/disabled_plugins.txt",
        "C:/Users/test/AppData/Roaming/JetBrains/CLion2026.2/plugins/x.jar",
        // plugins 在 Local 侧产品目录下也存在（2026.2 实测），同样红线
        "C:/Users/test/AppData/Local/JetBrains/PyCharm2026.2/plugins/x.jar",
        "C:/Users/test/AppData/Local/JetBrains/CLion2026.2/plugins/x.jar",
        // ---- Roaming 侧其余实测目录：任务上下文 / 遥测元数据 / 轻编辑状态 ----
        "C:/Users/test/AppData/Roaming/JetBrains/PyCharm2026.2/tasks/BankSystem.tasks.zip",
        "C:/Users/test/AppData/Roaming/JetBrains/PyCharm2026.2/event-log-metadata/x",
        "C:/Users/test/AppData/Roaming/JetBrains/PyCharm2026.2/light-edit/x",
        "C:/Users/test/AppData/Roaming/JetBrains/PyCharm2026.2/bundled_plugins.txt",
        // 许可证与账号物料（2026.2 实测文件名）
        "C:/Users/test/AppData/Roaming/JetBrains/PyCharm2026.2/pycharm.key",
        "C:/Users/test/AppData/Roaming/JetBrains/CLion2026.2/clion.key",
        "C:/Users/test/AppData/Roaming/JetBrains/PyCharm2026.2/ssl/cacerts",
        "C:/Users/test/AppData/Roaming/JetBrains/PyCharm2026.2/grazie/model/x",
        "C:/Users/test/AppData/Roaming/JetBrains/CLion2026.2/resharper-host/x",
        // 设备 / 账号标识（2026.2 实测 Roaming 根下的文件与目录）
        "C:/Users/test/AppData/Roaming/JetBrains/PermanentDeviceId",
        "C:/Users/test/AppData/Roaming/JetBrains/PermanentUserId",
        "C:/Users/test/AppData/Roaming/JetBrains/consentOptions/accepted",
        "C:/Users/test/AppData/Roaming/JetBrains/bl/x",
        "C:/Users/test/AppData/Roaming/JetBrains/discovery/x",
        "C:/Users/test/AppData/Roaming/JetBrains/crl/x",
        // ---- LocalHistory：本地编辑历史，大小写两种拼写都划红线
        //     （research §2.3.3；大写驼峰为 2026.2 实测）----
        "C:/Users/test/AppData/Local/JetBrains/PyCharm2026.2/LocalHistory/changes.history",
        "C:/Users/test/AppData/Local/JetBrains/PyCharm2026.2/local_history/changes.history",
        "C:/Users/test/AppData/Local/JetBrains/CLion2026.2/LocalHistory/changes.history",
        // ---- Local 侧拿不准的目录：一律红线（fileHistory / coverage / projects /
        //      editor / extResources / httpFileSystem / openapi / splash / ts-go-*）----
        "C:/Users/test/AppData/Local/JetBrains/PyCharm2026.2/fileHistory/x",
        "C:/Users/test/AppData/Local/JetBrains/PyCharm2026.2/coverage/x.ic",
        "C:/Users/test/AppData/Local/JetBrains/PyCharm2026.2/projects/demo/x",
        "C:/Users/test/AppData/Local/JetBrains/PyCharm2026.2/editor/x",
        "C:/Users/test/AppData/Local/JetBrains/PyCharm2026.2/extResources/x",
        "C:/Users/test/AppData/Local/JetBrains/PyCharm2026.2/httpFileSystem/x",
        "C:/Users/test/AppData/Local/JetBrains/PyCharm2026.2/openapi/x",
        "C:/Users/test/AppData/Local/JetBrains/PyCharm2026.2/splash/x",
        "C:/Users/test/AppData/Local/JetBrains/PyCharm2026.2/ts-go-fork-embedded/x",
        "C:/Users/test/AppData/Local/JetBrains/PyCharm2026.2/ts-go-native-preview/x",
        "C:/Users/test/AppData/Local/JetBrains/CLion2026.2/intellij-rust/x",
        // ---- Daemon 与 Toolbox 的安装/运行本体 ----
        "C:/Users/test/AppData/Local/JetBrains/Daemon/bundles/x",
        "C:/Users/test/AppData/Local/JetBrains/Daemon/data/x",
        "C:/Users/test/AppData/Local/JetBrains/Toolbox/apps/IDEA-U/ch-0/2026.2/x",
        "C:/Users/test/AppData/Local/JetBrains/Toolbox/bin/x",
        // ---- macOS / Linux 的 config 侧同样 zero match（research §2.4 P0）----
        "C:/Users/test/Library/Application Support/JetBrains/PyCharm2026.3/options/editor.xml",
        "C:/Users/test/Library/Application Support/JetBrains/PyCharm2026.3/plugins/x.jar",
        "C:/Users/test/.config/JetBrains/IntelliJIdea2024.3/options/editor.xml",
        "C:/Users/test/.local/share/JetBrains/IntelliJIdea2024.3/x",
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
        "jetbrains.toml glob hit red lines:\n  {}",
        violations.join("\n  ")
    );
}
