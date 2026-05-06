//! Steam library inspector. Parses Valve KeyValues files (`.acf` app manifests
//! and `libraryfolders.vdf`) into structured metadata so the desktop app can
//! show a "what games do I have, when did I last play, how big" panel without
//! ever touching game files.
//!
//! Hard rule: this crate is **read-only**. Functions only parse text input
//! and read directory listings / metadata. Nothing here writes to disk or
//! shells out to Steam.

use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// KeyValues parser (shared by .acf and .vdf)
// ---------------------------------------------------------------------------

/// A node in a Valve KeyValues tree. Leaves are strings; inner nodes are
/// ordered lists of `(key, value)` pairs (Valve KV preserves order and allows
/// duplicate keys, though we don't currently exercise the latter).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KvValue {
    Str(String),
    Block(Vec<(String, KvValue)>),
}

impl KvValue {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            KvValue::Str(s) => Some(s),
            KvValue::Block(_) => None,
        }
    }

    pub fn as_block(&self) -> Option<&[(String, KvValue)]> {
        match self {
            KvValue::Block(b) => Some(b),
            KvValue::Str(_) => None,
        }
    }
}

/// Find the first `(key, value)` pair whose key matches case-insensitively.
fn find_ci<'a>(entries: &'a [(String, KvValue)], key: &str) -> Option<&'a KvValue> {
    entries
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| v)
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    Quoted(String),
    Open,
    Close,
}

fn tokenize(text: &str) -> Result<Vec<Token>> {
    let mut tokens = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(&c) = chars.peek() {
        match c {
            ' ' | '\t' | '\r' | '\n' => {
                chars.next();
            }
            '/' => {
                chars.next();
                match chars.peek() {
                    Some(&'/') => {
                        // Line comment — skip to end of line.
                        while let Some(&nc) = chars.peek() {
                            chars.next();
                            if nc == '\n' {
                                break;
                            }
                        }
                    }
                    _ => return Err(anyhow!("stray '/' at top level (line comments only)")),
                }
            }
            '{' => {
                chars.next();
                tokens.push(Token::Open);
            }
            '}' => {
                chars.next();
                tokens.push(Token::Close);
            }
            '"' => {
                chars.next();
                let mut s = String::new();
                loop {
                    match chars.next() {
                        None => return Err(anyhow!("unterminated quoted string")),
                        Some('"') => break,
                        Some('\\') => match chars.next() {
                            Some('n') => s.push('\n'),
                            Some('t') => s.push('\t'),
                            Some('\\') => s.push('\\'),
                            Some('"') => s.push('"'),
                            // Unknown escape: keep both chars verbatim — Valve
                            // is loose about what's escaped, especially in
                            // installdir paths like "Counter-Strike\Game" (no,
                            // they actually use forward slash, but be safe).
                            Some(other) => {
                                s.push('\\');
                                s.push(other);
                            }
                            None => return Err(anyhow!("trailing backslash in string")),
                        },
                        Some(c) => s.push(c),
                    }
                }
                tokens.push(Token::Quoted(s));
            }
            _ => {
                // Unquoted identifier — read until whitespace or delimiter.
                let mut s = String::new();
                while let Some(&c) = chars.peek() {
                    if c.is_whitespace() || c == '{' || c == '}' || c == '"' || c == '/' {
                        break;
                    }
                    s.push(c);
                    chars.next();
                }
                if !s.is_empty() {
                    tokens.push(Token::Quoted(s));
                }
            }
        }
    }
    Ok(tokens)
}

fn parse_entries(
    tokens: &mut std::vec::IntoIter<Token>,
    expect_close: bool,
) -> Result<Vec<(String, KvValue)>> {
    let mut entries = Vec::new();
    loop {
        let key = match tokens.next() {
            None => {
                if expect_close {
                    return Err(anyhow!("unexpected EOF, expected closing '}}'"));
                }
                return Ok(entries);
            }
            Some(Token::Close) => {
                if !expect_close {
                    return Err(anyhow!("unexpected '}}' at top level"));
                }
                return Ok(entries);
            }
            Some(Token::Open) => return Err(anyhow!("unexpected '{{' where key was expected")),
            Some(Token::Quoted(s)) => s,
        };
        let value = match tokens.next() {
            None => return Err(anyhow!("expected value after key {:?}", key)),
            Some(Token::Quoted(s)) => KvValue::Str(s),
            Some(Token::Open) => KvValue::Block(parse_entries(tokens, true)?),
            Some(Token::Close) => return Err(anyhow!("unexpected '}}' after key {:?}", key)),
        };
        entries.push((key, value));
    }
}

