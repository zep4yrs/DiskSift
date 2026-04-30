import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Trash2, Sparkles, Lock, AlertCircle } from 'lucide-react';
import type { Node } from '../types';
import { triage, BUCKET_META, type Bucket, type Triaged } from '../triage';
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
    <div className="triage">
      <div className="triage-header">
        <div className="triage-title">扫描诊断</div>
        <div className="triage-sub">
          总计 {formatBytes(root.size)} · {root.file_count.toLocaleString()} 个文件 ·
          按风险与可清性分成 5 类
        </div>
      </div>

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

      {result.items.length === 0 && (
        <div className="empty">
          <div className="empty-title">没找到大于阈值的目录</div>
          <div className="empty-sub">把顶栏阈值调小（比如 0.1 GB）再扫描。</div>
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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const oneClickClean = async () => {
    if (items.length === 0) return;
    if (!confirm(`即将把 ${items.length} 项（共 ${formatBytes(totalBytes)}）移到回收站。确认？`)) return;
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

  return (
    <section className="bucket" style={{ borderColor: meta.tone }}>
      <header className="bucket-head" onClick={onToggle}>
        <span className="bucket-emoji">{meta.emoji}</span>
        <div className="bucket-title-wrap">
          <div className="bucket-title">
            {meta.label} <span className="bucket-count">· {items.length} 项</span>
          </div>
          <div className="bucket-sub">{meta.description}</div>
        </div>
        <div className="bucket-bytes">{formatBytes(totalBytes)}</div>
        <span className="bucket-caret">{expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
      </header>

      {expanded && (
        <div className="bucket-body">
          {bucket === 'safe' && items.length > 0 && (
            <div className="bucket-actions">
              <button className="primary" disabled={busy} onClick={(e) => { e.stopPropagation(); oneClickClean(); }}>
                <Trash2 size={14} /> 一键全部回收（{formatBytes(totalBytes)}）
              </button>
              <span className="muted" style={{ marginLeft: 8 }}>
                所有项都会进系统回收站，可恢复
              </span>
            </div>
          )}
          {bucket === 'system' && (
            <div className="bucket-actions" style={{ color: 'var(--ink-2)' }}>
              <Lock size={14} /> <span>这些目录 Diskwise 不会让你删 — 用 Windows 控制面板/卸载程序处理</span>
            </div>
          )}
          {err && <div className="error">{err}</div>}

          {items.map((it) => (
            <BucketItem
              key={it.node.path}
              item={it}
              bucket={bucket}
              onJumpToWalk={onJumpToWalk}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function BucketItem({
  item, bucket, onJumpToWalk, onSelect,
}: {
  item: Triaged;
  bucket: Bucket;
  onJumpToWalk: (it: Triaged) => void;
  onSelect: (p: string) => void;
}) {
  return (
    <div className="bucket-row" onClick={() => onSelect(item.node.path)}>
      <div className="bucket-row-main">
        <div className="bucket-row-name">{item.node.name}</div>
        <div className="bucket-row-path">{item.node.path}</div>
        <div className="bucket-row-reason">{item.reason}</div>
      </div>
      <div className="bucket-row-size">{formatBytes(item.node.size)}</div>
      <div className="bucket-row-action">
        {bucket === 'system' ? (
          <Lock size={14} style={{ color: 'var(--ink-3)' }} />
        ) : (
          <button className="ghost" onClick={(e) => { e.stopPropagation(); onJumpToWalk(item); }}>
            {bucket === 'unknown' ? <><Sparkles size={12} /> 让 AI 分析</> : <><AlertCircle size={12} /> 详细处理</>}
          </button>
        )}
      </div>
    </div>
  );
}
