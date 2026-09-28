import { invoke } from '@tauri-apps/api/core';
import type {
  Node,
  Scaffold,
  AdvisorRequest,
  AdvisorResponse,
  Plan,
  UndoEntry,
  CondaEnv,
  SteamInventory,
  WorkshopItem,
} from './types';
import { isTauri } from './env';
import * as mocks from './mocks';

export const api = {
  scan: (path: string) =>
    isTauri ? invoke<Node>('scan_path', { path }) : mocks.scan(path),

  listScaffolds: () =>
    isTauri ? invoke<Scaffold[]>('list_scaffolds') : Promise.resolve(mocks.SCAFFOLDS),

  detectScaffold: (path: string) =>
    isTauri ? invoke<string | null>('detect_scaffold', { path }) : mocks.detectScaffold(path),

  scopeSizes: (
    scaffoldId: string,
    rootPath: string,
    scopeDays?: Record<string, number>,
    wxidFilter?: string[],
    envFilter?: string[],
  ) =>
    isTauri
      ? invoke<{ scope_id: string; bytes: number; file_count: number; total_bytes: number; total_files: number }[]>('scope_sizes', {
          scaffoldId,
          rootPath,
          scopeDays: scopeDays ?? null,
          wxidFilter: wxidFilter ?? null,
          envFilter: envFilter ?? null,
        })
      : mocks.scopeSizes(scaffoldId, rootPath),

  executeScope: (
    scaffoldId: string,
    scopeId: string,
    rootPath: string,
    dryRun: boolean,
    olderThanDays?: number,
    wxidFilter?: string[],
    envFilter?: string[],
  ) =>
    isTauri
      ? invoke<UndoEntry[]>('execute_scope', {
          scaffoldId,
          scopeId,
          rootPath,
          dryRun,
          olderThanDays: olderThanDays ?? null,
          wxidFilter: wxidFilter ?? null,
          envFilter: envFilter ?? null,
        })
      : Promise.resolve([] as UndoEntry[]),

  listCondaEnvs: (condaRoot: string) =>
    isTauri
      ? invoke<CondaEnv[]>('list_conda_envs', { condaRoot })
      : Promise.resolve([] as CondaEnv[]),

  advise: (req: AdvisorRequest) =>
    isTauri ? invoke<AdvisorResponse>('advise', { req }) : mocks.advise(req),

  inspect: (path: string, sampleCount: number) =>
    isTauri ? invoke<string[]>('inspect_path', { path, sampleCount }) : mocks.inspect(path, sampleCount),

  revealInExplorer: (path: string) =>
    isTauri ? invoke<void>('reveal_in_explorer', { path }) : Promise.resolve(),

  execute: (plan: Plan, dryRun: boolean) =>
    isTauri ? invoke<UndoEntry[]>('execute_plan', { plan, dryRun }) : mocks.execute(plan, dryRun),

  volumeInfo: (path: string) =>
    isTauri
      ? invoke<{ total_bytes: number; used_bytes: number; free_bytes: number }>('volume_info', { path })
      : Promise.resolve(null),

  estimateSize: (path: string) =>
    isTauri ? invoke<number>('estimate_size', { path }) : Promise.resolve(0),

  setAdvisor: (
    provider: 'openai' | 'anthropic' | 'gemini' | 'ollama',
    model: string,
    apiKey?: string,
    baseUrl?: string,
  ) =>
    isTauri
      ? invoke<void>('set_advisor', {
          provider,
          apiKey: apiKey ?? null,
          model,
          baseUrl: baseUrl ?? null,
        })
      : Promise.resolve(),

  listSteamGames: () =>
    isTauri
      ? invoke<SteamInventory>('list_steam_games')
      : Promise.resolve(mocks.STEAM_INVENTORY),

  listSteamWorkshopItems: (libraryRoot: string, appid: number) =>
    isTauri
      ? invoke<WorkshopItem[]>('list_steam_workshop_items', { libraryRoot, appid })
      : Promise.resolve(mocks.steamWorkshopItems(appid)),

  fetchWorkshopTitles: (ids: number[]) =>
    isTauri
      ? invoke<Record<number, string>>('fetch_workshop_titles', { ids })
      : Promise.resolve(mocks.workshopTitles(ids)),

  openSteamUrl: (
    action: 'uninstall' | 'rungameid' | 'validate' | 'nav' | 'workshop_page',
    appid: number,
  ) =>
    isTauri ? invoke<void>('open_steam_url', { action, appid }) : Promise.resolve(),

  // ── 操作记录视图（redesign-spec §4）：list_undo / restore_quarantine / open_recycle_bin ──
  // 仅新增封装，不改动既有条目。浏览器预览模式下 listUndo 返回空表，
  // restoreQuarantine / openRecycleBin 不产生副作用（与 executeScope 同策略）。

  /** undo.jsonl 记录，倒序（最新在前）；limit 缺省 = 全部。 */
  listUndo: (limit?: number) =>
    isTauri
      ? invoke<UndoEntry[]>('list_undo', { limit: limit ?? null })
      : Promise.resolve([] as UndoEntry[]),

  /** 还原一条隔离记录：destination 移回 source。源已存在/非隔离记录由后端 Err 阻断。 */
  restoreQuarantine: (entry: UndoEntry) =>
    isTauri ? invoke<void>('restore_quarantine', { entry }) : Promise.resolve(),

  /** 打开系统回收站（explorer shell:RecycleBinFolder）。 */
  openRecycleBin: () =>
    isTauri ? invoke<void>('open_recycle_bin') : Promise.resolve(),

  // ── Secure storage（Windows DPAPI，对标 BlueTidy 方案）──
  // 密钥类数据（AI apiKey 等）经这里落盘：Rust 侧 DPAPI 加密后存
  // %APPDATA% 存储目录的 secure.json，浏览器/前端侧任何持久层都不再有明文。

  /** 加密并保存 `plain` 到 secure.json 的 `key` 条目（明文只走 IPC，不落前端存储）。 */
  secureSet: (key: string, plain: string) =>
    isTauri ? invoke<void>('secure_set', { key, plain }) : Promise.resolve(),

  /** 取回并解密 `key` 条目；缺失或解不开（跨用户/被篡改）返回 null。 */
  secureGet: (key: string) =>
    isTauri ? invoke<string | null>('secure_get', { key }) : Promise.resolve(null),

  // ── 分诊判定缓存（triage-overlay-spec §7 决策 1：缓存放文件）──
  // triage-cache.json 与 secure.json 同目录、同 tmp+rename 原子写。浏览器预览
  // 模式没有 %APPDATA% 语义：cacheGetAll 返回 "{}"（空缓存），cacheSetAll
  // 静默 no-op（与 secureSet 同策略）。

  /** 读整个分诊判定缓存（JSON 文本）；文件不存在返回 "{}"。 */
  cacheGetAll: () => (isTauri ? invoke<string>('cache_get_all') : Promise.resolve('{}')),

  /** 整体覆写分诊判定缓存；`json` 须为合法 JSON 文本（后端写前校验）。 */
  cacheSetAll: (json: string) =>
    isTauri ? invoke<void>('cache_set_all', { json }) : Promise.resolve(),

  // ── 定时自动巡查（auto-patrol）：Task Scheduler 注册 + --auto 无头巡查 ──
  // 浏览器预览模式没有 Task Scheduler 语义：status 返回未注册，
  // register / unregister 静默 no-op（与 secureSet 同策略）。

  /** 巡查注册状态（AutoPatrolStatus 镜像）。 */
  autoPatrolStatus: () =>
    isTauri
      ? invoke<AutoPatrolStatus>('auto_patrol_status')
      : Promise.resolve({
          registered: false,
          frequency: '',
          task_name: 'DiskSiftAutoPatrol',
          exe_path: null,
          next_run: null,
          status: null,
          enabled: false,
        } as AutoPatrolStatus),

  /** 注册定时巡查任务（缺省档位 = 每周日 03:00，后端规格缺省）；
   *  指向本 exe + --auto，返回生效的 frequency。 */
  autoPatrolRegister: (frequency?: AutoPatrolFrequency) =>
    isTauri
      ? invoke<string>('auto_patrol_register', { frequency: frequency ?? null })
      : Promise.resolve(frequency ?? 'weekly'),

  /** 注销定时巡查任务；未注册时幂等成功。 */
  autoPatrolUnregister: () =>
    isTauri ? invoke<void>('auto_patrol_unregister') : Promise.resolve(),

  // ── 脚本中心：scaffold 启停 + TOML 导入导出 ──
  // 浏览器预览模式无 %APPDATA% 语义：启停 no-op、import 返回空 id、export
  // 返回空文本（与 cacheSetAll 同策略）。

  /** 启用/停用 scaffold；停用的从 listScaffolds 过滤（scaffold-config.json）。 */
  scaffoldSetEnabled: (id: string, enabled: boolean) =>
    isTauri ? invoke<void>('scaffold_set_enabled', { id, enabled }) : Promise.resolve(),

  /** 导入 scaffold TOML：后端校验（parse + scope + id 安全）→ 写入用户
   *  scaffolds 目录并热重载 → 返回 id；校验失败 reject。 */
  scaffoldImport: (toml: string) =>
    isTauri ? invoke<string>('scaffold_import', { toml }) : Promise.resolve(''),

  /** 导出 scaffold 的 TOML 文本（停用的也可导出）；id 不存在 reject。 */
  scaffoldExport: (id: string) =>
    isTauri ? invoke<string>('scaffold_export', { id }) : Promise.resolve(''),
};

/** 巡查频率档位（auto_patrol.rs schedule_args 的四档）。 */
export type AutoPatrolFrequency = 'hourly' | 'daily' | 'weekly' | 'monthly';

/** auto_patrol_status 的返回（auto_patrol.rs AutoPatrolStatus 镜像）。
 *  frequency 未注册 = ''，识别不了 = 'unknown'；next_run / status 为
 *  schtasks 原样本地化文本。 */
export interface AutoPatrolStatus {
  registered: boolean;
  frequency: string;
  task_name: string;
  exe_path: string | null;
  next_run: string | null;
  status: string | null;
  enabled: boolean;
}