/// Parse a Valve KeyValues document (used by both `.acf` and `.vdf`) into a
/// flat list of top-level `(key, value)` entries. Most documents have exactly
/// one top-level key (`AppState` or `libraryfolders`), but the format itself
/// allows multiple.
pub fn parse(text: &str) -> Result<Vec<(String, KvValue)>> {
    let tokens = tokenize(text)?;
    parse_entries(&mut tokens.into_iter(), false)
}

// ---------------------------------------------------------------------------
// appmanifest_*.acf
// ---------------------------------------------------------------------------

/// The fields we care about from a single `appmanifest_<appid>.acf`. Only
/// public Steam metadata — never anything from the game's own files.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RawAppManifest {
    pub appid: u32,
    pub name: String,
    pub install_dir: String,
    pub size_on_disk: u64,
    /// Unix seconds. `None` when ACF reports `0` (Steam's "never played /
    /// reinstalled and lost the record" sentinel).
    pub last_played: Option<u64>,
    pub last_updated: Option<u64>,
    pub state_flags: u32,
    pub bytes_to_download: u64,
    pub bytes_downloaded: u64,
}

impl RawAppManifest {
    /// Steam writes `StateFlags = 4` for "fully installed". Anything else is
    /// "needs update / partially downloaded / removing / etc." — we treat
    /// non-4 as a signal the install is incomplete.
    pub fn is_fully_installed(&self) -> bool {
        self.state_flags == 4
    }
}

pub fn parse_appmanifest(text: &str) -> Result<RawAppManifest> {
    let top = parse(text).context("invalid KeyValues syntax in appmanifest")?;
    let app_state = find_ci(&top, "AppState")
        .and_then(KvValue::as_block)
        .ok_or_else(|| anyhow!("missing top-level 'AppState' block"))?;

    let get = |key: &str| -> Option<&str> { find_ci(app_state, key).and_then(KvValue::as_str) };
    let parse_u32 = |key: &str| -> u32 { get(key).and_then(|s| s.parse().ok()).unwrap_or(0) };
    let parse_u64 = |key: &str| -> u64 { get(key).and_then(|s| s.parse().ok()).unwrap_or(0) };

    let appid = parse_u32("appid");
    if appid == 0 {
        return Err(anyhow!("appmanifest missing or invalid appid"));
    }
    let name = get("name").unwrap_or("").to_string();
    let install_dir = get("installdir").unwrap_or("").to_string();
    let size_on_disk = parse_u64("SizeOnDisk");
    let last_played_raw = parse_u64("LastPlayed");
    let last_updated_raw = parse_u64("LastUpdated");
    let state_flags = parse_u32("StateFlags");
    let bytes_to_download = parse_u64("BytesToDownload");
    let bytes_downloaded = parse_u64("BytesDownloaded");

    Ok(RawAppManifest {
        appid,
        name,
        install_dir,
        size_on_disk,
        last_played: (last_played_raw != 0).then_some(last_played_raw),
        last_updated: (last_updated_raw != 0).then_some(last_updated_raw),
        state_flags,
        bytes_to_download,
        bytes_downloaded,
    })
}

// ---------------------------------------------------------------------------
// libraryfolders.vdf
// ---------------------------------------------------------------------------

/// Parse `<steam_root>/config/libraryfolders.vdf` and return every library
/// root path it lists. Steam stores them under indexed keys (`"0"`, `"1"`,
/// ...) inside the top-level `libraryfolders` block; each entry has a
/// `path` field.
pub fn parse_libraryfolders(text: &str) -> Result<Vec<PathBuf>> {
    let top = parse(text).context("invalid KeyValues syntax in libraryfolders.vdf")?;
    let lf = find_ci(&top, "libraryfolders")
        .and_then(KvValue::as_block)
        .ok_or_else(|| anyhow!("missing top-level 'libraryfolders' block"))?;

    let mut roots = Vec::new();
    for (_, v) in lf {
        let entry = match v.as_block() {
            Some(b) => b,
            None => continue,
        };
        if let Some(p) = find_ci(entry, "path").and_then(KvValue::as_str) {
            roots.push(PathBuf::from(p));
        }
    }
    Ok(roots)
}

