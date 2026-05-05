export interface ExtShare {
  ext: string;
  bytes: number;
  count: number;
}

export interface Node {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  file_count: number;
  children: Node[];
  scaffold_id?: string | null;
  top_extensions: ExtShare[];
}

export type Risk = 'low' | 'medium' | 'high';
export type Mode = 'recycle' | 'quarantine' | 'delete';
export type Action = Mode | 'keep' | 'custom';

export interface Scope {
  id: string;
  label: string;
  glob: string;
  mode: Mode;
  category?: 'cache' | 'media' | 'backup' | 'envs';
  variant?: string;
  recycle_granularity?: RecycleGranularity;
  prompt?:
    | { kind: 'none' }
    | { kind: 'days'; default: number; label?: string }
    | { kind: 'bytes'; default: number; label?: string }
    | { kind: 'choice'; default: string; options: string[]; label?: string }
    | { kind: 'confirm'; label?: string };
}

export interface Scaffold {
  id: string;
  name: string;
  homepage?: string;
  risk: Risk;
  disclaimer: string;
  detect: string[];
  match: { name_contains?: string[]; must_have_child?: string[] };
  scopes: Scope[];
}

export interface AdvisorRequest {
  path: string;
  size_bytes: number;
  file_count: number;
  top_extensions: { ext: string; share: number }[];
  sample_paths: string[];
  neighbors: string[];
  scaffold_hint?: string | null;
}

export interface AdvisorResponse {
  what: string;
  category: string;
  safe_to_delete: boolean;
  risk: Risk;
  action: Action;
  reasoning: string;
  needs_inspection: boolean;
  suggested_scaffold?: string | null;
}

export interface Plan {
  action: 'recycle' | 'quarantine' | 'delete';
  paths: string[];
  reason: string;
}

export interface UndoEntry {
  timestamp: string;
  action: 'recycle' | 'quarantine' | 'delete';
  source: string;
  destination?: string | null;
  reason: string;
}

/// Mirror of Rust's CondaEnv (apps/desktop/src-tauri/src/lib.rs). Returned
/// by list_conda_envs and consumed by Studio's conda card. `last_active_ts`
/// is unix epoch seconds of <env>/conda-meta/history mtime; null when
/// missing. `default_checked` is the backend's stale-90d recommendation.
export interface CondaEnv {
  name: string;
  path: string;
  size_bytes: number;
  last_active_ts: number | null;
  is_base: boolean;
  default_checked: boolean;
}

/// Mirror of Rust's RecycleGranularity (crates/scaffold/src/lib.rs). Drives
/// whether a scope's glob matches files (default — file-by-file recycle) or
/// directories (one Recycle Bin entry per matched dir). Read by frontend
/// for display only; the actual file-vs-dir branching happens in the Tauri
/// backend's execute_scope / scope_sizes commands.
export type RecycleGranularity = 'file' | 'directory';

// ---------------------------------------------------------------------------
// Steam Inspector — mirror of crates/steam-inspector/src/lib.rs
// ---------------------------------------------------------------------------

/// Mirror of Rust's SteamGame. Returned (nested in SteamLibrary) by the
/// list_steam_games Tauri command. The Inspector is **read-only** — there is
/// no "uninstall" or "delete" command; the right-rail [Steam 中卸载] button
/// triggers the steam:// deep link in the frontend, letting Steam itself
/// handle the destructive action.
export interface SteamGame {
  appid: number;
  name_en: string;
  name_cn: string | null;
  install_dir_name: string;
  install_path: string;
  appmanifest_path: string;
  size_bytes: number;
  last_played_ts: number | null;
  library_root: string;
  state_flags: number;
  is_fully_installed: boolean;
  is_ghost: boolean;
  default_recommended: boolean;
  recommendation_reason: string | null;
  workshop_item_count: number;
}

/// Mirror of Rust's WorkshopItem. Returned by list_steam_workshop_items.
/// `last_modified_ts` is folder mtime — a proxy for "Steam last updated this
/// item", **not** "user last used this item" (Steam doesn't record that).
/// UI must label it as "上次更新" not "上次使用".
export interface WorkshopItem {
  id: number;
  size_bytes: number;
  last_modified_ts: number;
  path: string;
}

export interface SteamLibrary {
  root: string;
  games: SteamGame[];
  total_size_bytes: number;
}

export interface SteamInventory {
  /// Where Steam was found, or null when nothing was. When null, the empty-
  /// state UI shows `candidates_checked` so the user knows where we looked.
  steam_root: string | null;
  candidates_checked: string[];
  libraries: SteamLibrary[];
}
