//! Regression test for `scaffolds/conda.toml`: every scope glob must match the
//! **directories** it targets (all three scopes are now directory-granularity),
//! and **must not** match conda red lines (the conda root itself, base env
//! binaries / packages / metadata, user config, environments.txt, conda CLI
//! shims). Globs are anchored to conda root names
//! ({anaconda3,miniconda3,miniforge3,.conda}) so `unused-packages`'s broad
//! `**/pkgs/*` doesn't false-positive on user-custom pkgs_dirs inside an env.
//!
//! Directory granularity safety: at runtime, find_matching_dirs prunes any
//! candidate whose ancestor is also matched (so `pkgs/numpy/info` doesn't
//! get queued separately when `pkgs/numpy` already wins) and unconditionally
//! drops `path == root` so a misconfigured glob can't recycle the whole conda
//! install. envs-stale further narrows by `env_filter` (UI-selected env names)
//! at runtime; this test only covers the glob layer.

use std::path::PathBuf;

fn workspace_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop(); // out of crates/scaffold
    p.pop(); // out of crates
    p
}

fn load_conda() -> pinkbin_scaffold::Scaffold {
    let path = workspace_root().join("scaffolds/conda.toml");
    let text = std::fs::read_to_string(&path).expect("read conda.toml");
    toml::from_str(&text).expect("parse conda.toml")
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
fn conda_globs_are_safe() {
    std::env::set_var("USERPROFILE", "C:/Users/test");
    std::env::set_var("HOME", "/home/test");

    let scaffold = load_conda();
    let scopes: Vec<(String, globset::GlobSet)> = scaffold
        .scopes
        .iter()
        .map(|s| (s.id.clone(), build_set(&expand(&s.glob))))
        .collect();

    // ========================================================================
    // 正向：每个 scope 至少一条命中**目录**路径（directory granularity）
    // ========================================================================
    let positives: &[(&str, &str)] = &[
        // tarballs — pkgs/cache 目录本身
        ("tarballs", "C:/Users/test/miniconda3/pkgs/cache"),
        ("tarballs", "C:/Users/test/anaconda3/pkgs/cache"),
        ("tarballs", "/home/test/miniforge3/pkgs/cache"),
        ("tarballs", "C:/Users/test/.conda/pkgs/cache"),
        // unused-packages — pkgs 二级子目录（每个包 + cache 也算重叠 OK）
        (
            "unused-packages",
            "C:/Users/test/miniconda3/pkgs/numpy-1.24.0-py310",
        ),
        (
            "unused-packages",
            "C:/Users/test/anaconda3/pkgs/scipy-1.11.0",
        ),
        ("unused-packages", "/home/test/anaconda3/pkgs/torch-2.0"),
        ("unused-packages", "C:/Users/test/miniconda3/pkgs/cache"), // 重叠 tarballs，OK
        // envs-stale — envs 二级子目录
        ("envs-stale", "C:/Users/test/miniconda3/envs/tf-old"),
        ("envs-stale", "C:/Users/test/anaconda3/envs/exp-2024"),
        ("envs-stale", "/home/test/miniconda3/envs/scratch"),
        ("envs-stale", "C:/Users/test/.conda/envs/dev"),
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
    //   - **conda root 自身**（最危险 —— 命中 = recycle 整个 conda 安装）
    //   - base env 自身（位于 <conda-root>/ 而非 envs/ 下）：python.exe / 包 / 元数据
    //   - 用户配置：.condarc / .conda/environments.txt
    //   - conda 自身的 CLI 与激活脚本
    //   - "site-packages" 含 "packages" 但不是 "pkgs"——unused-packages 的 glob
    //     绝不能因 substring 误命中 site-packages 下的文件
    // ========================================================================
    let red_lines: &[&str] = &[
        // conda root 自身（directory granularity 下任何 scope 命中 root = 灾难）
        "C:/Users/test/miniconda3",
        "C:/Users/test/anaconda3",
        "/home/test/miniforge3",
        "C:/Users/test/.conda",
        // base env binaries (in conda root, not under envs/)
        "C:/Users/test/miniconda3/python.exe",
        "C:/Users/test/miniconda3/Scripts/conda.exe",
        "C:/Users/test/miniconda3/Scripts/pip.exe",
        "C:/Users/test/miniconda3/condabin/conda.bat",
        "C:/Users/test/anaconda3/python.exe",
        "C:/Users/test/anaconda3/condabin/conda.bat",
        "/home/test/miniforge3/bin/python",
        "/home/test/miniforge3/bin/conda",
        // base env metadata / packages
        "C:/Users/test/miniconda3/conda-meta/history",
        "C:/Users/test/miniconda3/conda-meta/numpy-1.24.0-py310.json",
        "C:/Users/test/anaconda3/conda-meta/history",
        // base env site-packages — 'site-packages' contains 'packages' but is NOT 'pkgs'
        "C:/Users/test/miniconda3/Lib/site-packages/conda/__init__.py",
        "C:/Users/test/miniconda3/Lib/site-packages/numpy/__init__.py",
        "C:/Users/test/anaconda3/Lib/site-packages/scipy/__init__.py",
        "/home/test/anaconda3/lib/python3.10/site-packages/conda/__init__.py",
        // base env 顶层目录本身（directory granularity 下不能命中）
        "C:/Users/test/miniconda3/Lib",
        "C:/Users/test/miniconda3/Lib/site-packages",
        "C:/Users/test/miniconda3/Scripts",
        "C:/Users/test/miniconda3/conda-meta",
        // 激活脚本 / 钩子
        "C:/Users/test/miniconda3/etc/conda/activate.d/env_vars.sh",
        "C:/Users/test/miniconda3/etc/conda/deactivate.d/cleanup.sh",
        // 用户配置（在 conda root 之外）
        "C:/Users/test/.condarc",
        "/home/test/.condarc",
        // .conda/environments.txt 是 conda 维护的 env 路径注册表
        "C:/Users/test/.conda/environments.txt",
        "/home/test/.conda/environments.txt",
        // 用户工程里的"虚假 pkgs"关键字
        "C:/Users/test/Documents/my-project/site-packages/foo.py",
        "C:/Users/test/AppData/Local/some-app/local-pkgs/cache/bar.dat",
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
        "conda.toml glob hit red lines:\n  {}",
        violations.join("\n  ")
    );
}
