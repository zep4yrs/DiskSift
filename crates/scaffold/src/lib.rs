//! Loads scaffold TOML manifests and matches them against folders.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Scaffold {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub homepage: Option<String>,
    pub risk: Risk,
    pub disclaimer: String,
    pub detect: Vec<String>,
    #[serde(rename = "match", default)]
    pub matcher: Match,
    // TOML uses `[[scope]]` blocks (singular) — keep that for authoring ergonomics.
    // JSON to the frontend uses `scopes` (plural) so it matches the TS Scaffold type.
    #[serde(
        rename(deserialize = "scope", serialize = "scopes"),
        alias = "scopes",
        default
    )]
    pub scopes: Vec<Scope>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Match {
    #[serde(default)]
    pub name_contains: Vec<String>,
    #[serde(default)]
    pub must_have_child: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Scope {
    pub id: String,
    pub label: String,
    pub glob: String,
    pub mode: Mode,
    #[serde(default)]
    pub prompt: Option<Prompt>,
    /// "cache" | "media" | "backup". `None` is treated by the UI as "cache".
    /// Drives Studio's grouping: media → top, cache → merged into one button,
    /// backup → bottom.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// Optional product-version tag (e.g. "3.x" / "4.x" for WeChat). When set,
    /// the UI hides this scope unless the variant is detected in the matched
    /// paths — keeps obsolete-version buckets out of sight without deleting
    /// them from the scaffold.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    /// "file" (default) → glob matches files, recycle file-by-file (one
    /// Recycle Bin entry per file). Right for media buckets where each file
    /// is meaningful (chat images, log files).
    /// "directory" → glob matches **directories**, recycle each as a single
    /// unit (one Recycle Bin entry per dir). Required for any scope that
    /// targets thousands of small files in self-contained subdirs (conda
    /// pkgs/<pkg>, conda envs/<name>, node_modules/, cargo target/) — the
    /// per-file path would create thousands of Recycle Bin entries and take
    /// minutes; per-directory creates one entry per logical unit.
    #[serde(default)]
    pub recycle_granularity: RecycleGranularity,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RecycleGranularity {
    #[default]
    File,
    Directory,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Recycle,
    Quarantine,
    Delete,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Prompt {
    None,
    Days {
        default: u32,
        #[serde(default)]
        label: Option<String>,
    },
    Bytes {
        default: u64,
        #[serde(default)]
        label: Option<String>,
    },
    Choice {
        default: String,
        options: Vec<String>,
        #[serde(default)]
        label: Option<String>,
    },
    Confirm {
        #[serde(default)]
        label: Option<String>,
    },
}

pub fn parse_toml(s: &str) -> anyhow::Result<Scaffold> {
    Ok(toml::from_str::<Scaffold>(s)?)
}

pub fn load_dir(dir: &Path) -> anyhow::Result<Vec<Scaffold>> {
    let mut out = Vec::new();
    if !dir.exists() {
        return Ok(out);
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if entry
            .path()
            .extension()
            .map(|e| e == "toml")
            .unwrap_or(false)
        {
            let text = std::fs::read_to_string(entry.path())?;
            match toml::from_str::<Scaffold>(&text) {
                Ok(s) => out.push(s),
                Err(e) => tracing::warn!("scaffold parse error in {:?}: {}", entry.path(), e),
            }
        }
    }
    Ok(out)
}

pub fn detect_for(scaffolds: &[Scaffold], path: &Path) -> Option<String> {
    let path_norm = norm(&path.to_string_lossy()).to_lowercase();
    let basename = path
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    for s in scaffolds {
        for d in &s.detect {
            let pat = norm(&expand_env(d)).to_lowercase();
            if let Ok(set) = make_globset(&[pat.as_str()]) {
                if set.is_match(&path_norm) {
                    return Some(s.id.clone());
                }
            }
        }
        if !s.matcher.name_contains.is_empty()
            && s.matcher
                .name_contains
                .iter()
                .any(|n| basename.contains(&n.to_lowercase()))
            && s.matcher
                .must_have_child
                .iter()
                .all(|c| path.join(c).exists())
        {
            return Some(s.id.clone());
        }
    }
    None
}

fn norm(s: &str) -> String {
    s.replace('\\', "/")
}

/// Expand environment variables in a path/glob string, supporting both
/// `$VAR` / `${VAR}` (Unix) and `%VAR%` (Windows) syntax. Used by the scanner
/// for `detect` patterns and by callers that want to evaluate scope `glob`s.
pub fn expand_env(s: &str) -> String {
    let unix = shellexpand::env(s)
        .map(|c| c.into_owned())
        .unwrap_or_else(|_| s.to_string());
    expand_winpct(&unix)
}

fn expand_winpct(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        let mut name = String::new();
        let mut closed = false;
        while let Some(&nc) = chars.peek() {
            chars.next();
            if nc == '%' {
                closed = true;
                break;
            }
            name.push(nc);
        }
        if closed {
            match std::env::var(&name) {
                Ok(v) => out.push_str(&v),
                Err(_) => {
                    out.push('%');
                    out.push_str(&name);
                    out.push('%');
                }
            }
        } else {
            out.push('%');
            out.push_str(&name);
        }
    }
    out
}

fn make_globset(patterns: &[&str]) -> anyhow::Result<globset::GlobSet> {
    let mut b = globset::GlobSetBuilder::new();
    for p in patterns {
        let g = globset::GlobBuilder::new(p)
            .literal_separator(false)
            .case_insensitive(true)
            .build()?;
        b.add(g);
    }
    Ok(b.build()?)
}

/// Pre-compiled form of a `Scaffold` for hot-path matching. Holds the union of
/// all `detect` globs as a single `GlobSet`, plus lower-cased copies of the
/// fragment lists. Callers that need to detect against many paths (e.g. tag
/// every directory in a scan tree) should call `compile_all` once and then
/// `detect_compiled` per path — vs `detect_for`, which rebuilds globsets on
/// every call.
pub struct CompiledScaffold {
    pub id: String,
    detect_globs: globset::GlobSet,
    name_fragments_lc: Vec<String>,
    must_have_child: Vec<String>,
}

/// Compile a list of scaffolds to the matching-friendly form. Each `detect`
/// pattern is compiled individually and added to the union GlobSet only if
/// well-formed — matching `detect_for`'s "skip the bad one, keep the rest"
/// behavior. A single broken pattern must not disable the whole scaffold.
pub fn compile_all(scaffolds: &[Scaffold]) -> Vec<CompiledScaffold> {
    scaffolds
        .iter()
        .map(|s| {
            let mut builder = globset::GlobSetBuilder::new();
            let mut accepted: Vec<String> = Vec::with_capacity(s.detect.len());
            for d in &s.detect {
                let pat = norm(&expand_env(d)).to_lowercase();
                match globset::GlobBuilder::new(&pat)
                    .literal_separator(false)
                    .case_insensitive(true)
                    .build()
                {
                    Ok(g) => {
                        builder.add(g);
                        accepted.push(pat);
                    }
                    Err(e) => {
                        tracing::warn!(
                            "scaffold {}: skipping bad detect pattern {:?}: {}",
                            s.id,
                            d,
                            e
                        );
                    }
                }
            }
            let detect_globs = builder.build().unwrap_or_else(|_| {
                globset::GlobSetBuilder::new()
                    .build()
                    .expect("empty globset")
            });
            tracing::debug!(
                "scaffold {}: compiled detect={:?} name_contains_lc={:?} must_have_child={:?}",
                s.id,
                accepted,
                s.matcher
                    .name_contains
                    .iter()
                    .map(|n| n.to_lowercase())
                    .collect::<Vec<_>>(),
                s.matcher.must_have_child,
            );
            CompiledScaffold {
                id: s.id.clone(),
                detect_globs,
                name_fragments_lc: s
                    .matcher
                    .name_contains
                    .iter()
                    .map(|n| n.to_lowercase())
                    .collect(),
                must_have_child: s.matcher.must_have_child.clone(),
            }
        })
        .collect()
}

/// Same matching semantics as `detect_for`, but uses pre-compiled scaffolds.
/// Returns the first matching scaffold's id, or `None`.
pub fn detect_compiled(compiled: &[CompiledScaffold], path: &Path) -> Option<String> {
    let path_norm_lc = norm(&path.to_string_lossy()).to_lowercase();
    let basename_lc = path
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    for c in compiled {
        if c.detect_globs.is_match(&path_norm_lc) {
            return Some(c.id.clone());
        }
        if !c.name_fragments_lc.is_empty()
            && c.name_fragments_lc.iter().any(|n| basename_lc.contains(n))
            && c.must_have_child
                .iter()
                .all(|child| path.join(child).exists())
        {
            return Some(c.id.clone());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_scaffold() {
        let toml = r#"
id = "demo"
name = "Demo"
risk = "low"
disclaimer = "test"
detect = ["**/Demo"]
[[scope]]
id = "s1"
label = "S1"
glob = "**/*"
mode = "recycle"
"#;
        let s: Scaffold = toml::from_str(toml).unwrap();
        assert_eq!(s.id, "demo");
        assert_eq!(s.scopes.len(), 1);
    }

    #[test]
    fn detect_compiled_matches_simple_recursive_glob() {
        // Reproduce the wechat-pc detect surface as minimally as possible.
        let toml = r#"
id = "wechat-pc"
name = "WeChat (PC)"
risk = "low"
disclaimer = "test"
detect = [
  "**/xwechat_files",
  "**/WeChat Files",
]
[match]
name_contains = ["xwechat_files", "WeChat Files", "xwechat", "WeChat"]
"#;
        let s: Scaffold = toml::from_str(toml).unwrap();
        let compiled = compile_all(&[s]);
        let path = Path::new("C:/Users/lvjin/Documents/xwechat_files");
        assert_eq!(
            detect_compiled(&compiled, path),
            Some("wechat-pc".to_string()),
            "detect_compiled missed `**/xwechat_files` against {:?}",
            path,
        );
    }

    #[test]
    fn detect_compiled_must_isolate_bad_patterns_like_detect_for() {
        // If any single detect pattern fails to compile, compile_all should
        // not nuke the whole scaffold's detect surface — that would diverge
        // from detect_for, which silently skips each bad pattern individually.
        // This guards against regressions where one quirky pattern (e.g. a
        // shell-expansion result containing `[` or `{` in a real user env)
        // poisons every other pattern in the same scaffold.
        let toml = r#"
id = "wechat-pc"
name = "WeChat (PC)"
risk = "low"
disclaimer = "test"
detect = [
  "[invalid-glob",
  "**/xwechat_files",
]
[match]
name_contains = []
"#;
        let s: Scaffold = toml::from_str(toml).unwrap();
        let scaffolds = vec![s];
        let compiled = compile_all(&scaffolds);
        let path = Path::new("C:/Users/lvjin/Documents/xwechat_files");
        assert_eq!(
            detect_compiled(&compiled, path),
            detect_for(&scaffolds, path),
            "compile_all dropped good pattern when sibling pattern is bad",
        );
        assert_eq!(
            detect_compiled(&compiled, path).as_deref(),
            Some("wechat-pc"),
        );
    }

    #[test]
    fn detect_compiled_matches_actual_wechat_toml() {
        // Load the real scaffolds/wechat-pc.toml (same path as production
        // load_dir) and confirm detect_compiled tags a typical 4.x data dir.
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scaffolds/wechat-pc.toml");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {:?} failed: {}", path, e));
        let s: Scaffold = toml::from_str(&text).expect("wechat-pc.toml parse");
        eprintln!(
            "wechat-pc loaded: detect={:?}, name_contains={:?}, must_have_child={:?}",
            s.detect, s.matcher.name_contains, s.matcher.must_have_child,
        );
        let compiled = compile_all(std::slice::from_ref(&s));

        for p in [
            "C:/Users/lvjin/Documents/xwechat_files",
            "C:\\Users\\lvjin\\Documents\\xwechat_files",
            "/some/path/xwechat_files",
        ] {
            let path = Path::new(p);
            let got = detect_compiled(&compiled, path);
            let oracle = detect_for(std::slice::from_ref(&s), path);
            eprintln!("path={:?} compiled={:?} oracle={:?}", p, got, oracle);
            assert_eq!(got, oracle, "divergence at {:?}", p);
            assert_eq!(got.as_deref(), Some("wechat-pc"), "missed at {:?}", p);
        }
    }

    #[test]
    fn detect_compiled_equivalent_to_detect_for_on_wechat_pc() {
        // Full wechat-pc detect/match block, including %VAR% expansion
        // patterns, to verify compile_all isn't silently dropping any pattern.
        let toml = r#"
id = "wechat-pc"
name = "WeChat (PC)"
risk = "low"
disclaimer = "test"
detect = [
  "%USERPROFILE%/Documents/xwechat_files",
  "%USERPROFILE%/Documents/WeChat Files",
  "%APPDATA%/Tencent/xwechat",
  "%APPDATA%/Tencent/WeChat",
  "**/xwechat_files",
  "**/WeChat Files",
]
[match]
name_contains = ["xwechat_files", "WeChat Files", "xwechat", "WeChat"]
"#;
        let s: Scaffold = toml::from_str(toml).unwrap();
        let scaffolds = vec![s];
        let compiled = compile_all(&scaffolds);

        for path_str in [
            "C:/Users/lvjin/Documents/xwechat_files",
            "C:\\Users\\lvjin\\Documents\\xwechat_files",
            "/home/foo/Documents/xwechat_files",
            "C:/Users/lvjin/Documents/WeChat Files",
        ] {
            let path = Path::new(path_str);
            assert_eq!(
                detect_compiled(&compiled, path),
                detect_for(&scaffolds, path),
                "compile_all vs detect_for diverged on {:?}",
                path_str,
            );
        }
    }
}