// ---------------------------------------------------------------------------
// Steam root discovery (cross-platform)
// ---------------------------------------------------------------------------

/// All paths we try when looking for a Steam install on this OS, in priority
/// order. Returned **without** an `is_dir` filter so the empty-state UI can
/// show the user "we looked at all of these" — required by §6.6 of the
/// design doc.
pub fn steam_root_candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();

    #[cfg(windows)]
    {
        if let Some(p) = read_steam_path_from_registry() {
            out.push(p);
        }
        if let Some(pf86) = std::env::var_os("ProgramFiles(x86)") {
            out.push(PathBuf::from(pf86).join("Steam"));
        }
        if let Some(pf) = std::env::var_os("ProgramFiles") {
            out.push(PathBuf::from(pf).join("Steam"));
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(home) = dirs::home_dir() {
            out.push(home.join("Library/Application Support/Steam"));
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Some(home) = dirs::home_dir() {
            out.push(home.join(".steam/steam"));
            out.push(home.join(".local/share/Steam"));
        }
    }

    out
}

pub fn discover_steam_root() -> Option<PathBuf> {
    steam_root_candidates().into_iter().find(|p| p.is_dir())
}

/// Read `HKCU\Software\Valve\Steam\SteamPath` — Steam writes this on every
/// launch (forward-slash form). Skipped on non-Windows builds.
#[cfg(windows)]
fn read_steam_path_from_registry() -> Option<PathBuf> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, REG_SZ,
    };

    let subkey: Vec<u16> = "Software\\Valve\\Steam\0".encode_utf16().collect();
    let value_name: Vec<u16> = "SteamPath\0".encode_utf16().collect();

    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        let res = RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_READ, &mut hkey);
        if res != ERROR_SUCCESS {
            return None;
        }
        let mut buf = [0u16; 512];
        let mut len = (buf.len() * 2) as u32;
        let mut value_type: u32 = 0;
        let res = RegQueryValueExW(
            hkey,
            value_name.as_ptr(),
            std::ptr::null_mut(),
            &mut value_type,
            buf.as_mut_ptr() as *mut u8,
            &mut len,
        );
        let _ = RegCloseKey(hkey);
        if res != ERROR_SUCCESS || value_type != REG_SZ {
            return None;
        }
        // `len` is bytes written, including the trailing NUL.
        let u16_len = (len as usize / 2).saturating_sub(1);
        let s = OsString::from_wide(&buf[..u16_len]);
        Some(PathBuf::from(s))
    }
}

// ---------------------------------------------------------------------------
// Inventory types — frontend-facing schema (mirrored in apps/desktop/src/types.ts).
// ---------------------------------------------------------------------------

