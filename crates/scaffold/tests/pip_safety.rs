//! Regression test for `scaffolds/pip.toml`: every scope glob must match the
//! paths it advertises, and **must not** match pip red lines（已安装的包本体
//! site-packages、pip 配置与凭据、venv/conda env 本体、selfcheck、CLAUDE.md
//! 通用红线：聊天/账号 DB、账号状态、收藏、加密物料）。
//!
//! 设计依据：docs/research/python-dev-cleanup-landscape.md §1.4（pip 残留）+
//! 2026-09-27 本机勘测（pip 22.3.1，%LOCALAPPDATA%/pip/cache 真实目录，只列
//! 目录名：http/ http-v2/ selfcheck/ wheels/）。红线断言失败 = scaffold glob
//! 写宽了——回去收紧 glob，不要放宽测试。
//!
//! 另外断言 detect / [match] 行为：三大平台默认路径与 **/pip/cache 兜底能命中；
//! 基名含 "pip" 但没有 cache/ 子目录的目录（pipx 之类）不得命中。
//!
//! 运行时可达不变量（2026-09-27 复核新增）：每个 scope 的正向断言路径必须是某个
//! detect 根的**严格后代**——运行时 scope 匹配总是以 detect 命中的目录为扫描根
//! （CleanupModal.tsx 把每个 m.path 传给 scopeSizes / executeScope），且
//! find_matching_dirs 无条件丢弃 path == root。根不可达的正向断言视为无效。
//! 原 build-temp scope 的正向路径（%TEMP% 里的 pip-*）不在任何 pip detect 根的
//! 子树内，运行时永远零命中——scope 已整体迁移至 scaffolds/python-tmp.toml +
//! tests/python_tmp_safety.rs（能力搬家，非删除），本文件把 %TEMP%/pip-* 升格为
//! 红线：pip 的任何 scope 都不得再命中。

use std::path::{Path, PathBuf};

fn workspace_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop(); // out of crates/scaffold
    p.pop(); // out of crates
    p
}

