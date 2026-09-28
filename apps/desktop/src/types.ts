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
  /** 分诊图层 O2 反馈通道：如「用户曾忽略此目录的判定」。后端把整个请求
   *  JSON 作为 prompt，此字段随之到达模型；缺省时不出现（types 镜像见
   *  crates/advisor/src/lib.rs AdvisorRequest）。 */
  user_note?: string;
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
  action: 'recycle' | 'quarantine' | 'delete' | 'migrate';
  /** migrate 条目的双向记录：source=原路径，destination=迁移后路径（回迁用）。 */
  paths: string[];
  reason: string;
}

export interface UndoEntry {
  timestamp: string;
  action: 'recycle' | 'quarantine' | 'delete' | 'migrate';
  /** migrate 条目的双向记录：source=原路径，destination=迁移后路径（回迁用）。 */
  source: string;
  destination?: string | null;
  reason: string;
  /** 受影响字节数。26.1.0 之前的历史行无此字段（undefined）；前端按 0 计。 */
  bytes?: number | null;
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

// ── v26.1.4.0 实时监控 / 迁移引擎（接口契约，逐字对齐 Tauri 命令与事件）──────
// 命令：monitor_start / monitor_stop / monitor_status / scan_cancel / migrate_paths
// 事件：'usn://changes' · 'usn://state' · 'migrate://progress'
// 镜像位（Rust 侧）：crates/monitor/、crates/executor/src/move_engine.rs。

/** 'usn://changes' 载荷里的单条聚合目录变更（aggregate 500ms 折叠产物）。
 *  kind 取值域冻结（crates/monitor/src/emit.rs DirChange）：create|delete|rename|overwrite。 */
export interface UsnChangeDir {
  path: string;
  size: number;
  file_count: number;
  kind: 'create' | 'delete' | 'rename' | 'overwrite';
}

/** 'usn://changes' 载荷：dirs 为受影响目录聚合，dropped 为自启动累计丢弃数。 */
export interface UsnChangesPayload {
  volume: string;
  dirs: UsnChangeDir[];
  dropped: number;
}

/** 'usn://state' 载荷：监控启停状态迁移。reason=null=正常态（启动成功/积压恢复）；
 *  非空 = 降级/停止/积压的人类可读原因（如「非 NTFS 卷（exFAT），不支持实时监控」、
 *  「变更积压超过 1000 个目录，已降级，建议重扫」）。 */
export interface UsnStatePayload {
  volume: string;
  running: boolean;
  reason: string | null;
}

/** migrate://progress 的 phase（copying → verifying → deleting → done；失败 rolled_back）。 */
export type MigratePhase = 'copying' | 'verifying' | 'deleting' | 'done' | 'rolled_back';

/** 'migrate://progress' 载荷：字节 + 文件数双进度。 */
export interface MigrateProgressPayload {
  src: string;
  dst: string;
  bytes_done: number;
  bytes_total: number;
  files_done: number;
  files_total: number;
  phase: MigratePhase;
}

/** monitor_status() 返回的单卷状态。last_refresh 为 Unix epoch 毫秒
 *  （crates/monitor/src/lib.rs VolumeStatus，从未产出 = null）；reason 非 null =
 *  该卷降级中（非 NTFS 等），running=false + reason 同现。 */
export interface MonitorVolumeStatus {
  volume: string;
  running: boolean;
  events_per_sec: number;
  last_refresh: number | null;
  /** 后端附加字段（CONTRACT 之外的可选项，降级原因），正常态为 null。 */
  reason?: string | null;
}

/** monitor_status() 返回：总开关 + 各卷明细。 */
export interface MonitorStatus {
  running: boolean;
  volumes: MonitorVolumeStatus[];
}

// ── v26.1.4.0 自定义排除规则（CONTRACT：excludes.json 逐字结构）──────────────
// 文件：%APPDATA%/DiskSift/excludes.json，{"rules":[...]}，tmp+rename 原子写。
// 前端读写走 Tauri 命令 excludes_get / excludes_set（后端已挂载，见 src-tauri
// lib.rs），浏览器 mock 走 localStorage；规则匹配的同一实现另见 crates/excludes
// （四处遵守的后端面）。

export type ExcludeRuleType = 'path' | 'glob' | 'ext';

/** CONTRACT 单条规则。字段名冻结：id / type / value / enabled。 */
export interface ExcludeRule {
  id: string;
  type: ExcludeRuleType;
  value: string;
  enabled: boolean;
}

/** CONTRACT 配置根结构。字段名冻结：rules。 */
export interface ExcludesConfig {
  rules: ExcludeRule[];
}
