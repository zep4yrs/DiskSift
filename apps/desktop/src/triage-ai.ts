// AI 批量分诊（docs/triage-overlay-spec.md §2/§6/§7，切片 O2 + O3 部分）。
// 已覆盖：O2 批量分诊 + 渐进上色 + 判定缓存；O3 反馈闭环（忽略入库/重问附提示）、
// 迁移 v1 纯文案、§5.1 起草脚本入口（AI 起草 + 前端红线门禁 checkScaffoldRedlines；
// 「保存到用户脚本目录」因后端暂无写盘命令，以复制 + 指引替代，见 DraftScaffoldModal）。
// 候选 = 无规则判定（无 scaffold 命中、不在 NEVER_TOUCH）且 >= 巡查阈值的目录；
// 串行请求（spec §6：可随时停止）；载荷 = 既有元数据格式（AutoWalk 同款：
// 路径/大小/文件数/扩展名分布/≤20 条抽样路径/邻居名），绝不读文件内容。
// AI 判定映射五判定 + 迁移 v1 纯文案启发（spec §7 决策 3）。

import { api } from './api';
import type { AdvisorRequest, AdvisorResponse, Node } from './types';
import { isNeverTouch } from './triage';
import type { CachedVerdict } from './triage-cache';

/** 批量分诊候选：深度>0、>= 阈值、never-touch 之外、无 scaffold 命中（未识别）。
 *  按体积降序（spec §2：大目录先亮）。 */
export function pickAiTriageTargets(root: Node, thresholdBytes: number): Node[] {
  const out: Node[] = [];
  const visit = (n: Node, depth: number, inNever: boolean): void => {
    if (!n.is_dir) return;
    const never = inNever || isNeverTouch(n.path);
    if (depth > 0 && !never && !n.scaffold_id && n.size >= thresholdBytes) {
      out.push(n);
      return; // 已是分析单元，不再下钻（子目录留给「下钻后 overlay 按需重判」）
    }
    for (const c of n.children) {
      if (c.is_dir) visit(c, depth + 1, never);
    }
  };
  visit(root, 0, false);
  out.sort((a, b) => b.size - a.size);
  return out;
}

/** AutoWalk 同款载荷（api.ts AdvisorRequest）：元数据 + ≤20 条抽样路径。 */
export function buildAdvisorRequest(node: Node, samples: string[], userNote?: string): AdvisorRequest {
  const totalBytes = node.size || 1;
  const req: AdvisorRequest = {
    path: node.path,
    size_bytes: node.size,
    file_count: node.file_count,
    top_extensions: node.top_extensions.slice(0, 6).map((e) => ({ ext: e.ext, share: e.bytes / totalBytes })),
    sample_paths: samples,
    neighbors: node.children.slice(0, 6).map((c) => c.name),
    scaffold_hint: null,
  };
  if (userNote) req.user_note = userNote;
  return req;
}

/** 用户曾忽略的目录，重问时附上反馈提示（spec §5.3：越用越准）。 */
export const IGNORED_NOTE = '用户此前忽略了此目录的 AI 判定，说明 AI 上次的结论不符合用户预期，请给出更谨慎、更具体的依据。';

/**
 * AdvisorResponse → 五判定映射（triage-overlay-spec §3）：
 * - needs_inspection=true            → uncertain（白虚线，spec 原文）；
 * - safe_to_delete=true              → safe；
 * - category=system                  → system；
 * - C 盘 + 装机型（游戏/模型权重/未识别的大目录）→ migrate（v1 纯文案建议，
 *   spec §3 的注册表/卷线索属 v2 深链，先用响应特征做保守启发）；
 * - 其余                              → decide（占用大需决策）。
 */
