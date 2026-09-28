// AI 分诊图层 · 判定引擎 + 判定缓存（docs/triage-overlay-spec.md §2/§3/§4/§5，切片 O1+O2）。
// 规则层（O1）从既有扫描数据推导：scaffold 命中（triage.classify）+ NEVER_TOUCH 清单 +
// 体积阈值，零网络请求。AI 层（O2）的判定与用户反馈（忽略）以 CachedVerdict 形式
// 经 api.cacheGetAll / cacheSetAll 持久化到 triage-cache.json（§7 决策 1：
// %APPDATA% 存储目录，后端 tmp+rename 原子写），applyCache 按「路径+大小+文件数」
// 签名校验后并入同一张 Map——渲染层不区分来源。
// 规则复用 triage.ts 的同一份分类逻辑——同一目录在分诊列表 / 空间图 / 树视图三处一致。

import { useMemo } from 'react';
import type { Node, Scaffold } from './types';
import { classify, isNeverTouch } from './triage';
import { useStore } from './store';

/** 五判定（spec §3）。规则层只产出 safe / decide / system；
 *  migrate 由 AI 层映射（v1 纯文案，spec §7 决策 3），uncertain = AI needs_inspection。 */
export type Verdict = 'safe' | 'decide' | 'migrate' | 'system' | 'uncertain';

/** 判定来源：rule=本地规则；ai=AI 批量分诊；user=用户反馈（忽略）。 */
export type VerdictSource = 'rule' | 'ai' | 'user';

/** 用户「忽略此判定」在缓存里的形态（spec §5.3 反馈闭环）。
 *  不属于五判定：命中它的目录不上 AI 色（规则判定保留），且下次 AI prompt
 *  附带「用户曾忽略」提示。 */
export type IgnoredVerdict = 'user-ignored';

export interface VerdictEntry {
  verdict: Verdict;
  bytes: number;
  reason: string;
  source: VerdictSource;
}

/** triage-cache.json 的一条持久化记录。签名 = 路径（键）+ bytes + fileCount，
 *  目录没变才复用（spec §2：目录没变不重问 AI）。 */
export interface CachedVerdict {
  verdict: Verdict | IgnoredVerdict;
  bytes: number;
  fileCount: number;
  reason: string;
  source: 'ai' | 'user';
  ts: number;
}

/** 判定索引：verdicts = path → 判定；cleanableUnder = path → 子树内可清理字节聚合
 *  （祖先聚合徽标「🟢 X GB」的数据源，spec §2.1.1，渲染期读表零额外请求）。 */
export interface VerdictIndex {
  verdicts: Map<string, VerdictEntry>;
  cleanableUnder: Map<string, number>;
}

export const VERDICT_META: Record<Verdict, { label: string; color: string; description: string }> = {
  safe:     { label: '可清理', color: 'var(--verdict-safe)',     description: '缓存类，删了会自动重建' },
  decide:   { label: '需决策', color: 'var(--verdict-decide)',   description: '占用大但非缓存，要不要清你说了算' },
  migrate:  { label: '迁移',   color: 'var(--verdict-migrate)',  description: '建议迁移（v2 纯文案 · BlueTidy 深链在 v2）' },
  system:   { label: '系统',   color: 'var(--verdict-system)',   description: '系统/不能动，仅标识无动作' },
  uncertain:{ label: '不确定', color: 'var(--verdict-uncertain)',description: 'AI 不确定（needs_inspection）' },
};

const SYSTEM_REASON = '系统目录或用户文档，绝对不动';

/** 五判定 → TriageView 五桶桥（v26.1.2 复核 ①：列表分组与图层判定同口径）。
 *  decide / migrate 同归 heavy（「要不要清你说了算」族，非一键回收面）；
 *  uncertain 即未定 → unknown（继续留在「AI 不确定」组）；system 对 system。
 *  只对 entry.source === 'ai' 的条目使用——规则条目与 classify 同构，重排反而
 *  会丢 heavy/stale/unknown 的桶内区分（decide 判定不携带这个信息）。 */
export function verdictToBucket(v: Verdict): 'safe' | 'heavy' | 'system' | 'unknown' {
  if (v === 'safe') return 'safe';
  if (v === 'system') return 'system';
  if (v === 'uncertain') return 'unknown';
  return 'heavy';
}

const CACHE_VERSION = 1;

// ── 判定缓存文件（triage-cache.json）读写 ────────────────────────────────
// api.cacheGetAll 返回 JSON 文本（文件不存在返回 "{}"）；cacheSetAll 整体覆写
// （后端写前校验 JSON）。解析防御：坏数据按空缓存处理，绝不让图层瘫痪。

