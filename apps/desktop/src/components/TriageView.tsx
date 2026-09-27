import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Trash2, Sparkles, Lock, AlertCircle } from 'lucide-react';
import type { Node } from '../types';
import { triage, BUCKET_META, type Bucket, type Triaged } from '../triage';
import { Icon } from './Icon';
import { useStore } from '../store';
import { formatBytes } from '../format';
import { api } from '../api';

type Props = {
  root: Node;
  thresholdBytes: number;
  onJumpToWalk: (item: Triaged) => void;
  onSelect: (path: string) => void;
};

export function TriageView({ root, thresholdBytes, onJumpToWalk, onSelect }: Props) {
  const scaffolds = useStore((s) => s.scaffolds);
  const result = useMemo(() => triage(root, scaffolds, thresholdBytes), [root, scaffolds, thresholdBytes]);
  const addReclaimed = useStore((s) => s.addReclaimed);

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
            items={result.byBucket[b]}
            totalBytes={result.totalsByBucket[b]}
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
  // 每桶专属 Lucide 图标 + 语义色（替代 emoji；色值取自 BUCKET_META.tone）
  const BUCKET_ICONS: Record<Bucket, { name: string; color: string }> = {
    safe: { name: 'circle-check', color: '#16a34a' },
    heavy: { name: 'flame', color: '#d97706' },
    stale: { name: 'clock', color: '#ca8a04' },
    system: { name: 'shield', color: 'var(--fg-muted)' },
    unknown: { name: 'circle-help', color: 'var(--info)' },
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
      for (const it of items) {
        await api.execute({
          action: 'recycle',
          paths: [it.node.path],
          reason: `Triage one-click safe sweep: ${it.reason}`,
        }, false);
        total += it.node.size;
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
        <div className="trow-reason">{item.reason}</div>
      </div>
      <div className="trow-size">{formatBytes(item.node.size)}</div>
      <div className="trow-action">
        {bucket === 'system' ? (
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