/// Forward-slash normalized path string for serialization. Steam stores
/// paths with double-backslash on Windows; we normalize to slashes so the
/// frontend renders them uniformly and so test fixtures don't depend on the
/// host OS path separator.
fn norm_path(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SteamGame {
    pub appid: u32,
    /// English name from ACF (`name` field).
    pub name_en: String,
    /// Localized name. None until the translation pipeline fills it in.
    pub name_cn: Option<String>,
    /// Folder name only (e.g. "Counter-Strike Global Offensive").
    pub install_dir_name: String,
    /// Full normalized path to the install dir.
    pub install_path: String,
    /// Path to the source ACF file — shown as the "citation" in detail rail.
    pub appmanifest_path: String,
    pub size_bytes: u64,
    pub last_played_ts: Option<u64>,
    pub library_root: String,
    pub state_flags: u32,
    pub is_fully_installed: bool,
    /// True when ACF is present but `install_path` doesn't exist on disk.
    pub is_ghost: bool,
    pub default_recommended: bool,
    /// Single-line reason matching §6.5 ("60GB · 8 个月未启动"). None when
    /// not recommended; the UI hides the reason block in that case.
    pub recommendation_reason: Option<String>,
    /// Number of Workshop subdirectories under
    /// `<library>/steamapps/workshop/content/<appid>/`. Cheaply computed
    /// during inspect (one read_dir + count). Detail rail uses this to
    /// decide whether to show the "查看创意工坊" button — the actual size
    /// + per-item mtimes get computed lazily by `list_workshop_items`.
    pub workshop_item_count: u32,
}

/// One Steam Workshop item under a game's `workshop/content/<appid>/`.
/// Returned by `list_workshop_items`, which walks each item dir to compute
/// recursive size + reads folder mtime as a proxy for "last updated by
/// Steam" — Steam doesn't record per-item "last used" anywhere accessible,
/// so the UI must label this as "上次更新", not "上次使用".
#[derive(Debug, Clone, serde::Serialize)]
pub struct WorkshopItem {
    pub id: u64,
    pub size_bytes: u64,
    pub last_modified_ts: u64,
    pub path: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SteamLibrary {
    pub root: String,
    pub games: Vec<SteamGame>,
    pub total_size_bytes: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SteamInventory {
    /// Where we found Steam, or None if we couldn't.
    pub steam_root: Option<String>,
    /// Every path we tried — surfaced to the empty-state UI when None.
    pub candidates_checked: Vec<String>,
    pub libraries: Vec<SteamLibrary>,
}

// ---------------------------------------------------------------------------
// inspect_at / inspect — orchestration
// ---------------------------------------------------------------------------

const SECONDS_PER_MONTH: f64 = 60.0 * 60.0 * 24.0 * 30.4375;

/// Compute (default_recommended, recommendation_reason) per §6.5 of the
/// design doc. `now_secs` is injected so tests can pin time.
fn compute_recommendation(
    size_bytes: u64,
    last_played_ts: Option<u64>,
    is_ghost: bool,
    now_secs: u64,
) -> (bool, Option<String>) {
    if is_ghost {
        return (true, Some("ACF 存在但安装目录缺失".to_string()));
    }
    let size_gb = size_bytes as f64 / 1_000_000_000.0;
    if size_gb < 5.0 {
        return (false, None);
    }
    let months_since: f64 = match last_played_ts {
        None => 12.0, // "never played" treated as 12-month-stale per §6.5
        Some(t) if t >= now_secs => 0.0,
        Some(t) => (now_secs - t) as f64 / SECONDS_PER_MONTH,
    };
    let recommended =
        (size_gb >= 30.0 && months_since >= 6.0) || (size_gb >= 50.0 && months_since >= 3.0);
    if !recommended {
        return (false, None);
    }
    let size_str = if size_gb >= 10.0 {
        format!("{:.0}GB", size_gb)
    } else {
        format!("{:.1}GB", size_gb)
    };
    let time_str = if last_played_ts.is_none() {
        "从未启动".to_string()
    } else {
        let m = months_since as u32;
        if m >= 24 {
            format!("{} 年未启动", m / 12)
        } else if m >= 12 {
            "1 年未启动".to_string()
        } else {
            format!("{} 个月未启动", m.max(1))
        }
    };
    (true, Some(format!("{} · {}", size_str, time_str)))
}

fn now_unix_secs() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Inspect a Steam install at `steam_root`. Pure read-only: parses
/// `.acf` / `.vdf` and checks directory existence for ghost detection.
pub fn inspect_at(steam_root: &Path) -> Result<SteamInventory> {
    inspect_at_with_clock(steam_root, now_unix_secs())
}

/// Test-friendly variant — accept an explicit clock so recommendation
/// strings are deterministic.
pub fn inspect_at_with_clock(steam_root: &Path, now_secs: u64) -> Result<SteamInventory> {
    let library_roots = read_library_roots(steam_root)?;
    let mut libraries = Vec::with_capacity(library_roots.len());
    for lib_root in &library_roots {
        match read_library(lib_root, now_secs) {
            Ok(l) => libraries.push(l),
            Err(e) => {
                tracing::warn!("steam-inspector: skipping library {:?}: {:#}", lib_root, e);
            }
        }
    }
    Ok(SteamInventory {
        steam_root: Some(norm_path(steam_root)),
        candidates_checked: vec![norm_path(steam_root)],
        libraries,
    })
}

fn read_library_roots(steam_root: &Path) -> Result<Vec<PathBuf>> {
    let lf = steam_root.join("config").join("libraryfolders.vdf");
    if lf.is_file() {
        let text =
            std::fs::read_to_string(&lf).with_context(|| format!("read {}", lf.display()))?;
        let parsed = parse_libraryfolders(&text)?;
        if !parsed.is_empty() {
            return Ok(parsed);
        }
    }
    // No libraryfolders.vdf, or it parsed empty — fall back to steam_root
    // itself. Common for fresh installs that haven't added a second library.
    Ok(vec![steam_root.to_path_buf()])
}

fn read_library(lib_root: &Path, now_secs: u64) -> Result<SteamLibrary> {
    let steamapps = lib_root.join("steamapps");
    let mut games = Vec::new();

    if !steamapps.is_dir() {
        return Ok(SteamLibrary {
            root: norm_path(lib_root),
            games,
            total_size_bytes: 0,
        });
    }

    for entry in std::fs::read_dir(&steamapps)
        .with_context(|| format!("read_dir {}", steamapps.display()))?
    {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!("read_dir entry error: {:#}", e);
                continue;
            }
        };
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if !is_appmanifest_filename(name) {
            continue;
        }

        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!("read {} failed: {:#}", path.display(), e);
                continue;
            }
        };
        let raw = match parse_appmanifest(&text) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("parse {} failed: {:#}", path.display(), e);
                continue;
            }
        };

        let install_path = steamapps.join("common").join(&raw.install_dir);
        let is_ghost = !install_path.is_dir();
        let (default_recommended, recommendation_reason) =
            compute_recommendation(raw.size_on_disk, raw.last_played, is_ghost, now_secs);
        let workshop_item_count = count_workshop_items(lib_root, raw.appid);

        games.push(SteamGame {
            appid: raw.appid,
            name_en: raw.name.clone(),
            name_cn: None,
            install_dir_name: raw.install_dir.clone(),
            install_path: norm_path(&install_path),
            appmanifest_path: norm_path(&path),
            size_bytes: raw.size_on_disk,
            last_played_ts: raw.last_played,
            library_root: norm_path(lib_root),
            state_flags: raw.state_flags,
            is_fully_installed: raw.is_fully_installed(),
            is_ghost,
            default_recommended,
            recommendation_reason,
            workshop_item_count,
        });
    }

    let total_size_bytes = games.iter().map(|g| g.size_bytes).sum();
    Ok(SteamLibrary {
        root: norm_path(lib_root),
        games,
        total_size_bytes,
    })
}

