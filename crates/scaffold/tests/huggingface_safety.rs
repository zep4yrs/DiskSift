//! Safety test for `scaffolds/huggingface.toml`：2026-05-05 被裁撤的 legacy
//! huggingface scaffold（无 safety test）的重做版断言。本卡清 Hugging Face 的
//! hub 下载缓存（models--* / datasets--* 整仓）与 datasets 库的 Arrow 处理缓存
//! （含 downloads/）。本文件断言：
//!
//! 1. 正向：两个 scope 必须命中默认根（%USERPROFILE%/.cache/huggingface、
//!    ${HOME}/.cache/huggingface）下的整仓/整数据集单元，且每条正向路径都是某个
//!    detect 根的严格后代（机械断言，python_tmp_safety.rs 同款）；HF_HOME 重定位
//!    根（如 D:/models/huggingface）的正向断言单列——运行时可达性来自 [match]
//!    兜底（name_contains=huggingface + must_have_child=hub 的文件系统探测），
//!    fixture 无法凭空造出 hub/ 子目录，机械断言只覆盖固定 detect 根；
//! 2. 红线：登录令牌（token / stored_tokens / legacy ~/.huggingface）、modules/
//!    脚本缓存、hub/ 直下 version.txt 与 .locks/、CLAUDE.md 通用红线放在缓存根
//!    下"未点名位置"（*.db / Accounts / config / login / Favorite / key /
//!    crypto）、hub 与 datasets 两个桶根自身、跨工具隔离（torch hub、
//!    @huggingface JS 包）、segment 精确性（my-huggingface-cache 不是 HF 根）。
//!
//! 运行时可达不变量：运行时 scope 匹配总是以 detect/[match] 命中的目录为扫描根
//! （CleanupModal.tsx 把每个 m.path 传给 scopeSizes / executeScope）。
//!
//! 主机无 HF 缓存（2026-09-28 勘测，见 huggingface.toml 文件头）：布局依据
//! huggingface_hub / datasets 官方文档；正负样本都是文档布局下的代表性路径。

use std::path::{Path, PathBuf};

const SCAFFOLD_FILE: &str = "scaffolds/huggingface.toml";

fn workspace_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop(); // out of crates/scaffold
    p.pop(); // out of crates
    p
}

