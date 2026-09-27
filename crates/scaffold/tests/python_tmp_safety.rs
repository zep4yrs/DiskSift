//! Safety test for `scaffolds/python-tmp.toml`：承接 pip.toml 原 build-temp scope
//! （能力搬家：pip 的 detect 根是 pip cache 目录，%TEMP% 不在其任何 detect 根的
//! 子树内，根锚定 {%TEMP%/pip-*,...} 运行时永远零命中——2026-09-27 复核发现的
//! 死 scope）。依据 docs/research/python-dev-cleanup-landscape.md §1.4.2（pip 不
//! 自清构建临时目录：pypa/pip#420 / #939 / #2892 / #12868）+ §1.5（独立成
//! python-tmp，P0）。本文件断言：
//!
//! 1. 正向：build-temp glob `**/pip-*` 必须命中 %TEMP%（/tmp、/var/tmp）里的
//!    pip-* 构建临时目录，且每条正向路径都是某个 detect 根的严格后代（机械断言）；
//! 2. 红线：临时目录里非 pip- 前缀的一切（其它工具临时目录、*.db、config、
//!    收藏、加密物料、venv 本体、已安装的包、.git）必须零命中；临时目录本身
//!    （扫描根）零命中。
//!
//! 运行时可达不变量（2026-09-27 复核新增）：每个 scope 的正向断言路径必须是某个
//! detect 根的**严格后代**——运行时 scope 匹配总是以 detect 命中的目录为扫描根
//! （CleanupModal.tsx 把每个 m.path 传给 scopeSizes / executeScope），且
//! find_matching_dirs 无条件丢弃 path == root（apps/desktop/src-tauri/src/lib.rs
//! 的防整根误删保护）。根不可达的正向断言视为无效。python-tmp 的 detect 展开后
//! 全是字面量路径，本文件用 assert_positive_paths_are_reachable 做机械断言；
//! pip / pnpm 的 detect 含 `**` 通配兜底，那两份测试以注释标注同一不变量。

use std::path::{Path, PathBuf};

const SCAFFOLD_FILE: &str = "scaffolds/python-tmp.toml";

fn workspace_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop(); // out of crates/scaffold
    p.pop(); // out of crates
    p
}

fn load_python_tmp() -> pinkbin_scaffold::Scaffold {
    let path = workspace_root().join(SCAFFOLD_FILE);
    let text = std::fs::read_to_string(&path).expect("read python-tmp.toml");
    toml::from_str(&text).expect("parse python-tmp.toml")
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

/// Mirror scaffold::expand_env for `%VAR%`-style substitution（${TMPDIR} 归
/// shellexpand 管：未设置时整体回退为字面量死分支——fixture 显式移除 TMPDIR，
/// 分支死得确定；运行时 macOS 恒设置 TMPDIR，分支在该平台是活的，见 toml 注释）。
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
    // TMPDIR 显式移除：Linux CI 会带值进来，导致 ${TMPDIR} 分支在测试里时活时死。
    std::env::remove_var("TMPDIR");
}

