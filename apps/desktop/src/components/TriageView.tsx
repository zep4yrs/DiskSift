import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Trash2, Sparkles, Lock, AlertCircle } from 'lucide-react';
import type { Node } from '../types';
import { triage, isNeverTouch, BUCKET_META, type Bucket, type Triaged } from '../triage';
import { verdictToBucket, type VerdictEntry } from '../triage-cache';
import { Icon } from './Icon';
import { useStore } from '../store';
import { formatBytes } from '../format';
import { api } from '../api';

type Props = {
  root: Node;
  thresholdBytes: number;
  onJumpToWalk: (item: Triaged) => void;
  onSelect: (path: string) => void;
  /** applyCache 合并判定索引（规则 + AI 缓存，user-ignored 已回落规则）。
   *  传入时 safe/heavy 等分组按最终判定重排（v26.1.2 复核 ①：与 treemap
   *  聚合徽标同口径，AI 判过的目录不再滞留「未识别」组）；不传 = 纯规则。 */
  verdicts?: Map<string, VerdictEntry>;
};

export function TriageView({ root, thresholdBytes, onJumpToWalk, onSelect, verdicts }: Props) {
  const scaffolds = useStore((s) => s.scaffolds);
  const result = useMemo(() => triage(root, scaffolds, thresholdBytes), [root, scaffolds, thresholdBytes]);
  const addReclaimed = useStore((s) => s.addReclaimed);

  // ── 分组口径一致化（v26.1.2 复核 ①）─────────────────────────────────
  // triage() 只认规则；这里把合并索引里 AI 层的最终判定并进分组。规则：
  // - 只改桶 entry.source === 'ai' 的条目（规则条目与 classify 同构，重排只会
  //   丢 heavy/stale/unknown 区分——decide 判定不携带该信息）；
  // - 桥接用 verdictToBucket（safe→safe，decide/migrate→heavy，uncertain→unknown，
  //   system→system），AI 理由随条目展示；
  // - user-ignored 在 applyCache 被跳过（回落规则判定）→ 不会被 AI 改桶，
  //   缓存/规则/忽略三来源不重不漏；每路径仍恰一项，计数不翻倍；
  // - 安全面不放松：never-touch/system 是规则终审（applyCache ruleFinal），
  //   AI 判定覆盖不到，一键回收永远够不到系统目录。
  const byBucket = useMemo(() => {
    if (!verdicts || verdicts.size === 0) return result.byBucket;
    const buckets: Record<Bucket, Triaged[]> = { safe: [], heavy: [], stale: [], system: [], unknown: [] };
    for (const it of result.items) {
      const e = verdicts.get(it.node.path);
      if (e && e.source === 'ai') {
        const b = verdictToBucket(e.verdict);
        buckets[b].push(b === it.bucket ? it : { ...it, bucket: b, reason: e.reason });
      } else {
        buckets[it.bucket].push(it);
      }
    }
    return buckets;
  }, [result, verdicts]);
  const totalsByBucket = useMemo(() => {
    const t: Record<Bucket, number> = { safe: 0, heavy: 0, stale: 0, system: 0, unknown: 0 };
    (Object.keys(byBucket) as Bucket[]).forEach((b) =>
      byBucket[b].forEach((it) => { t[b] += it.node.size; }));
    return t;
  }, [byBucket]);

  const [expanded, setExpanded] = useState<Record<Bucket, boolean>>({
    safe: true, heavy: true, stale: false, system: false, unknown: true,
  });
  const toggle = (b: Bucket) => setExpanded((e) => ({ ...e, [b]: !e[b] }));

  const order: Bucket[] = ['safe', 'heavy', 'stale', 'unknown', 'system'];

  return (
    // 平铺列表（用户 2026-09-27：不要卡片）——全 editor 底、分组标题行、空桶收成一行
    <div className="triage">
      <div className="triage-header">
        <div className="triage-title">扫描诊断</div>
        <div className="triage-sub">
          总计 {formatBytes(root.size)} · {root.file_count.toLocaleString()} 个文件 ·
          按风险与可清性分成 5 类 · 点行进入巡查处理
        </div>
      </div>

      <div className="triage-list">
        {order.map((b) => (
          <BucketSection
            key={b}
            bucket={b}
            items={byBucket[b]}
            totalBytes={totalsByBucket[b]}
            expanded={expanded[b]}
            onToggle={() => toggle(b)}
            onJumpToWalk={onJumpToWalk}
            onSelect={onSelect}
            addReclaimed={addReclaimed}
          />
        ))}
      </div>

      {result.items.length === 0 && (
        <div className="empty">
          <div className="empty-title">没找到大于阈值的目录</div>
          <div className="empty-sub">把巡查阈值调小（侧栏可改）再扫描。</div>
        </div>
      )}
    </div>
  );
}