export function advisorToVerdict(resp: AdvisorResponse, path: string): { verdict: CachedVerdict['verdict']; reason: string } {
  const reasoning = (resp.reasoning || resp.what || '').trim();
  if (resp.needs_inspection) {
    return { verdict: 'uncertain', reason: reasoning || 'AI 需要看更深一层才能判断' };
  }
  if (resp.safe_to_delete) {
    return { verdict: 'safe', reason: `${resp.what} · ${reasoning}`.replace(/^ · /, '') };
  }
  if (resp.category === 'system') {
    return { verdict: 'system', reason: `${resp.what} · ${reasoning}`.replace(/^ · /, '') };
  }
  const onCDrive = /^[Cc]:[\\/]/.test(path);
  // 保守启发：只把明确的「装机型」类目（游戏 / 模型权重）谈迁移；
  // unknown 一律 decide（占用大需决策），避免对 AI 没认出来的目录乱提迁移。
  const installish = resp.category === 'game_data' || resp.category === 'model_weights';
  if (onCDrive && installish) {
    return { verdict: 'migrate', reason: `${resp.what} · 装在 C 盘的大体积目录，适合整体迁移到其他磁盘` };
  }
  return { verdict: 'decide', reason: `${resp.what} · ${reasoning}`.replace(/^ · /, '') };
}

/** 缓存签名命中（目录没变且有生效 AI 判定）→ 无需重问 AI（spec §2 缓存）。 */
export function cacheHitFor(node: Node, cache: Map<string, CachedVerdict>): boolean {
  const c = cache.get(node.path);
  return !!c && c.bytes === node.size && c.fileCount === node.file_count && c.verdict !== 'user-ignored';
}

export interface AiTriageHooks {
  /** 每个判定落地即回调（渐进上色：调用方 setState 后渲染自然生效） */
  onVerdict: (path: string, entry: CachedVerdict) => void;
  onProgress: (done: number, total: number) => void;
  shouldStop: () => boolean;
}

export interface AiTriageOutcome {
  applied: number;   // 本次新判定（含缓存直接复用）
  skipped: number;   // 缓存签名命中直接复用、未发请求
  failed: number;
  stopped: boolean;
  errors: string[];
}

/** 串行执行批量分诊（spec §6：串行 + 可随时停止）。每个目标：
 *  缓存签名命中（非忽略）→ 直接复用不请求；否则 api.advise 一次。
 *  onVerdict 落地即回调，调用方负责入缓存 Map 并持久化。 */
export async function runAiTriage(
  targets: Node[],
  cache: Map<string, CachedVerdict>,
  hooks: AiTriageHooks,
): Promise<AiTriageOutcome> {
  const outcome: AiTriageOutcome = { applied: 0, skipped: 0, failed: 0, stopped: false, errors: [] };
  let done = 0;
  for (const node of targets) {
    if (hooks.shouldStop()) {
      outcome.stopped = true;
      break;
    }
    const cached = cache.get(node.path);
    if (cacheHitFor(node, cache)) {
      // 目录没变不重问 AI（spec §2 缓存）；判定已在缓存里，回调让调用方确保上色
      outcome.skipped += 1;
      outcome.applied += 1;
    } else {
      try {
        const ignored = cached?.verdict === 'user-ignored';
        const samples = await api.inspect(node.path, 20).catch(() => [] as string[]);
        const req = buildAdvisorRequest(node, samples, ignored ? IGNORED_NOTE : undefined);
        const advice = await api.advise(req);
        const { verdict, reason } = advisorToVerdict(advice, node.path);
        hooks.onVerdict(node.path, {
          verdict, reason,
          bytes: node.size, fileCount: node.file_count,
          source: 'ai', ts: Date.now(),
        });
        outcome.applied += 1;
      } catch (e) {
        outcome.failed += 1;
        outcome.errors.push(`${node.path}: ${String(e)}`);
      }
    }
    done += 1;
    hooks.onProgress(done, targets.length);
  }
  return outcome;
}

/** §7 决策 4：免费 AI 接入引导（点「去设置」直达设置页并预填）。 */
export interface FreeAiPath {
  key: string;
  label: string;
  note: string;
  baseUrl: string;
  model: string;
}

export const FREE_AI_PATHS: FreeAiPath[] = [
  {
    key: 'ollama',
    label: '本地 Ollama（零成本 · 离线）',
    note: '需本机已安装 Ollama 并拉取过模型；模型名可改成你已拉取的任意一个',
    baseUrl: 'http://localhost:11434',
    model: 'qwen3:8b',
  },
  {
    key: 'glm-flash',
    label: 'GLM-4-Flash（智谱官方免费档）',
    note: '注册 bigmodel.cn 领取免费额度，无需付费',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
  },
  {
    key: 'siliconflow',
    label: '硅基流动 · 免费模型',
    note: '注册 siliconflow.cn 后可用免费档模型；模型名以其模型广场为准',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'THUDM/glm-4-9b-chat',
  },
];

