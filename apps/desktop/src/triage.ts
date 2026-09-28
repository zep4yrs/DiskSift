// Triage classifier — runs in TS after a scan returns the tree.
// Buckets every directory above a threshold into one of 5 categories.

import type { Node, Scaffold } from './types';

export type Bucket = 'safe' | 'heavy' | 'stale' | 'system' | 'unknown';

// §1-B：tone 统一走语义令牌（消费方仅 TriageView 的 BUCKET_ICONS，图标内联
// style 直接支持 var()）；stale 与 heavy 同为琥珀系都桥 --warn（曾考虑的
// --verdict-decide 实为蓝 --info，会破坏琥珀语义，弃用）。
export const BUCKET_META: Record<Bucket, { label: string; tone: string; description: string; }> = {
  safe:    { label: '100% 可清', tone: 'var(--ok)', description: '缓存类，删了会自动重建' },
  heavy:   { label: '占用大但你常用', tone: 'var(--warn)', description: '已知应用，要不要清你说了算' },
  stale:   { label: '占用不大但很久没碰', tone: 'var(--warn)', description: '考古时间' },
  system:  { label: '系统/不能动',  tone: 'var(--fg-muted)', description: 'Windows、Program Files、用户文档' },
  unknown: { label: 'AI 不确定', tone: 'var(--info)', description: '点开让 AI 分析' },
};

export interface Triaged {
  node: Node;
  scaffoldId: string | null;
  bucket: Bucket;
  reason: string;
  suggestedScopes: string[];
  /** 最近一个同样入列的祖先目录路径（v26.1.2 下钻收集，无则 null）：
   *  整目录回收父项时本项含于其内，UI 标注「含于 X」，一键清扫按此去重。 */
  containedIn?: string | null;
}

export interface TriageResult {
  items: Triaged[];
  byBucket: Record<Bucket, Triaged[]>;
  totalsByBucket: Record<Bucket, number>;
  totalScanned: number;
}

// v26.1.2 高危修复（never-touch 双层防线 · 前端层）：
// 旧实现 NEVER_TOUCH_PATH_FRAGS 带 '/Windows/' 这类尾分隔符片段 + path.includes
// 子串匹配，两头的错都出过：C:\Windows（根级，无尾分隔符）匹配不到 → 父判
// 「需决策」子判「系统」自相矛盾、巡查流混入系统目录；'/Program Files'（无尾
// 分隔符）又会误命中 C:\Program Files Excl。现统一为「路径段序列」匹配：
// path 与保护片段都归一化（小写 + \ → /）成段数组，片段按连续子序列整段比较——
// C:\Windows 命中 ['windows']；C:\WindowsExcl（段 'windowsexcl'）不误命中；
// 带空格段（program files (x86)）整段比较不受分隔符差异影响。片段表一律不带
// 尾分隔符。与 Rust 侧 crates/executor 的 is_never_touch 同规则（双层防线，
// Rust 层在 execute() 拒绝，本层只影响判定/队列）。
const NEVER_TOUCH_SEGMENTS: string[][] = [
  ['windows'],
  ['program files'],
  ['program files (x86)'],
  ['programdata'],
  ['$recycle.bin'],
  ['system volume information'],
  ['$extend'],
  ['boot'],
  ['recovery'], // C:\Recovery（OEM 重镜像 / WinRE 工具），v26.1.2 补
  ['windows.old'], // 旧系统备份，整目录不可动
];

const USER_CONTENT_SEGMENTS: string[][] = [
  ['documents'],
  ['pictures'],
  ['music'],
  ['videos'],
  ['desktop'],
  ['downloads'],
];

function segmentsOf(p: string): string[] {
  return p
    .toLowerCase()
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s.length > 0);
}

/** want 是否为 segs 的连续子序列（整段相等，非子串）。 */
function containsSegmentSeq(segs: string[], want: string[]): boolean {
  if (want.length === 0 || want.length > segs.length) return false;
  outer: for (let i = 0; i + want.length <= segs.length; i++) {
    for (let j = 0; j < want.length; j++) {
      if (segs[i + j] !== want[j]) continue outer;
    }
    return true;
  }
  return false;
}

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

// 导出给 triage-cache.ts（分诊图层 O1）复用：同一份 NEVER_TOUCH 清单，
// 保证分诊列表 / 空间图 / 树视图三处判定一致（triage-overlay-spec §4）。
export function isNeverTouch(path: string): boolean {
  const segs = segmentsOf(path);
  return (
    NEVER_TOUCH_SEGMENTS.some((w) => containsSegmentSeq(segs, w)) ||
    USER_CONTENT_SEGMENTS.some((w) => containsSegmentSeq(segs, w))
  );
}

/** 入列目录（v26.1.2 下钻收集的产物）。containedIn = 最近一个同样入列的
 *  祖先目录路径；它同时 ≥ 阈值，整目录回收父项时本项含于其内。 */
export interface CollectedDir {
  node: Node;
  containedIn: string | null;
}

/** 阈值目录收集（单一出处：triage() 分组与 buildWalkQueue 巡查队列共用）。
 *  v26.1.2 高危修复：命中阈值的目录不再 return 截断子树——C:\Users 90GB
 *  曾挡住整棵用户树，safe/heavy/stale 三桶恒 0 项、一键清扫永不可达。现在
 *  命中照常收集并继续下钻，子项带 containedIn 标注供 UI 折叠/去重；深度
 *  上限统一 5（原 triage 5 / 队列 4 不一致）。仍在扫描树上单次 DFS，
 *  O(目录数)，无重复访问。 */
export function collectDirs(root: Node, thresholdBytes: number): CollectedDir[] {
  const out: CollectedDir[] = [];
  const visit = (n: Node, depth: number, containedIn: string | null): void => {
    if (!n.is_dir) return;
    let nextContained = containedIn;
    if (depth > 0 && n.size >= thresholdBytes) {
      out.push({ node: n, containedIn });
      nextContained = n.path;
    }
    if (depth < 5) {
      for (const c of n.children) visit(c, depth + 1, nextContained);
    }
  };
  visit(root, 0, null);
  return out;
}

export function triage(
  root: Node,
  scaffolds: Scaffold[],
  thresholdBytes: number,
): TriageResult {
  const scaffoldById = new Map(scaffolds.map(s => [s.id, s]));

  const items: Triaged[] = collectDirs(root, thresholdBytes).map(({ node, containedIn }) => {
    const t = classify(node, scaffoldById);
    return containedIn ? { ...t, containedIn } : t;
  });

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

// 导出给 triage-cache.ts 复用（spec §3「规则先行」：scaffold 命中零成本即时判定）
export function classify(n: Node, scaffoldById: Map<string, Scaffold>): Triaged {
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
