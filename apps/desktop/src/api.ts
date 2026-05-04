import { invoke } from '@tauri-apps/api/core';
import type {
  Node,
  Scaffold,
  AdvisorRequest,
  AdvisorResponse,
  Plan,
  UndoEntry,
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
  ) =>
    isTauri
      ? invoke<{ scope_id: string; bytes: number; file_count: number }[]>('scope_sizes', {
          scaffoldId,
          rootPath,
          scopeDays: scopeDays ?? null,
          wxidFilter: wxidFilter ?? null,
        })
      : mocks.scopeSizes(scaffoldId, rootPath),

  executeScope: (
    scaffoldId: string,
    scopeId: string,
    rootPath: string,
    dryRun: boolean,
    olderThanDays?: number,
    wxidFilter?: string[],
  ) =>
    isTauri
      ? invoke<UndoEntry[]>('execute_scope', {
          scaffoldId,
          scopeId,
          rootPath,
          dryRun,
          olderThanDays: olderThanDays ?? null,
          wxidFilter: wxidFilter ?? null,
        })
      : Promise.resolve([] as UndoEntry[]),

  advise: (req: AdvisorRequest) =>
    isTauri ? invoke<AdvisorResponse>('advise', { req }) : mocks.advise(req),

  inspect: (path: string, sampleCount: number) =>
    isTauri ? invoke<string[]>('inspect_path', { path, sampleCount }) : mocks.inspect(path, sampleCount),

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
};