// ── §5.1 起草脚本红线门禁 ────────────────────────────────────────────────
// 红线清单 = 仓库 CLAUDE.md 硬规则 1：任何 scope 的 glob 不允许命中聊天/账号
// DB（*.db 族、db_storage）、聊天消息（Msg、MultiMsg）、账号状态（Accounts、
// All Users、login、config）、用户收藏（Favorite*、Fav）、加密物料（key、crypto）。
// 前端实现为保守的片段/段名匹配——宁可错拒不可漏放（spec §5.1：不过线直接拒绝）。

/** 文件通配族（*.db 前缀同时覆盖 *.db-wal / *.db-shm）。 */
const REDLINE_FILE_GLOBS = ['*.db'];
/** 路径段名（段级精确匹配，避免 messages 之类误伤）。 */
const REDLINE_SEGMENT_NAMES = ['db_storage', 'msg', 'multimsg', 'accounts', 'all users', 'login', 'config', 'key', 'crypto'];
/** 段名前缀（Favorite、Fav 等用户收藏族，带星号通配）。 */
const REDLINE_SEGMENT_PREFIXES = ['fav'];

/** 校验起草的 scaffold TOML。返回违规原因列表；空数组 = 过线。 */
export function checkScaffoldRedlines(toml: string): string[] {
  if (!/\[\[scope\]\]/.test(toml)) {
    return ['未找到任何 [[scope]] 条目——不是可用的 scaffold 结构'];
  }
  const globs = [...toml.matchAll(/\bglob\s*=\s*"([^"]+)"/gi)].map((m) => m[1]);
  if (globs.length === 0) {
    return ['没有任何 scope 声明 glob——无法校验红线'];
  }
  const violations: string[] = [];
  for (const g of globs) {
    const lower = g.toLowerCase();
    if (REDLINE_FILE_GLOBS.some((f) => lower.includes(f))) {
      violations.push(`glob「${g}」命中聊天/账号 DB 红线（*.db 族，含 -wal/-shm）`);
      continue;
    }
    for (const segRaw of lower.split('/')) {
      const seg = segRaw.replace(/\*/g, '').trim();
      if (!seg) continue;
      if (REDLINE_SEGMENT_NAMES.includes(seg) || REDLINE_SEGMENT_PREFIXES.some((p) => seg.startsWith(p))) {
        violations.push(`glob「${g}」命中红线片段「${seg}」（聊天消息/账号状态/收藏/加密物料保护区）`);
        break;
      }
    }
  }
  // 起草稿只允许回收站模式（CLAUDE.md：默认 recycle，delete 仅用户显式选择）
  const modes = [...toml.matchAll(/\bmode\s*=\s*"([^"]+)"/gi)].map((m) => m[1].toLowerCase());
  if (modes.length > 0 && modes.some((m) => m !== 'recycle')) {
    violations.push('存在 mode 不是 "recycle" 的 scope——起草稿只允许回收站模式（可恢复）');
  }
  return violations;
}

/** 起草 prompt 的系统说明（14-phase 裁剪版，spec §5.1）。 */
export const DRAFT_SYSTEM_PROMPT = `你是 DiskSift 的 scaffold 起草器。给定一个目录的元数据，按 14-phase 工作流的裁剪版起草一个用户级清理 scaffold（TOML）。
裁剪版步骤：
1. 从元数据推断这是什么软件/目录，取一个稳定的 id（小写连字符）。
2. 只把「缓存、日志、崩溃转储、临时文件、接收的媒体缓存」列为清理目标；聊天记录、账号、收藏、加密物料绝对不碰。
3. 每类目标写一个 [[scope]]，含 id、label（中文）、glob、mode = "recycle"。
4. glob 用 ** 与 * 描述相对结构，不要写绝对盘符路径。
5. 红线（任何 glob 都不允许出现）：*.db、*.db-wal、*.db-shm、db_storage、Msg、MultiMsg、Accounts、All Users、login、config、Favorite*、Fav、key、crypto。
6. disclaimer 用中文写清风险与可恢复性，宁保守不夸大。
输出：只输出 TOML 源码（第一行是 id = "..."），不要 markdown 代码块，不要任何解释。`;
