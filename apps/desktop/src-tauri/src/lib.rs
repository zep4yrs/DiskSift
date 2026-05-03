use std::path::PathBuf;
use std::sync::Mutex;

use diskwise_advisor::{advise as advise_provider, AdvisorRequest, AdvisorResponse, Provider};
use diskwise_executor::{execute, Plan, UndoEntry};
use diskwise_scaffold::{detect_for, expand_env, load_dir, Scaffold};
use diskwise_scanner::{sample_paths, scan_with, Node, ScanOptions};

use tauri::{AppHandle, Emitter, Manager, State};

#[derive(serde::Serialize, Clone)]
struct ScanProgressEvent {
    files_seen: u64,
    bytes_seen: u64,
    current_path: String,
}

struct AppState {
    scaffolds: Mutex<Vec<Scaffold>>,
    advisor: Mutex<Option<Provider>>,
    quarantine_root: PathBuf,
    undo_log: PathBuf,
}

#[tauri::command]
async fn scan_path(app: AppHandle, path: String) -> Result<Node, String> {
    let p = PathBuf::from(&path);
    let app_for_progress = app.clone();
    tokio::task::spawn_blocking(move || {
        scan_with(p, ScanOptions::default(), |progress| {
            let _ = app_for_progress.emit(
                "scan-progress",
                ScanProgressEvent {
                    files_seen: progress.files_seen,
                    bytes_seen: progress.bytes_seen,
                    current_path: progress.current_path.clone(),
                },
            );
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_scaffolds(state: State<'_, AppState>) -> Vec<Scaffold> {
    state.scaffolds.lock().unwrap().clone()
}

/// Fast size-only walk used to seed the progress-bar denominator before the
/// real scan starts. Single jwalk pass, sums file sizes, no other state.
#[tauri::command]
async fn estimate_size(path: String) -> Result<u64, String> {
    let p = PathBuf::from(&path);
    tokio::task::spawn_blocking(move || -> u64 {
        let mut total: u64 = 0;
        for entry in jwalk::WalkDir::new(&p)
            .skip_hidden(false)
            .follow_links(false)
            .into_iter()
            .flatten()
        {
            if entry.file_type().is_file() {
                if let Ok(md) = entry.metadata() {
                    total = total.saturating_add(md.len());
                }
            }
        }
        total
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(serde::Serialize, Clone)]
struct VolumeInfo {
    total_bytes: u64,
    used_bytes: u64,
    free_bytes: u64,
}

#[tauri::command]
fn volume_info(path: String) -> Result<VolumeInfo, String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let mut wide: Vec<u16> = std::ffi::OsStr::new(&path).encode_wide().collect();
        // Trim to drive root for the Win32 API.
        let root: Vec<u16> = if wide.len() >= 2 && wide[1] == b':' as u16 {
            vec![wide[0], wide[1], b'\\' as u16, 0]
        } else {
            wide.push(0);
            wide
        };
        let mut free_to_caller: u64 = 0;
        let mut total: u64 = 0;
        let mut total_free: u64 = 0;
        // SAFETY: calling documented Win32 API with valid wide-char buffers.
        let ok = unsafe {
            #[link(name = "kernel32")]
            extern "system" {
                fn GetDiskFreeSpaceExW(
                    lpDirectoryName: *const u16,
                    lpFreeBytesAvailable: *mut u64,
                    lpTotalNumberOfBytes: *mut u64,
                    lpTotalNumberOfFreeBytes: *mut u64,
                ) -> i32;
            }
            GetDiskFreeSpaceExW(root.as_ptr(), &mut free_to_caller, &mut total, &mut total_free)
        };
        if ok == 0 {
            return Err("GetDiskFreeSpaceExW failed".into());
        }
        return Ok(VolumeInfo {
            total_bytes: total,
            used_bytes: total.saturating_sub(total_free),
            free_bytes: total_free,
        });
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("volume_info only implemented on Windows".into())
    }
}

#[tauri::command]
fn detect_scaffold(state: State<'_, AppState>, path: String) -> Option<String> {
    detect_for(&state.scaffolds.lock().unwrap(), std::path::Path::new(&path))
}

#[derive(serde::Serialize, Clone)]
struct ScopeSize {
    scope_id: String,
    bytes: u64,
    file_count: u64,
}

/// Walk `root_path` and tally how many bytes / files each `[[scope]]` glob
/// in `scaffold_id` would match. Used by the Studio panel to show per-scope
/// occupancy alongside the generic "largest sub-items" view. Files matching
/// multiple scopes are counted once per matching scope (the same physical
/// bytes — overlap means cleaning either scope reclaims them).
#[tauri::command]
async fn scope_sizes(
    state: State<'_, AppState>,
    scaffold_id: String,
    root_path: String,
) -> Result<Vec<ScopeSize>, String> {
    let scaffold = state
        .scaffolds
        .lock()
        .unwrap()
        .iter()
        .find(|s| s.id == scaffold_id)
        .cloned()
        .ok_or_else(|| format!("scaffold not found: {scaffold_id}"))?;

    let mut sets: Vec<(String, globset::GlobSet)> = Vec::with_capacity(scaffold.scopes.len());
    for sc in &scaffold.scopes {
        let pattern = expand_env(&sc.glob);
        let glob = globset::GlobBuilder::new(&pattern)
            .literal_separator(false)
            .case_insensitive(true)
            .build()
            .map_err(|e| format!("scope `{}` has invalid glob `{}`: {e}", sc.id, sc.glob))?;
        let mut b = globset::GlobSetBuilder::new();
        b.add(glob);
        sets.push((sc.id.clone(), b.build().map_err(|e| e.to_string())?));
    }

    let root = PathBuf::from(&root_path);
    tokio::task::spawn_blocking(move || {
        let mut tally: Vec<(u64, u64)> = vec![(0, 0); sets.len()];
        for entry in jwalk::WalkDir::new(&root)
            .skip_hidden(false)
            .follow_links(false)
            .into_iter()
            .flatten()
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let path_str = entry.path().to_string_lossy().replace('\\', "/");
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            for (i, (_, set)) in sets.iter().enumerate() {
                if set.is_match(&path_str) {
                    tally[i].0 = tally[i].0.saturating_add(size);
                    tally[i].1 = tally[i].1.saturating_add(1);
                }
            }
        }
        sets.into_iter()
            .zip(tally)
            .map(|((scope_id, _), (bytes, file_count))| ScopeSize {
                scope_id,
                bytes,
                file_count,
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Resolve a scaffold scope's glob to actual file paths under `root_path` and
/// run the executor on just those files. Use this instead of feeding the
/// matched root directly into `execute_plan` — the latter would delete the
/// whole folder, ignoring the scope's glob. `dry_run = true` returns what
/// would be touched without performing the action.
#[tauri::command]
async fn execute_scope(
    state: State<'_, AppState>,
    scaffold_id: String,
    scope_id: String,
    root_path: String,
    dry_run: bool,
) -> Result<Vec<UndoEntry>, String> {
    let (scaffold, scope) = {
        let scaffolds = state.scaffolds.lock().unwrap();
        let sc = scaffolds
            .iter()
            .find(|s| s.id == scaffold_id)
            .cloned()
            .ok_or_else(|| format!("scaffold not found: {scaffold_id}"))?;
        let scope = sc
            .scopes
            .iter()
            .find(|s| s.id == scope_id)
            .cloned()
            .ok_or_else(|| format!("scope not found: {scaffold_id}/{scope_id}"))?;
        (sc, scope)
    };

    let pattern = expand_env(&scope.glob);
    let glob = globset::GlobBuilder::new(&pattern)
        .literal_separator(false)
        .case_insensitive(true)
        .build()
        .map_err(|e| format!("scope `{}` has invalid glob: {e}", scope.id))?;
    let mut b = globset::GlobSetBuilder::new();
    b.add(glob);
    let set = b.build().map_err(|e| e.to_string())?;

    let root = PathBuf::from(&root_path);
    let matched: Vec<PathBuf> = tokio::task::spawn_blocking(move || {
        let mut out = Vec::new();
        for entry in jwalk::WalkDir::new(&root)
            .skip_hidden(false)
            .follow_links(false)
            .into_iter()
            .flatten()
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let p = entry.path();
            let s = p.to_string_lossy().replace('\\', "/");
            if set.is_match(&s) {
                out.push(p);
            }
        }
        out
    })
    .await
    .map_err(|e| e.to_string())?;

    if matched.is_empty() {
        return Ok(Vec::new());
    }

    let action = match scope.mode {
        diskwise_scaffold::Mode::Recycle => diskwise_executor::Action::Recycle,
        diskwise_scaffold::Mode::Quarantine => diskwise_executor::Action::Quarantine,
        diskwise_scaffold::Mode::Delete => diskwise_executor::Action::Delete,
    };
    let plan = Plan {
        action,
        paths: matched,
        reason: format!("Diskwise scaffold {}/{} (Studio)", scaffold.id, scope.id),
    };
    execute(&plan, dry_run, &state.undo_log, &state.quarantine_root).map_err(|e| e.to_string())
}

#[tauri::command]
async fn advise(state: State<'_, AppState>, req: AdvisorRequest) -> Result<AdvisorResponse, String> {
    let provider = state
        .advisor
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "advisor not configured — open Settings".to_string())?;
    advise_provider(&provider, &req).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn inspect_path(path: String, sample_count: usize) -> Vec<String> {
    sample_paths(&path, sample_count)
}

#[tauri::command]
fn execute_plan(
    state: State<'_, AppState>,
    plan: Plan,
    dry_run: bool,
) -> Result<Vec<UndoEntry>, String> {
    execute(&plan, dry_run, &state.undo_log, &state.quarantine_root).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_advisor(
    state: State<'_, AppState>,
    provider: String,
    api_key: Option<String>,
    model: String,
    base_url: Option<String>,
) -> Result<(), String> {
    let p = match provider.as_str() {
        "openai" => Provider::OpenAI {
            api_key: api_key.ok_or_else(|| "api_key required".to_string())?,
            model,
            base_url: base_url.unwrap_or_else(|| "https://api.openai.com/v1".to_string()),
        },
        "anthropic" => Provider::Anthropic {
            api_key: api_key.ok_or_else(|| "api_key required".to_string())?,
            model,
            base_url: base_url.unwrap_or_else(|| "https://api.anthropic.com".to_string()),
        },
        "ollama" => Provider::Ollama {
            base_url: base_url.unwrap_or_else(|| "http://localhost:11434".to_string()),
            model,
        },
        "gemini" => Provider::Gemini {
            api_key: api_key.ok_or_else(|| "api_key required".to_string())?,
            model,
            base_url: base_url.unwrap_or_else(|| "https://generativelanguage.googleapis.com".to_string()),
        },
        other => return Err(format!("unknown provider: {other}")),
    };
    *state.advisor.lock().unwrap() = Some(p);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from(".diskwise"));
            std::fs::create_dir_all(&data_dir).ok();
            let undo_log = data_dir.join("undo.jsonl");
            let quarantine_root = data_dir.join("quarantine");

            let scaffolds = load_all_scaffolds(app.handle());
            tracing::info!("loaded {} scaffolds", scaffolds.len());

            app.manage(AppState {
                scaffolds: Mutex::new(scaffolds),
                advisor: Mutex::new(None),
                quarantine_root,
                undo_log,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_path,
            estimate_size,
            list_scaffolds,
            detect_scaffold,
            scope_sizes,
            execute_scope,
            advise,
            inspect_path,
            execute_plan,
            set_advisor,
            volume_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn load_all_scaffolds(handle: &AppHandle) -> Vec<Scaffold> {
    use std::collections::HashMap;
    let mut by_id: HashMap<String, Scaffold> = HashMap::new();
    let mut candidates: Vec<PathBuf> = Vec::new();
    // Resource dir takes precedence — packaged scaffolds. Then user override
    // (app_data_dir) — community-contributed scaffolds win over bundled ones
    // with the same id.
    if let Ok(p) = handle.path().resource_dir() {
        candidates.push(p.join("scaffolds"));
    }
    candidates.push(PathBuf::from("scaffolds"));
    candidates.push(PathBuf::from("../../scaffolds"));
    candidates.push(PathBuf::from("../../../scaffolds"));
    if let Ok(p) = handle.path().app_data_dir() {
        candidates.push(p.join("scaffolds"));
    }
    for p in &candidates {
        if !p.exists() {
            continue;
        }
        match load_dir(p) {
            Ok(v) => {
                for s in v {
                    by_id.insert(s.id.clone(), s);
                }
            }
            Err(e) => tracing::warn!("could not load scaffolds from {:?}: {}", p, e),
        }
    }
    let mut out: Vec<Scaffold> = by_id.into_values().collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}
