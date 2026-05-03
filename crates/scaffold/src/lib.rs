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
    #[serde(rename(deserialize = "scope", serialize = "scopes"), alias = "scopes", default)]
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

pub fn load_dir(dir: &Path) -> anyhow::Result<Vec<Scaffold>> {
    let mut out = Vec::new();
    if !dir.exists() {
        return Ok(out);
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if entry.path().extension().map(|e| e == "toml").unwrap_or(false) {
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
}
