import { useMemo, useState } from 'react';
import { ShieldCheck, ShieldAlert, ShieldX, Trash2, FolderInput, X } from 'lucide-react';
import type { Node, Scaffold, Plan } from '../types';
import { formatBytes } from '../format';
import { api } from '../api';
import { ProgressButton } from './ProgressButton';

type Props = {
  node: Node;
  scaffold: Scaffold;
  onComplete: (bytes: number) => void;
  onSkip: () => void;
};

export function ScaffoldPanel({ node, scaffold, onComplete, onSkip }: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [scopePrompts, setScopePrompts] = useState<Record<string, number | string | boolean>>(() => {
    const init: Record<string, number | string | boolean> = {};
    for (const sc of scaffold.scopes) {
      if (sc.prompt && sc.prompt.kind !== 'none') {
        init[sc.id] = sc.prompt.kind === 'days' || sc.prompt.kind === 'bytes'
          ? sc.prompt.default
          : sc.prompt.kind === 'choice'
            ? sc.prompt.default
            : true;
      }
    }
    return init;
  });
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(scaffold.scopes.map((s) => [s.id, true])),
  );

  const ShieldIcon = scaffold.risk === 'low' ? ShieldCheck : scaffold.risk === 'medium' ? ShieldAlert : ShieldX;
  const accent = scaffold.risk === 'low' ? '#ffa3c7' : scaffold.risk === 'medium' ? '#ffb37a' : '#ff5d7a';

  const total = useMemo(() => node.size, [node]);

  const sweep = async () => {
    setBusy(true);
    setErr(null);
    try {
      const reasons: string[] = [];
      let reclaimed = 0;
      for (const sc of scaffold.scopes) {
        if (!enabled[sc.id]) continue;
        const plan: Plan = {
          action: sc.mode,
          paths: [node.path],
          reason: `Pinkbin scaffold ${scaffold.id}/${sc.id}: ${JSON.stringify(scopePrompts[sc.id] ?? null)}`,
        };
        await api.execute(plan, false);
        reasons.push(sc.id);
        reclaimed += node.size;
      }
      onComplete(reclaimed > 0 ? Math.min(reclaimed, total) : total);
    } catch (e: unknown) {
      setErr(String(e));
      throw e;
    } finally {
      setBusy(false);
    }
  };

  const quarantineFolder = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.execute(
        { action: 'quarantine', paths: [node.path], reason: 'manual quarantine' },
        false,
      );
      onComplete(total);
    } catch (e: unknown) {
      setErr(String(e));
      throw e;
    } finally {
      setBusy(false);
    }
  };

  // sweep does one path-level shell op per enabled scope (api.execute with
  // paths: [node.path]) — that's directory granularity, count = enabled
  // scope count. Pick the dominant mode from enabled scopes; mixed sets
  // fall back to the most-conservative (recycle).
  const enabledScopeCount = scaffold.scopes.filter((s) => enabled[s.id]).length;
  const sweepMode: 'recycle' | 'quarantine' | 'delete' = (() => {
    const modes = new Set(
      scaffold.scopes.filter((s) => enabled[s.id]).map((s) => s.mode),
    );
    if (modes.size === 1) {
      const m = [...modes][0];
      if (m === 'delete' || m === 'quarantine' || m === 'recycle') return m;
    }
    return 'recycle';
  })();

  return (
    <div className="card" style={{ borderColor: accent }}>
      <div className="card-head">
        <ShieldIcon size={18} style={{ color: accent }} />
        <div className="card-title">
          <div className="card-name">{scaffold.name}</div>
          <div className="card-path">{node.path}</div>
        </div>
        <button className="ghost icon" onClick={onSkip} title="Skip"><X size={16} /></button>
      </div>

      <div className="card-meta">
        <strong>{formatBytes(total)}</strong>
        <span>· {node.file_count.toLocaleString()} 个文件</span>
        <span className="badge">脚本 · {scaffold.id}</span>
      </div>

      <div className="card-disclaimer">{scaffold.disclaimer}</div>

      <div className="scopes">
        {scaffold.scopes.map((sc) => (
          <div key={sc.id} className="scope">
            <label className="scope-row">
              <input
                type="checkbox"
                checked={!!enabled[sc.id]}
                onChange={(e) => setEnabled((s) => ({ ...s, [sc.id]: e.target.checked }))}
              />
              <span className="scope-label">{sc.label}</span>
              <span className="scope-mode">{sc.mode}</span>
            </label>
            {sc.prompt && sc.prompt.kind === 'days' && (
              <label className="prompt">
                <span>{sc.prompt.label ?? 'Older than (days)'}</span>
                <input
                  type="number"
                  min={0}
                  value={Number(scopePrompts[sc.id] ?? sc.prompt.default)}
                  onChange={(e) => setScopePrompts((s) => ({ ...s, [sc.id]: Number(e.target.value) }))}
                />
              </label>
            )}
            {sc.prompt && sc.prompt.kind === 'choice' && (
              <label className="prompt">
                <span>{sc.prompt.label ?? 'Option'}</span>
                <select
                  value={String(scopePrompts[sc.id] ?? sc.prompt.default)}
                  onChange={(e) => setScopePrompts((s) => ({ ...s, [sc.id]: e.target.value }))}
                >
                  {sc.prompt.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </label>
            )}
          </div>
        ))}
      </div>

      {err && <div className="error">{err}</div>}

      <div className="card-actions">
        <ProgressButton
          className="primary"
          disabled={busy}
          estimatedCount={Math.max(1, enabledScopeCount)}
          granularity="directory"
          mode={sweepMode}
          onAction={sweep}
          idleContent={<><Trash2 size={14} /> 清理选中范围</>}
        />
        <ProgressButton
          className="secondary"
          disabled={busy}
          estimatedCount={1}
          granularity="directory"
          mode="quarantine"
          onAction={quarantineFolder}
          idleContent={<><FolderInput size={14} /> 隔离整个文件夹</>}
          runningLabel="隔离中"
        />
        <button className="ghost" disabled={busy} onClick={onSkip}>保留</button>
      </div>
    </div>
  );
}