fn load_pip() -> pinkbin_scaffold::Scaffold {
    let path = workspace_root().join("scaffolds/pip.toml");
    let text = std::fs::read_to_string(&path).expect("read pip.toml");
    toml::from_str(&text).expect("parse pip.toml")
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

/// Mirror scaffold::expand_env for `%VAR%`-style env substitution.
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

fn set_fixture_env() {
    // 固定 env 让测试在所有平台上路径一致。
    std::env::set_var("USERPROFILE", "C:/Users/test");
    std::env::set_var("APPDATA", "C:/Users/test/AppData/Roaming");
    std::env::set_var("LOCALAPPDATA", "C:/Users/test/AppData/Local");
    std::env::set_var("HOME", "/home/test");
    std::env::set_var("TEMP", "C:/Users/test/AppData/Local/Temp");
    std::env::set_var("TMP", "C:/Users/test/AppData/Local/Temp");
}

#[test]
fn pip_globs_are_safe() {
    set_fixture_env();

    let scaffold = load_pip();
    let scopes: Vec<(String, globset::GlobSet)> = scaffold
        .scopes
        .iter()
        .map(|s| (s.id.clone(), build_set(&expand(&s.glob))))
        .collect();

    // ========================================================================
    // 正向断言：每个 scope id 至少一条命中路径
    // ========================================================================
    let positives: &[(&str, &str)] = &[
        // http-cache —— Windows 默认布局的两个桶（2026-09-27 实测并存：
        // pip 22.3.1 的 http/ 与 Python 3.13 侧新 pip 的 http-v2/）
        ("http-cache", "C:/Users/test/AppData/Local/pip/cache/http"),
        ("http-cache", "C:/Users/test/AppData/Local/pip/cache/http-v2"),
        // http-cache —— Linux / macOS 默认布局（桶直挂 pip/ 下）
        ("http-cache", "/home/test/.cache/pip/http-v2"),
        ("http-cache", "/home/test/Library/Caches/pip/http"),
        // http-cache —— PIP_CACHE_DIR 重定位到别的盘、根名仍叫 pip/cache
        ("http-cache", "D:/python-pool/pip/cache/http-v2"),
        // wheels —— Windows 默认布局，实测形态 <2hex>/<2hex>/<2hex>/<40hex>/
        (
            "wheels",
            "C:/Users/test/AppData/Local/pip/cache/wheels/01/90/39/480b7553719a742763eb73c7d5db9c6a8ceb54582adfdc77c6/win_unicode_console-0.5-py3-none-any.whl",
        ),
        (
            "wheels",
            "C:/Users/test/AppData/Local/pip/cache/wheels/16/ba/d9/ad951f9378e792c0395e8bec17359fdcbf6300567d7c918f82/origin.json",
        ),
        // wheels —— Linux 默认布局
        (
            "wheels",
            "/home/test/.cache/pip/wheels/ab/cd/ef/0123456789abcdef0123456789abcdef01234567/pkg-2.0-py3-none-any.whl",
        ),
        // wheels —— 重定位布局
        (
            "wheels",
            "D:/python-pool/pip/cache/wheels/ff/ee/dd/abcdefabcdefabcdefabcdefabcdefabcdefabcdef12/x-1.0-py3-none-any.whl",
        ),
        // build-temp 正向断言已随 scope 迁移至 tests/python_tmp_safety.rs
        //（%TEMP% 不在本文件任何 detect 根子树内，根锚定 glob 运行时零命中——
        // 见文件头不变量；能力搬家而非删除）。
    ];

    for (expected_id, p) in positives {
        let hits = matching_scopes(&scopes, p);
        assert!(
            hits.contains(expected_id),
            "expected scope `{expected_id}` to match `{p}`, got {hits:?}",
        );
    }

    // ========================================================================
    // 红线断言：以下路径必须不被任何 scope 命中
    //   - CLAUDE.md 通用红线：聊天/账号 DB、db_storage、Msg、账号状态
    //     （Accounts / login / config）、收藏（Favorite）、加密物料（key / crypto）
    //   - pip 特有：配置与凭据、已安装的包本体（--user / 解释器内 / conda env 内）、
    //     venv 本体、selfcheck
    //   - glob 边界：http 桶分支终止于字面量（directory 粒度），桶内文件路径零命中；
    //     wheels 桶 glob 带 /**，桶目录本身零命中（只清内容不整桶）；
    //     %TEMP% 里非 pip- 前缀的内容与 pip-* 构建残留都不归任何 pip scope
    //     （后者已迁移至 python-tmp，见文件头不变量）
    // ========================================================================
    let red_lines: &[&str] = &[
        // —— CLAUDE.md 通用红线 ——
        "C:/Users/test/AppData/Roaming/Tencent/xwechat_files/wxid_abc123/db_storage/message/MSG0.db",
        "C:/Users/test/Documents/WeChat Files/wxid_abc123/Msg/MultiMsg.db",
        "C:/Users/test/AppData/Local/SomeApp/Accounts/login/token.bin",
        "C:/Users/test/AppData/Roaming/Tencent/xwechat_files/wxid_abc123/config/config.data",
        "C:/Users/test/Documents/WeChat Files/wxid_abc123/Favorite/fav.db",
        "C:/Users/test/myproject/db_storage/MMKV/data.db-wal",
        "C:/Users/test/AppData/Local/SomeApp/session.db-shm",
        "C:/Users/test/myproject/key/crypto/keys.pem",
        // —— pip 特有：配置与凭据（镜像 / index token 都在这里）——
        "C:/Users/test/AppData/Roaming/pip/pip.ini",
        "/home/test/.config/pip/pip.conf",
        "C:/Users/test/.pypirc",
        // —— pip 特有：已安装的包本体（research §1.4.1：pinkbin 不碰 user site）——
        "C:/Users/test/.local/lib/python3.10/site-packages/numpy/__init__.py",
        "C:/Users/test/.local/lib/python3.10/site-packages/pip/__init__.py",
        "C:/Users/test/AppData/Roaming/Python/Python310/site-packages/pip/_internal/cli/__init__.py",
        // pip 自己的 vendor 里 cachecontrol/caches/ 名字像 cache，但不是 pip/cache 桶
        "C:/Python310/Lib/site-packages/pip/_vendor/cachecontrol/caches/file_cache.py",
        "C:/Users/test/miniconda3/envs/ml/Lib/site-packages/pip/__init__.py",
        // —— pip 特有：virtualenv 本体 ——
        "C:/Users/test/myproject/.venv/pyvenv.cfg",
        "C:/Users/test/myproject/.venv/Scripts/python.exe",
        // —— pip 特有：selfcheck 不在任何 scope（pip 自维护，purge 也不清）——
        "C:/Users/test/AppData/Local/pip/cache/selfcheck/01ed27be11914c349581551530d7e5b27583a75e3e262dde1f41ebca",
        // —— glob 边界：http / http-v2 分支终止于字面量，桶内文件零命中 ——
        // （防止有人把 glob 改成 /** 用 file 粒度扫出几十万条回收站记录）
        "C:/Users/test/AppData/Local/pip/cache/http/0/0/4/8/0/004806b0fb647e1403e847bbbddba0c566d3ff7f95bd6d6e7b4be0d9",
        "C:/Users/test/AppData/Local/pip/cache/http-v2/0/0/3/7/3/0037123456789abcdef0123456789abcdef01234567",
        // —— glob 边界：wheels 桶只清内容，桶目录本身零命中 ——
        "C:/Users/test/AppData/Local/pip/cache/wheels",
        // —— glob 边界：%TEMP% 里非 pip- 前缀的内容不归任何 pip scope（pip-*
        //    构建残留已迁移至 python-tmp 卡片，见文件头）——
        "C:/Users/test/AppData/Local/Temp/other-app-tmp/data.db",
        "C:/Users/test/AppData/Local/Temp/config/settings.cfg",
        // —— build-temp 迁移红线：pip 的任何 scope 不得再命中 %TEMP%/pip-* ——
        "C:/Users/test/AppData/Local/Temp/pip-install-tmpk9w2xq",
        "C:/Users/test/AppData/Local/Temp/pip-unpack-8f3a1bc0",
        "C:/Users/test/AppData/Local/Temp/pip-wheel-5d1c0e77",
        "/tmp/pip-build-9021af",
        "/var/tmp/pip-install-cc11",
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
        "pip.toml glob hit red lines:\n  {}",
        violations.join("\n  ")
    );
}

#[test]
fn pip_detect_and_match() {
    set_fixture_env();

    let scaffold = load_pip();
    let scaffolds = vec![scaffold];

    // 默认路径命中（Windows %LOCALAPPDATA% / Linux ${HOME}/.cache / macOS Library）
    for p in [
        "C:/Users/test/AppData/Local/pip/cache",
        "/home/test/.cache/pip",
        "/home/test/Library/Caches/pip",
    ] {
        assert_eq!(
            pinkbin_scaffold::detect_for(&scaffolds, Path::new(p)).as_deref(),
            Some("pip"),
            "default detect missed `{p}`",
        );
    }

    // ** 通配兜底：重定位到别的盘的 Windows 布局
    assert_eq!(
        pinkbin_scaffold::detect_for(&scaffolds, Path::new("E:/python-pool/pip/cache")).as_deref(),
        Some("pip"),
        "wildcard detect missed relocated pip cache",
    );

    // 基名含 "pip" 但没有 cache/ 子目录：[match].must_have_child 拦截
    // （fixture 根 C:/Users/test 在测试机上不存在，子目录探测必然失败）
    assert_eq!(
        pinkbin_scaffold::detect_for(&scaffolds, Path::new("C:/Users/test/pipx")).as_deref(),
        None,
        "basename-only `pip` fragment must not tag a dir without cache/ child",
    );

    // 完全无关目录不标
    assert_eq!(
        pinkbin_scaffold::detect_for(&scaffolds, Path::new("C:/Users/test/myproject")).as_deref(),
        None,
        "unrelated dir must not be tagged as pip",
    );
}
