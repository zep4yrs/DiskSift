//! 模板：复制到 crates/scaffold/tests/<id>_safety.rs，把所有 TODO 替换为目标 scaffold 的实际值。
//!
//! 跑：`cargo test -p pinkbin-scaffold --test <id>_safety`
//!
//! 这个测试是把需求文档（docs/scaffold-requirements/<category>.md）里的红线节
//! 变成可执行检查。**红线断言失败 = scaffold glob 写宽了**——回去收紧 glob，
//! 不要放宽测试。

use std::path::PathBuf;

const SCAFFOLD_FILE: &str = "scaffolds/TODO-id.toml";

fn workspace_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop(); // out of crates/scaffold
    p.pop(); // out of crates
    p
}

fn load_scaffold() -> pinkbin_scaffold::Scaffold {
    let path = workspace_root().join(SCAFFOLD_FILE);
    let text = std::fs::read_to_string(&path).expect("read scaffold toml");
    toml::from_str(&text).expect("parse scaffold toml")
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

fn matching_scopes<'a>(
    scopes: &'a [(String, globset::GlobSet)],
    path: &str,
) -> Vec<&'a str> {
    scopes
        .iter()
        .filter_map(|(id, gs)| if gs.is_match(path) { Some(id.as_str()) } else { None })
        .collect()
}

#[test]
fn TODO_id_globs_are_safe() {
    // 固定 env 让测试在所有平台上路径一致。
    std::env::set_var("USERPROFILE", "C:/Users/test");
    std::env::set_var("APPDATA", "C:/Users/test/AppData/Roaming");
    std::env::set_var("LOCALAPPDATA", "C:/Users/test/AppData/Local");
    std::env::set_var("HOME", "/home/test");

    let scaffold = load_scaffold();
    let scopes: Vec<(String, globset::GlobSet)> = scaffold
        .scopes
        .iter()
        .map(|s| (s.id.clone(), build_set(&expand(&s.glob))))
        .collect();

    // ========================================================================
    // 正向断言：每个 scope id 至少一条命中路径
    // ========================================================================
    let positives: &[(&str, &str)] = &[
        // ("scope-id", "C:/Users/test/.../<bucket>/file.dat"),
        // TODO: 给每个 [[scope]] 至少加一条
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
    // 包括：聊天/账号 DB、config/login/Accounts、Favorite/收藏、加密 key、
    //       该应用特有的"看似可清实则不可清"目录
    // ========================================================================
    let red_lines: &[&str] = &[
        // 通用红线（继承 CLAUDE.md）
        // "C:/Users/test/.../wxid_xxx/db_storage/MMKV/data.db",
        // "C:/Users/test/.../config/account.cfg",
        // "C:/Users/test/.../login/auth.dat",
        // 该 app 特有红线
        // TODO: 列出全部红线候选路径
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
        "TODO-id.toml glob hit red lines:\n  {}",
        violations.join("\n  ")
    );
}