/// 运行时可达不变量的机械断言：python-tmp 的 detect 展开后全是字面量路径，
/// 每条正向路径必须是某个 detect 根的严格后代（运行时以 detect 根为扫描根，
/// find_matching_dirs 丢 path == root；等于根或游离于根外都算不可达）。
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
fn python_tmp_globs_are_safe() {
    set_fixture_env();

    let scaffold = load_python_tmp();
    let scopes: Vec<(String, globset::GlobSet)> = scaffold
        .scopes
        .iter()
        .map(|s| (s.id.clone(), build_set(&expand(&s.glob))))
        .collect();

    // ========================================================================
    // 正向断言：每个 scope id 至少一条命中路径；每条路径都是某个 detect 根
    // （%TEMP% / %TMP% / /tmp / /var/tmp / $TMPDIR）的严格后代（机械断言见下）。
    // ========================================================================
    let positives: &[(&str, &str)] = &[
        // build-temp —— Windows：%TEMP% / %TMP%（fixture 同值）里的 pip-<verb>-<random>
        (
            "build-temp",
            "C:/Users/test/AppData/Local/Temp/pip-install-tmpk9w2xq",
        ),
        (
            "build-temp",
            "C:/Users/test/AppData/Local/Temp/pip-unpack-8f3a1bc0",
        ),
        // build-temp —— `*` 跨段（literal_separator(false)）：pip-* 目录内的深层
        // 路径同样命中；运行时 find_matching_dirs 的祖先剪枝保证每个临时目录只
        // 入队一次（浅者胜）。
        (
            "build-temp",
            "C:/Users/test/AppData/Local/Temp/pip-install-tmpk9w2xq/site/x/y.whl.part",
        ),
        // build-temp —— /tmp、/var/tmp 字面量分支（Linux 默认；macOS 走 $TMPDIR）
        ("build-temp", "/tmp/pip-build-9021af"),
        ("build-temp", "/var/tmp/pip-install-cc11"),
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
    //   - 临时目录本身（扫描根——find_matching_dirs 无条件丢 path == root，
    //     glob 也必须匹配不到根，正向全靠根内内容）
    //   - %TEMP% 里非 pip- 前缀的一切：其它工具的临时目录（pytest / npm /
    //     systemd）、*.db / config / 收藏 / 加密物料（CLAUDE.md 通用红线）
    //   - glob 边界：含 "pip" 但无 "pip-" 的名字（pipboy）零命中
    //   - venv 本体、已安装的包本体、.git（research §1.5 蓝图红线）；
    //     __pycache__ 等开发目录缓存属后续 scope，本 scaffold 不清
    // ========================================================================
    let red_lines: &[&str] = &[
        // —— 扫描根本身零命中 ——
        "C:/Users/test/AppData/Local/Temp",
        "/tmp",
        "/var/tmp",
        // —— %TEMP% 里非 pip- 前缀的一切 ——
        "C:/Users/test/AppData/Local/Temp/other-app-tmp/data.db",
        "C:/Users/test/AppData/Local/Temp/config/settings.cfg",
        "C:/Users/test/AppData/Local/Temp/pytest-of-user/pytest-42/test_foo.py",
        "C:/Users/test/AppData/Local/Temp/npm-cache/_cacache/index.json",
        "/tmp/systemd-private-1a2b/app.service",
        // —— glob 边界："pip" 后无连字符 ——
        "C:/Users/test/AppData/Local/Temp/pipboy/data.db",
        // —— CLAUDE.md 通用红线 ——
        "C:/Users/test/Documents/WeChat Files/wxid_abc123/Msg/MultiMsg.db",
        "C:/Users/test/AppData/Local/SomeApp/Accounts/login/token.bin",
        "C:/Users/test/Documents/WeChat Files/wxid_abc123/Favorite/fav.db",
        "C:/Users/test/myproject/key/crypto/keys.pem",
        // —— research §1.5 蓝图红线：源码仓库、venv 本体、已安装的包本体 ——
        "C:/Users/test/myproject/.git/objects/ab/cd0123456789abcdef0123456789abcdef01234567",
        "C:/Users/test/myproject/.venv/pyvenv.cfg",
        "C:/Users/test/.local/lib/python3.10/site-packages/numpy/__init__.py",
        // —— 后续 scope（research §1.5 caches）尚未实现：__pycache__ 不归本卡 ——
        "C:/Users/test/myproject/src/__pycache__/mod.cpython-310.pyc",
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
        "python-tmp.toml glob hit red lines:\n  {}",
        violations.join("\n  ")
    );
}

#[test]
fn python_tmp_detect_and_match() {
    set_fixture_env();

    let scaffold = load_python_tmp();
    let scaffolds = vec![scaffold];

    // detect 覆盖临时目录本身——运行时扫描根即由此而来（能力搬家后的正向入口）。
    for p in [
        "C:/Users/test/AppData/Local/Temp",
        "C:/users/test/appdata/local/temp", // Windows 实际大小写不定
        "/tmp",
        "/var/tmp",
    ] {
        assert_eq!(
            pinkbin_scaffold::detect_for(&scaffolds, Path::new(p)).as_deref(),
            Some("python-tmp"),
            "detect missed `{p}`",
        );
    }

    // ${TMPDIR} 在 fixture 中被移除 → 该 detect 分支回退为字面量死分支，不得产生
    // 任何误标（死 detect 分支只是少标一张卡；macOS 运行时 TMPDIR 恒被设置，
    // 分支是活的——见 python-tmp.toml 注释）。
    assert_eq!(
        pinkbin_scaffold::detect_for(&scaffolds, Path::new("C:/Users/test/myproject")).as_deref(),
        None,
        "unrelated dir must not be tagged as python-tmp",
    );
    // pip cache 根归 pip 卡片，python-tmp 不认（两卡 detect 无重叠）。
    assert_eq!(
        pinkbin_scaffold::detect_for(
            &scaffolds,
            Path::new("C:/Users/test/AppData/Local/pip/cache")
        )
        .as_deref(),
        None,
        "pip cache root must not be tagged as python-tmp",
    );
}