/// Cheap workshop-subscription count for the detail-rail summary.
/// Counts immediate subdirectories of
/// `<library>/steamapps/workshop/content/<appid>/`. One read_dir, no recursion.
fn count_workshop_items(library_root: &Path, appid: u32) -> u32 {
    let dir = library_root
        .join("steamapps")
        .join("workshop")
        .join("content")
        .join(appid.to_string());
    let iter = match std::fs::read_dir(&dir) {
        Ok(i) => i,
        Err(_) => return 0,
    };
    let mut count = 0u32;
    for entry in iter.flatten() {
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            count += 1;
        }
    }
    count
}

/// Full workshop-item enumeration for the modal. Walks each item dir for
/// recursive size + reads folder mtime. Run lazily on user click — too
/// slow to do eagerly for every game on every inspect.
pub fn list_workshop_items(library_root: &Path, appid: u32) -> Result<Vec<WorkshopItem>> {
    let dir = library_root
        .join("steamapps")
        .join("workshop")
        .join("content")
        .join(appid.to_string());
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).with_context(|| format!("read_dir {}", dir.display()))? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        let id: u64 = match path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|s| s.parse().ok())
        {
            Some(id) => id,
            // Skip "downloads" etc. — workshop item dirs are always numeric.
            None => continue,
        };
        let size_bytes = dir_size_recursive(&path);
        let last_modified_ts = path
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push(WorkshopItem {
            id,
            size_bytes,
            last_modified_ts,
            path: norm_path(&path),
        });
    }
    Ok(out)
}

fn dir_size_recursive(path: &Path) -> u64 {
    let mut total = 0u64;
    let iter = match std::fs::read_dir(path) {
        Ok(i) => i,
        Err(_) => return 0,
    };
    for entry in iter.flatten() {
        let p = entry.path();
        match entry.metadata() {
            Ok(meta) if meta.is_file() => total += meta.len(),
            Ok(meta) if meta.is_dir() => total += dir_size_recursive(&p),
            _ => {}
        }
    }
    total
}

fn is_appmanifest_filename(name: &str) -> bool {
    let prefix = "appmanifest_";
    let suffix = ".acf";
    if !name.starts_with(prefix) || !name.ends_with(suffix) {
        return false;
    }
    let middle = &name[prefix.len()..name.len() - suffix.len()];
    // Empty appid ("appmanifest_.acf") is not a real Steam manifest; reject it.
    !middle.is_empty() && middle.chars().all(|c| c.is_ascii_digit())
}