function BucketSection({
  bucket, items, totalBytes, expanded, onToggle, onJumpToWalk, onSelect, addReclaimed,
}: {
  bucket: Bucket;
  items: Triaged[];
  totalBytes: number;
  expanded: boolean;
  onToggle: () => void;
  onJumpToWalk: (it: Triaged) => void;
  onSelect: (p: string) => void;
  addReclaimed: (n: number) => void;
}) {
  const meta = BUCKET_META[bucket];
  // 每桶专属 Lucide 图标 + 语义色（替代 emoji）。颜色统一取 BUCKET_META.tone
  // （§1-B：令牌化后单一出处，此处不再自带 hex；图标内联 style 支持 var()）
  const BUCKET_ICONS: Record<Bucket, { name: string; color: string }> = {
    safe: { name: 'circle-check', color: BUCKET_META.safe.tone },
    heavy: { name: 'flame', color: BUCKET_META.heavy.tone },
    stale: { name: 'clock', color: BUCKET_META.stale.tone },
    system: { name: 'shield', color: BUCKET_META.system.tone },
    unknown: { name: 'circle-help', color: BUCKET_META.unknown.tone },
  };
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 两步确认：首点进入预备态（按钮变红），5 秒内再点才执行，超时自动复位。
  // 不用 window.confirm —— Tauri webview 里行为不稳定（仓库 CLAUDE.md 硬规则）。
  const [armed, setArmed] = useState(false);
  const armTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (armTimerRef.current !== null) window.clearTimeout(armTimerRef.current);
  }, []);

  const oneClickClean = async () => {
    if (items.length === 0) return;
    if (!armed) {
      setErr(null);
      setArmed(true);
      if (armTimerRef.current !== null) window.clearTimeout(armTimerRef.current);
      armTimerRef.current = window.setTimeout(() => {
        armTimerRef.current = null;
        setArmed(false);
      }, 5000);
      return;
    }
    if (armTimerRef.current !== null) {
      window.clearTimeout(armTimerRef.current);
      armTimerRef.current = null;
    }
    setArmed(false);
    setBusy(true);
    setErr(null);
    try {
      let total = 0;
      // v26.1.2 下钻收集：safe 桶可能出现嵌套（父目录与其 ≥阈值的 safe 子目录
      // 都在列）。父目录先进回收站后子路径已不存在——按已清扫祖先前缀跳过
      // 子项，字节不重复计入（子项字节本就含于父项，徽标口径同理封顶）。
      const sweptAncestors: string[] = [];
      for (const it of items) {
        const p = it.node.path;
        if (sweptAncestors.some((a) => p.startsWith(a + '\\') || p.startsWith(a + '/'))) {
          continue;
        }
        await api.execute({
          action: 'recycle',
          paths: [p],
          reason: `Triage one-click safe sweep: ${it.reason}`,
        }, false);
        total += it.node.size;
        sweptAncestors.push(p);
      }
      addReclaimed(total);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  // 空桶收成一行（不占整卡）；有内容的桶 = 分组标题行 + 平铺行列表
  if (items.length === 0) {
    return (
      <div className="tgroup empty-group" onClick={onToggle}>
        <span className="tgroup-icon"><Icon name={BUCKET_ICONS[bucket].name} size={15} style={{ color: BUCKET_ICONS[bucket].color }} /></span>
        <span className="tgroup-label">{meta.label}</span>
        <span className="tgroup-empty">0 项</span>
      </div>
    );
  }

  return (
    <div className="tgroup">
      <div className="tgroup-head" onClick={onToggle}>
        <span className="tgroup-icon"><Icon name={BUCKET_ICONS[bucket].name} size={15} style={{ color: BUCKET_ICONS[bucket].color }} /></span>
        <span className="tgroup-label">{meta.label}</span>
        <span className="tgroup-sub">{meta.description}</span>
        <span className="tgroup-meta">{items.length} 项 · {formatBytes(totalBytes)}</span>
        <span className="tgroup-caret">{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
      </div>

      {expanded && (
        <div className="tgroup-body">
          {bucket === 'safe' && (
            <div className="tgroup-actions">
              <button
                className={'primary' + (armed ? ' armed' : '')}
                disabled={busy}
                title={armed ? '5 秒内再点一次执行' : '点一次进入预备状态，再点一次才执行'}
                onClick={(e) => { e.stopPropagation(); oneClickClean(); }}
              >
                <Trash2 size={14} /> {armed ? '再点确认' : `一键全部回收（${formatBytes(totalBytes)}）`}
              </button>
              <span className="tgroup-note">所有项都会进系统回收站，可恢复</span>
            </div>
          )}
          {bucket === 'system' && (
            <div className="tgroup-actions">
              <Lock size={14} /> <span>这些目录不会让你删 — 用 Windows 控制面板/卸载程序处理</span>
            </div>
          )}
          {err && <div className="error">{err}</div>}

          {items.map((it) => (
            <BucketRow
              key={it.node.path}
              item={it}
              bucket={bucket}
              onJumpToWalk={onJumpToWalk}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BucketRow({
  item, bucket, onJumpToWalk, onSelect,
}: {
  item: Triaged;
  bucket: Bucket;
  onJumpToWalk: (it: Triaged) => void;
  onSelect: (p: string) => void;
}) {
  return (
    <div className="trow-item" onClick={() => onSelect(item.node.path)}>
      <div className="trow-main">
        <div className="trow-name">{item.node.name}</div>
        <div className="trow-path">{item.node.path}</div>
        <div className="trow-reason">
          {item.reason}
          {/* v26.1.2 下钻收集：嵌套入列的子项标注「含于父目录」——父项整目录
              回收时本项随之消失，提示避免重复操作困惑。 */}
          {item.containedIn && (
            <span className="muted"> · 含于 {item.containedIn.split(/[\\/]/).pop()}</span>
          )}
        </div>
      </div>
      <div className="trow-size">{formatBytes(item.node.size)}</div>
      <div className="trow-action">
        {bucket === 'system' || isNeverTouch(item.node.path) ? (
          // v26.1.2 高危修复：never-touch 目录即使因数据异常落进 unknown 桶，
          // 也不提供「让 AI 分析」（防御纵深；正常路径 classify 已把它判 system）。
          <Lock size={14} style={{ color: 'var(--fg-muted)' }} />
        ) : (
          <button className="ghost" onClick={(e) => { e.stopPropagation(); onJumpToWalk(item); }}>
            {bucket === 'unknown' ? <><Sparkles size={12} /> 让 AI 分析</> : <><AlertCircle size={12} /> 详细处理</>}
          </button>
        )}
      </div>
    </div>
  );
}
