import { ShieldCheck, ShieldAlert, ShieldX, Loader2, Trash2, FolderInput, X } from 'lucide-react';
import { useState } from 'react';
import type { Node, AdvisorResponse, Plan } from '../types';
import { formatBytes } from '../format';
import { api } from '../api';

type Props = {
  node: Node;
  advice: AdvisorResponse | null;
  onComplete: (reclaimedBytes: number) => void;
  onSkip: () => void;
  onInspect: () => Promise<void>;
};

export function AdvisorCard({ node, advice, onComplete, onSkip, onInspect }: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const ShieldIcon = !advice
    ? Loader2
    : advice.risk === 'low'
      ? ShieldCheck
      : advice.risk === 'medium'
        ? ShieldAlert
        : ShieldX;

  const accent =
    advice?.risk === 'low' ? '#ffa3c7' : advice?.risk === 'medium' ? '#ffb37a' : advice?.risk === 'high' ? '#ff5d7a' : '#a17a8d';

  const act = async (action: 'recycle' | 'quarantine' | 'delete') => {
    setBusy(true);
    setErr(null);
    try {
      const plan: Plan = {
        action,
        paths: [node.path],
        reason: advice?.reasoning ?? `Diskwise auto-walk: ${node.path}`,
      };
      await api.execute(plan, false);
      onComplete(node.size);
    } catch (e: unknown) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ borderColor: accent }}>
      <div className="card-head">
        <ShieldIcon size={18} className={!advice ? 'spin' : ''} style={{ color: accent }} />
        <div className="card-title">
          <div className="card-name" title={node.path}>{node.name}</div>
          <div className="card-path">{node.path}</div>
        </div>
        <button className="ghost icon" onClick={onSkip} title="Skip"><X size={16} /></button>
      </div>

      <div className="card-meta">
        <strong>{formatBytes(node.size)}</strong>
        <span>· {node.file_count.toLocaleString()} 个文件</span>
        {advice?.suggested_scaffold && <span>· 建议脚本：<code>{advice.suggested_scaffold}</code></span>}
      </div>

      {!advice ? (
        <div className="card-body muted">AI 思考中…</div>
      ) : (
        <>
          <div className="card-what"><strong>这是什么：</strong> {advice.what}</div>
          <div className="card-reason">{advice.reasoning}</div>
          {advice.needs_inspection && (
            <button className="ghost full" onClick={onInspect}>让 AI 看更深（抽样子路径再判一次）</button>
          )}
        </>
      )}

      {err && <div className="error">{err}</div>}

      <div className="card-actions">
        <button className="primary" disabled={busy || !advice} onClick={() => act('recycle')}>
          <Trash2 size={14} /> 进回收站（{formatBytes(node.size)}）
        </button>
        <button className="secondary" disabled={busy || !advice} onClick={() => act('quarantine')}>
          <FolderInput size={14} /> 隔离
        </button>
        <button className="ghost" disabled={busy} onClick={onSkip}>保留</button>
      </div>
    </div>
  );
}
