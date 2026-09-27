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
};