export function parseCache(json: string): Map<string, CachedVerdict> {
  const out = new Map<string, CachedVerdict>();
  try {
    const parsed: unknown = JSON.parse(json);
    const entries =
      parsed && typeof parsed === 'object' && 'entries' in (parsed as Record<string, unknown>)
        ? (parsed as { entries: unknown }).entries
        : parsed;
    if (!entries || typeof entries !== 'object') return out;
    for (const [path, raw] of Object.entries(entries as Record<string, unknown>)) {
      const e = raw as Partial<CachedVerdict>;
      if (
        typeof path === 'string' && path &&
        typeof e.bytes === 'number' && typeof e.fileCount === 'number' &&
        typeof e.reason === 'string' &&
        (e.source === 'ai' || e.source === 'user') &&
        typeof e.verdict === 'string' &&
        (VERDICT_META[e.verdict as Verdict] || e.verdict === 'user-ignored')
      ) {
        out.set(path, {
          verdict: e.verdict as CachedVerdict['verdict'],
          bytes: e.bytes,
          fileCount: e.fileCount,
          reason: e.reason,
          source: e.source,
          ts: typeof e.ts === 'number' ? e.ts : 0,
        });
      }
    }
  } catch {
    /* 坏缓存当空表，规则层照常工作 */
  }
  return out;
}

export function serializeCache(entries: Map<string, CachedVerdict>): string {
  return JSON.stringify({
    version: CACHE_VERSION,
    entries: Object.fromEntries(entries),
  });
}

// ── 规则判定（O1）───────────────────────────────────────────────────────

// TriageView 桶 → 图层判定（spec §3「复用 TriageView 既有的桶语义」）。
// heavy/unknown/stale 都归「占用大需决策」，但只对 >= 阈值的体积成立——
// 小目录不打扰（triage.classify 本就只对超过阈值的目录给这三个桶）。
function entryOf(node: Node, bucket: string, reason: string, thresholdBytes: number): VerdictEntry | null {
  if (bucket === 'system') {
    return { verdict: 'system', bytes: node.size, reason, source: 'rule' };
  }
  if (bucket === 'safe') {
    return { verdict: 'safe', bytes: node.size, reason, source: 'rule' };
  }
  if (node.size < thresholdBytes) return null;
  return { verdict: 'decide', bytes: node.size, reason, source: 'rule' };
}

/** 从扫描树推导全量规则判定。全深度 DFS：树视图可展开到任意层、空间图可下钻到
 *  任意目录，判定必须全覆盖；never-touch 片段都是路径子串，命中即整棵子树继承
 *  （省掉子孙的逐个字符串扫描）。判定 Map 按路径存（spec §2.0：下钻后 overlay 不丢）。 */
export function buildVerdicts(root: Node, scaffolds: Scaffold[], thresholdBytes: number): VerdictIndex {
  const verdicts = new Map<string, VerdictEntry>();
  const scaffoldById = new Map(scaffolds.map((s) => [s.id, s]));

  const visit = (n: Node, depth: number, inNever: boolean): void => {
    if (!n.is_dir) return;
    const never = inNever || isNeverTouch(n.path);
    if (depth > 0) {
      if (never) {
        verdicts.set(n.path, { verdict: 'system', bytes: n.size, reason: SYSTEM_REASON, source: 'rule' });
      } else if (n.scaffold_id || n.size >= thresholdBytes) {
        const t = classify(n, scaffoldById);
        const entry = entryOf(n, t.bucket, t.reason, thresholdBytes);
        if (entry) verdicts.set(n.path, entry);
      }
    }
    for (const c of n.children) {
      if (c.is_dir) visit(c, depth + 1, never);
    }
  };
  visit(root, 0, false);

  return { verdicts, cleanableUnder: aggregateCleanable(root, verdicts) };
}

/** 沿树向上聚合子树内可清理字节（spec §2.1.1 祖先聚合徽标）。缓存合并后
 *  对新判定 Map 重跑本函数即可刷新徽标。目录自身 safe 时以 n.size 封顶、
 *  不再下钻（n.size 已含整个子树，再叠加 safe 子目录的聚合会重复计数：
 *  P=10GB safe、子 C=2GB safe → 徽标会虚显示 12GB）。被封顶跳过的嵌套
 *  safe 子目录不产生徽标条目——不可见：徽标（pill）与详情卡「内含可清理」
 *  行对 verdict=safe 的目录本就不展示。
 *  口径（v26.1.2 复核 ①）：入参 verdicts 必须是 applyCache 合并后的索引——
 *  一路径恰一 entry（applyCache 优先级：scaffold/system 规则终审 > AI 覆盖
 *  占位），user-ignored 条目被跳过即回落规则判定；safe 封顶不下钻保证嵌套
 *  safe 不重复计数 → 缓存判定/规则判定/user-ignored 三来源不重不漏。与
 *  TriageView 分组计数的口径差仅两处、均为有意保留：① 列表保持 ≥ 巡查阈值
 *  门（空态文案「没找到大于阈值的目录」），徽标额外收录阈值以下的 scaffold
 *  命中 safe（发现面，spec §2.1.1「看到徽标 = 下面有货」）；② 列表 safe 桶
 *  经 verdictToBucket 桥接后与徽标同以「最终判定 = safe」为可清理口径。 */