/// Top-level: discover Steam, inspect if found. When not found, returns an
/// inventory with `steam_root: None` and `candidates_checked` populated so
/// the empty-state UI can show "we looked at these paths".
pub fn inspect() -> Result<SteamInventory> {
    let candidates = steam_root_candidates();
    let candidates_norm: Vec<String> = candidates.iter().map(|p| norm_path(p)).collect();
    let root = candidates.into_iter().find(|p| p.is_dir());
    match root {
        Some(r) => {
            let mut inv = inspect_at(&r)?;
            inv.candidates_checked = candidates_norm;
            Ok(inv)
        }
        None => Ok(SteamInventory {
            steam_root: None,
            candidates_checked: candidates_norm,
            libraries: Vec::new(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_kv() {
        let kv = parse(r#""k" "v""#).unwrap();
        assert_eq!(kv.len(), 1);
        assert_eq!(kv[0].0, "k");
        assert_eq!(kv[0].1.as_str(), Some("v"));
    }

    #[test]
    fn parses_nested_block() {
        let kv = parse(r#""outer" { "k" "v" "n" { "x" "y" } }"#).unwrap();
        let outer = kv[0].1.as_block().unwrap();
        assert_eq!(outer[0].0, "k");
        assert_eq!(outer[0].1.as_str(), Some("v"));
        assert_eq!(outer[1].0, "n");
        let inner = outer[1].1.as_block().unwrap();
        assert_eq!(inner[0].1.as_str(), Some("y"));
    }

    #[test]
    fn handles_escape_sequences() {
        let kv = parse(r#""k" "a\nb\tc\\d\"e""#).unwrap();
        assert_eq!(kv[0].1.as_str(), Some("a\nb\tc\\d\"e"));
    }

    #[test]
    fn handles_line_comments() {
        let kv = parse("// header comment\n\"k\" \"v\"\n// trailing comment\n").unwrap();
        assert_eq!(kv.len(), 1);
        assert_eq!(kv[0].1.as_str(), Some("v"));
    }

    #[test]
    fn unterminated_string_errors() {
        assert!(parse(r#""k" "unterminated"#).is_err());
    }

    #[test]
    fn last_played_zero_maps_to_none() {
        // Carved-down minimal AppState.
        let acf = r#"
"AppState"
{
    "appid"        "730"
    "name"         "Counter-Strike 2"
    "installdir"   "Counter-Strike Global Offensive"
    "StateFlags"   "4"
    "LastPlayed"   "0"
    "LastUpdated"  "1700000000"
    "SizeOnDisk"   "35000000000"
}
"#;
        let m = parse_appmanifest(acf).unwrap();
        assert_eq!(m.appid, 730);
        assert_eq!(m.last_played, None);
        assert_eq!(m.last_updated, Some(1_700_000_000));
        assert!(m.is_fully_installed());
    }

    #[test]
    fn missing_optional_fields_are_zero_not_error() {
        let acf = r#"
"AppState"
{
    "appid"      "1234"
    "name"       "minimal game"
    "installdir" "minimal"
}
"#;
        let m = parse_appmanifest(acf).unwrap();
        assert_eq!(m.size_on_disk, 0);
        assert_eq!(m.state_flags, 0);
        assert!(!m.is_fully_installed());
        assert_eq!(m.last_played, None);
    }

    #[test]
    fn missing_appid_is_an_error() {
        let acf = r#"
"AppState"
{
    "name" "no appid here"
}
"#;
        assert!(parse_appmanifest(acf).is_err());
    }

    #[test]
    fn libraryfolders_extracts_all_paths() {
        let vdf = r#"
"libraryfolders"
{
    "0"
    {
        "path"        "C:\\Program Files (x86)\\Steam"
        "label"       ""
        "contentid"   "1"
        "totalsize"   "0"
        "apps"
        {
            "730"  "35000000000"
        }
    }
    "1"
    {
        "path"  "D:\\SteamLibrary"
        "apps"
        {
            "1091500" "70000000000"
        }
    }
}
"#;
        let roots = parse_libraryfolders(vdf).unwrap();
        assert_eq!(roots.len(), 2);
        assert!(roots[0].to_string_lossy().contains("Program Files"));
        assert!(roots[1].to_string_lossy().contains("SteamLibrary"));
    }

    #[test]
    fn case_insensitive_top_level_key() {
        // Some VDF dialects use lowercase "libraryfolders", some title case.
        let vdf = r#"
"LibraryFolders"
{
    "0" { "path" "C:/Steam" }
}
"#;
        let roots = parse_libraryfolders(vdf).unwrap();
        assert_eq!(roots.len(), 1);
    }

    // -----------------------------------------------------------------
    // compute_recommendation
    // -----------------------------------------------------------------

    /// Pick a fixed `now` so reasons don't drift with the real clock.
    /// Roughly 2026-05-01.
    const TEST_NOW: u64 = 1_777_000_000;

    fn months_ago(now: u64, months: u32) -> u64 {
        let s = SECONDS_PER_MONTH as u64 * months as u64;
        now.saturating_sub(s)
    }

    #[test]
    fn ghost_always_recommended_with_diagnostic_reason() {
        let (rec, reason) = compute_recommendation(50_000_000_000, Some(TEST_NOW), true, TEST_NOW);
        assert!(rec);
        assert_eq!(reason.as_deref(), Some("ACF 存在但安装目录缺失"));
    }

    #[test]
    fn small_game_never_recommended() {
        // 2GB never played — below the 5GB floor.
        let (rec, reason) = compute_recommendation(2_000_000_000, None, false, TEST_NOW);
        assert!(!rec);
        assert!(reason.is_none());
    }

    #[test]
    fn large_old_game_recommended_with_size_and_age_reason() {
        let played_8mo_ago = months_ago(TEST_NOW, 8);
        let (rec, reason) =
            compute_recommendation(60_000_000_000, Some(played_8mo_ago), false, TEST_NOW);
        assert!(rec);
        let r = reason.unwrap();
        assert!(r.starts_with("60GB"), "got: {}", r);
        assert!(r.contains("8 个月未启动"), "got: {}", r);
    }

    #[test]
    fn never_played_large_game_recommended_with_explicit_never_string() {
        // §6.5: never-played counts as 12-month-stale for the recommendation
        // threshold, but for *display* we say "从未启动" — the more honest
        // statement, since we don't actually know the user has owned the
        // game for 12 months. The truthful copy beats the formula-derived one.
        let (rec, reason) = compute_recommendation(60_000_000_000, None, false, TEST_NOW);
        assert!(rec);
        assert_eq!(reason.as_deref(), Some("60GB · 从未启动"));
    }

    #[test]
    fn medium_recently_played_not_recommended() {
        let played_2mo_ago = months_ago(TEST_NOW, 2);
        let (rec, _) =
            compute_recommendation(40_000_000_000, Some(played_2mo_ago), false, TEST_NOW);
        assert!(!rec, "40GB played 2 months ago shouldn't be recommended");
    }

    #[test]
    fn very_large_recently_played_recommended() {
        // 60GB played 3 months ago → triggers the "size_gb >= 50 AND >= 3mo" rule.
        let played_3mo_ago = months_ago(TEST_NOW, 3);
        let (rec, reason) =
            compute_recommendation(60_000_000_000, Some(played_3mo_ago), false, TEST_NOW);
        assert!(rec);
        assert!(reason.unwrap().contains("个月未启动"));
    }

    #[test]
    fn very_old_game_says_n_years() {
        let played_3y_ago = months_ago(TEST_NOW, 36);
        let (rec, reason) =
            compute_recommendation(70_000_000_000, Some(played_3y_ago), false, TEST_NOW);
        assert!(rec);
        assert!(reason.unwrap().contains("3 年未启动"));
    }

    // -----------------------------------------------------------------
    // is_appmanifest_filename
    // -----------------------------------------------------------------

    #[test]
    fn appmanifest_filename_matcher() {
        assert!(is_appmanifest_filename("appmanifest_730.acf"));
        assert!(is_appmanifest_filename("appmanifest_1091500.acf"));
        // Wrong extension.
        assert!(!is_appmanifest_filename("appmanifest_730.txt"));
        // Wrong prefix.
        assert!(!is_appmanifest_filename("manifest_730.acf"));
        // Non-numeric "appid" — would crash parse_appmanifest, skip early.
        assert!(!is_appmanifest_filename("appmanifest_abc.acf"));
        // Empty appid.
        assert!(!is_appmanifest_filename("appmanifest_.acf"));
    }
}
