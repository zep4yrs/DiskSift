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

  advise: (req: AdvisorRequest) =>
    isTauri ? invoke<AdvisorResponse>('advise', { req }) : mocks.advise(req),

  inspect: (path: string, sampleCount: number) =>
    isTauri ? invoke<string[]>('inspect_path', { path, sampleCount }) : mocks.inspect(path, sampleCount),

  execute: (plan: Plan, dryRun: boolean) =>
    isTauri ? invoke<UndoEntry[]>('execute_plan', { plan, dryRun }) : mocks.execute(plan, dryRun),

  setAdvisor: (
    provider: 'openai' | 'anthropic' | 'ollama',
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