export function aggregateCleanable(root: Node, verdicts: Map<string, VerdictEntry>): Map<string, number> {
  const out = new Map<string, number>();
  const visit = (n: Node): number => {
    if (!n.is_dir) return 0;
    if (verdicts.get(n.path)?.verdict === 'safe') {
      if (n.size > 0) out.set(n.path, n.size);
      return n.size;
    }
    let under = 0;
    for (const c of n.children) {
      if (c.is_dir) under += visit(c);
    }
    if (under > 0) out.set(n.path, under);
    return under;
  };
  visit(root);
  return out;
}

/** 「只看可清理」聚焦模式的淡化判定（spec §2.1.2：非可清理块淡至 12% 透明度）。
 *  判定来源 = applyCache 合并后的索引（规则 + AI + 忽略语义）：user-ignored 条目
 *  在 applyCache 里被跳过（triage-cache.ts §applyCache 注释：不上 AI 色、回落
 *  规则判定/无判定），本函数只读合并结果，忽略语义天然正确。
 *  可清理 = 自身判定 safe；祖先块虽非 safe 但子树内含可清理字节
 *  （cleanableUnder > 0，挂 🟢 聚合徽标的发现面，spec §2.1.1）同样保持可见——
 *  spec 本节的落点是「深层缓存目录一眼全可见」，把祖先链也压暗会让徽标一起
 *  消失，发现路径反而断掉。其余（含无判定的小目录/文件）淡显。 */
export function isFocusDimmed(
  entry: VerdictEntry | null | undefined,
  cleanableUnder: number | undefined,
): boolean {
  if (entry?.verdict === 'safe') return false;
  return (cleanableUnder ?? 0) === 0;
}

/** 缓存/AI 判定并入规则判定 Map（同一张 Map，渲染层无感知，spec §2「规则先行，AI 兜底」）。
 *  优先级：
 *  - 签名不符（大小/文件数变了）→ 丢弃缓存条目，目录已变该重新问；
 *  - user-ignored → 不上 AI 色（该目录回落到规则判定/无判定）；
 *  - 规则判定且目录有 scaffold 命中，或规则判为 system → 保留规则
 *   （scaffold/system 是确定性规则意见；未识别目录的 decide 是占位，AI 精化它）；
 *  - 其余 → AI 判定覆盖。 */
export function applyCache(index: VerdictIndex, root: Node, cache: Map<string, CachedVerdict>): VerdictIndex {
  if (cache.size === 0) return index;
  const verdicts = new Map(index.verdicts);

  const visit = (n: Node, depth: number): void => {
    if (!n.is_dir) return;
    if (depth > 0) {
      const c = cache.get(n.path);
      if (c && c.bytes === n.size && c.fileCount === n.file_count) {
        if (c.verdict !== 'user-ignored') {
          const cur = verdicts.get(n.path);
          const ruleFinal = !!n.scaffold_id || cur?.verdict === 'system';
          if (!cur || !ruleFinal) {
            verdicts.set(n.path, { verdict: c.verdict, bytes: n.size, reason: c.reason, source: 'ai' });
          }
        }
      }
    }
    for (const c of n.children) {
      if (c.is_dir) visit(c, depth + 1);
    }
  };
  visit(root, 0);

  return { verdicts, cleanableUnder: aggregateCleanable(root, verdicts) };
}

/** React 接线：扫描根/脚本库/阈值任一变化时重算（一次 O(目录数) DFS，memo 缓存）。 */
export function useVerdicts(root: Node | null, thresholdBytes: number): VerdictIndex {
  const scaffolds = useStore((s) => s.scaffolds);
  return useMemo(() => {
    if (!root) {
      return { verdicts: new Map<string, VerdictEntry>(), cleanableUnder: new Map<string, number>() };
    }
    return buildVerdicts(root, scaffolds, thresholdBytes);
  }, [root, scaffolds, thresholdBytes]);
}