fn load_huggingface() -> pinkbin_scaffold::Scaffold {
    let path = workspace_root().join(SCAFFOLD_FILE);
    let text = std::fs::read_to_string(&path).expect("read huggingface.toml");
    toml::from_str(&text).expect("parse huggingface.toml")
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
/// 语义（本卡 detect 含 ${HOME}，机械可达性断言要能展开它；HOME 由 fixture 固定）。
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

/// 运行时可达不变量的机械断言：huggingface 的固定 detect 展开后全是字面量路径，
/// 每条正向路径必须是某个 detect 根的严格后代（运行时以 detect 根为扫描根，
/// find_matching_dirs 丢 path == root）。[match] 重定位根的正向断言不进本检查
/// （可达性来自文件系统探测，fixture 无法模拟），单列在 fallback 正向组里。
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
fn huggingface_globs_are_safe() {
    set_fixture_env();

    let scaffold = load_huggingface();
    let scopes: Vec<(String, globset::GlobSet)> = scaffold
        .scopes
        .iter()
        .map(|s| (s.id.clone(), build_set(&expand(&s.glob))))
        .collect();

    // ========================================================================
    // 正向断言（固定 detect 根）：每个 scope id 至少一条命中路径；每条路径都是
    // %USERPROFILE%/.cache/huggingface 或 ${HOME}/.cache/huggingface 的严格后代
    //（机械断言见下）。
    // ========================================================================
    let positives: &[(&str, &str)] = &[
        // hub-cache —— Windows 默认根，整仓单元（directory granularity 的入队单位）
        (
            "hub-cache",
            "C:/Users/test/.cache/huggingface/hub/models--bert-base-uncased",
        ),
        // hub-cache —— 仓内深层路径（`*` 跨段；运行时 find_matching_dirs 剪枝到
        // 最浅匹配，整仓一条回收站记录，理由同 python-tmp）
        (
            "hub-cache",
            "C:/Users/test/.cache/huggingface/hub/models--bert-base-uncased/snapshots/0f39a7cd/config.json",
        ),
        // hub-cache —— hub 数据集仓（datasets--* 同为整仓单元）
        (
            "hub-cache",
            "/home/test/.cache/huggingface/hub/datasets--rajpurkar--squad",
        ),
        // arrow-datasets —— <ns>___<name> 整数据集单元
        (
            "arrow-datasets",
            "C:/Users/test/.cache/huggingface/datasets/wikimedia___wikipedia",
        ),
        // arrow-datasets —— downloads/ 原始下载件整目录（HF 官方认可可再生）
        (
            "arrow-datasets",
            "C:/Users/test/.cache/huggingface/datasets/downloads",
        ),
        // arrow-datasets —— 数据集内深层 arrow 文件（同剪枝语义）
        (
            "arrow-datasets",
            "/home/test/.cache/huggingface/datasets/wikimedia___wikipedia/20231101.en/0.0.0/61a5fd0b/wikipedia-train.arrow",
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

    // ========================================================================
    // 正向断言（[match] 重定位根）：HF_HOME 搬到数据盘、根名仍叫 huggingface。
    // 运行时可达性来自 name_contains + must_have_child=hub 的文件系统探测
    // （fixture 造不出真实子目录，见 huggingface_detect_and_match 的负向验证），
    // 因此只断言 glob 层命中，不进机械可达性检查。
    // ========================================================================
    let fallback_positives: &[(&str, &str)] = &[
        (
            "hub-cache",
            "D:/models/huggingface/hub/models--Qwen--Qwen2.5-7B",
        ),
        ("arrow-datasets", "D:/models/huggingface/datasets/downloads"),
    ];
    for (expected_id, p) in fallback_positives {
        let hits = matching_scopes(&scopes, p);
        assert!(
            hits.contains(expected_id),
            "expected scope `{expected_id}` to match relocated cache `{p}`, got {hits:?}",
        );
    }

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
    //   - 登录凭据：token / stored_tokens（hf auth login）、legacy ~/.huggingface
    //     （旧版凭据目录，本卡不 detect）
    //   - modules/ 数据集脚本缓存（小、本卡不碰）
    //   - hub/ 直下 version.txt 与 .locks/（下载进行中的锁，非整仓单元）
    //   - CLAUDE.md 通用红线：*.db / db_storage / Accounts / config / login /
    //     Favorite / key / crypto 放在缓存根下"未点名位置"，
    //     验证 scope 只命中 hub/{models--*,datasets--*} 与 datasets/* 两类形态
    //   - 桶根自身：hub/ 与 datasets/ 是扫描根内的目录，scope 不整根删
    //   - 跨工具隔离：torch hub checkpoints、@huggingface JS 包、pip/npm 缓存
    //   - segment 精确性：my-huggingface-cache / huggingface.js 邻居不是 HF 根
    // ========================================================================
    let red_lines: &[&str] = &[
        // —— 登录凭据 ——
        "C:/Users/test/.cache/huggingface/token",
        "C:/Users/test/.cache/huggingface/stored_tokens",
        "/home/test/.cache/huggingface/token",
        "/home/test/.cache/huggingface/stored_tokens",
        "/home/test/.huggingface/token",
        // —— modules/（本卡不碰）——
        "C:/Users/test/.cache/huggingface/modules/datasets_modules/datasets/my_script/abc123/__init__.py",
        // —— hub/ 直下杂项：版本戳与下载锁 ——
        "C:/Users/test/.cache/huggingface/hub/version.txt",
        "C:/Users/test/.cache/huggingface/hub/.locks/models--bert-base-uncased/0f39a7cd.lock",
        // —— CLAUDE.md 通用红线：缓存根下未点名位置 ——
        "C:/Users/test/.cache/huggingface/registry.db",
        "C:/Users/test/.cache/huggingface/registry.db-wal",
        "C:/Users/test/.cache/huggingface/registry.db-shm",
        "C:/Users/test/.cache/huggingface/db_storage/MMKV/data.db",
        "C:/Users/test/.cache/huggingface/All Users/profile.dat",
        "C:/Users/test/.cache/huggingface/Accounts/state.json",
        "C:/Users/test/.cache/huggingface/config/settings.json",
        "C:/Users/test/.cache/huggingface/login/session.dat",
        "C:/Users/test/.cache/huggingface/Favorite/bookmarks.json",
        "C:/Users/test/.cache/huggingface/key/registry.key",
        "C:/Users/test/.cache/huggingface/crypto/material.pem",
        "/home/test/.cache/huggingface/Accounts/state.json",
        "/home/test/.cache/huggingface/config/settings.json",
        "/home/test/.cache/huggingface/login/session.dat",
        "/home/test/.cache/huggingface/Favorite/bookmarks.json",
        "/home/test/.cache/huggingface/key/registry.key",
        "/home/test/.cache/huggingface/crypto/material.pem",
        // —— 桶根自身（scope 只清桶内的整仓/整数据集单元）——
        "C:/Users/test/.cache/huggingface/hub",
        "C:/Users/test/.cache/huggingface/datasets",
        "C:/Users/test/.cache/huggingface",
        // —— 跨工具隔离：torch hub / sentence-transformers / 其它包管理器 ——
        "C:/Users/test/.cache/torch/hub/checkpoints/resnet50-19c8e357.pth",
        "C:/Users/test/.cache/torch/sentence_transformers/sbert_models/model",
        "C:/Users/test/AppData/Local/pip/cache/http/index.json",
        "C:/Users/test/AppData/Local/npm-cache/_cacache/index-v5/ab/cd",
        // —— segment 精确性：JS 生态与自定义名字的邻居 ——
        "C:/Users/test/Projects/webapp/node_modules/@huggingface/hub/dist/index.js",
        "C:/Users/test/Projects/webapp/node_modules/huggingface.js/dist/index.js",
        "C:/Users/test/Projects/my-huggingface-cache/hub/models--org--name",
        "D:/models/my-huggingface/hub/models--org--name",
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
        "huggingface.toml glob hit red lines:\n  {}",
        violations.join("\n  ")
    );
}

#[test]
fn huggingface_detect_and_match() {
    set_fixture_env();

    let scaffold = load_huggingface();
    let scaffolds = vec![scaffold];

    // 固定 detect 根命中——运行时扫描根即由此而来。
    for p in [
        "C:/Users/test/.cache/huggingface",
        "c:/users/test/.cache/huggingface", // Windows 实际大小写不定
        "/home/test/.cache/huggingface",
    ] {
        assert_eq!(
            pinkbin_scaffold::detect_for(&scaffolds, Path::new(p)).as_deref(),
            Some("huggingface"),
            "detect missed `{p}`",
        );
    }

    // [match] 兜底的负向侧：基名含 "huggingface" 但没有 hub/ 子目录的目录不得标
    // （fixture 根 C:/Users/test 在测试机上不存在，must_have_child 探测必然失败
    // ——pip_safety.rs 同款手法）。
    for p in [
        "C:/Users/test/huggingface",
        "C:/Users/test/Projects/my-huggingface",
    ] {
        assert_eq!(
            pinkbin_scaffold::detect_for(&scaffolds, Path::new(p)).as_deref(),
            None,
            "basename-only `huggingface` fragment must not tag a dir without hub/ child: `{p}`",
        );
    }

    // 完全无关目录与相邻工具的缓存根不标。
    for p in [
        "C:/Users/test/myproject",
        "C:/Users/test/.cache/torch",
        "C:/Users/test/AppData/Local/pip/cache",
        "C:/Users/test/AppData/Local/npm-cache",
    ] {
        assert_eq!(
            pinkbin_scaffold::detect_for(&scaffolds, Path::new(p)).as_deref(),
            None,
            "unrelated dir `{p}` must not be tagged as huggingface",
        );
    }
}
