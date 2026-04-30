// Triage classifier — runs in TS after a scan returns the tree.
// Buckets every directory above a threshold into one of 5 categories.

import type { Node, Scaffold } from './types';

export type Bucket = 'safe' | 'heavy' | 'stale' | 'system' | 'unknown';

export const BUCKET_META: Record<Bucket, { emoji: string; label: string; tone: string; description: string; }> = {
  safe:    { emoji: '🟢', label: '100% 可清', tone: '#5fc88a', description: '缓存类，删了会自动重建' },
  heavy:   { emoji: '🟠', label: '占用大但你常用', tone: '#ff9f5e', description: '已知应用，要不要清你说了算' },
  stale:   { emoji: '🟡', label: '占用不大但很久没碰', tone: '#ffd166', description: '考古时间' },
  system:  { emoji: '⚫', label: '系统/不能动',  tone: '#7a6675', description: 'Windows、Program Files、用户文档' },
  unknown: { emoji: '🔵', label: 'AI 不确定', tone: '#5b8def', description: '点开让 AI 分析' },
};

export interface Triaged {
  node: Node;
  scaffoldId: string | null;
  bucket: Bucket;
  reason: string;
  suggestedScopes: string[];
}

export interface TriageResult {
  items: Triaged[];
  byBucket: Record<Bucket, Triaged[]>;
  totalsByBucket: Record<Bucket, number>;
  totalScanned: number;
}

const NEVER_TOUCH_PATH_FRAGS = [
  '/Windows/',
  '\\Windows\\',
  '/Program Files',
  '\\Program Files',
  '/ProgramData/',
  '\\ProgramData\\',
  '/$Recycle.Bin',
  '\\$Recycle.Bin',
  '/System Volume Information',
  '\\System Volume Information',
  '/$Extend',
  '\\$Extend',
  '/Boot',
  '\\Boot',
];

const USER_CONTENT_FRAGS = [
  '/Documents/',
  '/Pictures/',
  '/Music/',
  '/Videos/',
  '/Desktop/',
  '/Downloads/',
];

// scaffold-id → bucket override
// safe = "clear it without thinking" — only well-vetted cache dirs
const SAFE_SCAFFOLDS = new Set([
  'chrome', 'edge', 'firefox', 'brave',
  'slack', 'discord', 'telegram', 'teams',
  'vscode', 'cursor', 'jetbrains',
  'epicgames', 'battlenet',
  'npm', 'pnpm', 'yarn', 'pip', 'go-mod', 'gradle', 'maven', 'nuget',
  'crash-dumps', 'windows-temp', 'obs',
]);

// heavy = known app, big footprint, user must decide
const HEAVY_SCAFFOLDS = new Set([
  'wechat-pc', 'qq-pc', 'dingtalk', 'feishu',
  'spotify',
  'steam',
  'docker',
  'huggingface', 'ollama', 'cargo', 'conda',
  'recycle-bin',
]);

// these are never auto-suggested; require explicit opt-in
const HIGH_RISK_SCAFFOLDS = new Set([
  'windows-old', 'node-modules', 'recycle-bin',
]);

const ONE_YEAR_MS = 365 * 24 * 3600 * 1000;

function isNeverTouch(path: string): boolean {
  const norm = path.replace(/\\/g, '/');
  // anything directly under user "personal content" dirs is system-protected
  if (USER_CONTENT_FRAGS.some(f => norm.includes(f))) return true;
  return NEVER_TOUCH_PATH_FRAGS.some(f => path.includes(f));
}

export function triage(
  root: Node,
  scaffolds: Scaffold[],
  thresholdBytes: number,
): TriageResult {
  const items: Triaged[] = [];
  const scaffoldById = new Map(scaffolds.map(s => [s.id, s]));

  const visit = (n: Node, depth: number) => {
    if (!n.is_dir) return;
    if (depth > 0 && n.size >= thresholdBytes) {
      items.push(classify(n, scaffoldById));
      return;
    }
    if (depth < 5) {
      for (const c of n.children) visit(c, depth + 1);
    }
  };
  visit(root, 0);

  // sort largest first
  items.sort((a, b) => b.node.size - a.node.size);

  const byBucket: Record<Bucket, Triaged[]> = {
    safe: [], heavy: [], stale: [], system: [], unknown: [],
  };
  const totalsByBucket: Record<Bucket, number> = {
    safe: 0, heavy: 0, stale: 0, system: 0, unknown: 0,
  };
  for (const item of items) {
    byBucket[item.bucket].push(item);
    totalsByBucket[item.bucket] += item.node.size;
  }
  return {
    items, byBucket, totalsByBucket, totalScanned: root.size,
  };
}

function classify(n: Node, scaffoldById: Map<string, Scaffold>): Triaged {
  const sid = n.scaffold_id ?? null;

  if (isNeverTouch(n.path)) {
    return { node: n, scaffoldId: sid, bucket: 'system', reason: '系统目录或用户文档，绝对不动', suggestedScopes: [] };
  }

  if (sid && scaffoldById.has(sid)) {
    const s = scaffoldById.get(sid)!;
    if (HIGH_RISK_SCAFFOLDS.has(sid)) {
      return { node: n, scaffoldId: sid, bucket: 'heavy', reason: `${s.name} · 高风险，需要明确确认`, suggestedScopes: s.scopes.map(sc => sc.id) };
    }
    if (SAFE_SCAFFOLDS.has(sid)) {
      return { node: n, scaffoldId: sid, bucket: 'safe', reason: `${s.name} · 标准缓存，可清`, suggestedScopes: defaultSafeScopes(s) };
    }
    if (HEAVY_SCAFFOLDS.has(sid)) {
      return { node: n, scaffoldId: sid, bucket: 'heavy', reason: `${s.name} · 已知应用，由你决定`, suggestedScopes: s.scopes.map(sc => sc.id) };
    }
    return { node: n, scaffoldId: sid, bucket: 'heavy', reason: `${s.name}`, suggestedScopes: s.scopes.map(sc => sc.id) };
  }

  // Stale heuristic — for now, mark mid-size unknown subdirs of AppData as candidates
  // (real mtime check would need backend signal; we approximate by depth + size)
  // future: add mtime field to Node and check < 1 year ago

  return { node: n, scaffoldId: sid, bucket: 'unknown', reason: '未识别 — 让 AI 分析一下', suggestedScopes: [] };
}

function defaultSafeScopes(s: Scaffold): string[] {
  // For safe scaffolds, default-include only "low-risk" scopes:
  // - HTTP cache, Code cache, GPU cache, Service Worker, logs, CrashDumps
  // - skip workspace-storage / unused-packages (need confirmation)
  const SKIP_BY_DEFAULT = new Set(['workspace-storage', 'unused-packages', 'all', 'stale']);
  return s.scopes.filter(sc => !SKIP_BY_DEFAULT.has(sc.id)).map(sc => sc.id);
}
