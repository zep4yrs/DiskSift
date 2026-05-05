import { useEffect, useMemo, useState } from 'react';
import { X, Trash2, Loader2, AlertTriangle } from 'lucide-react';
import { api } from '../api';
import { formatBytes } from '../format';
import type { Node, Scaffold, Scope, CondaEnv } from '../types';

interface ScopeSize {
  scope_id: string;
  bytes: number;
  file_count: number;
}

const SCOPE_DAYS_STORAGE_KEY = 'diskwise.scopeDays';

function readScopeDaysAll(): Record<string, Record<string, number>> {
  try {
    const raw = localStorage.getItem(SCOPE_DAYS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function useScopeDays(scaffoldId: string, defaults: Record<string, number>) {
  const defaultsKey = JSON.stringify(defaults);
  const [days, setDays] = useState<Record<string, number>>(() => {
    const persisted = readScopeDaysAll()[scaffoldId] ?? {};
    return { ...defaults, ...persisted };
  });

  useEffect(() => {
    const persisted = readScopeDaysAll()[scaffoldId] ?? {};
    setDays({ ...defaults, ...persisted });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scaffoldId, defaultsKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const all = readScopeDaysAll();
      const overrides: Record<string, number> = {};
      for (const [k, v] of Object.entries(days)) {
        if (defaults[k] !== v) overrides[k] = v;
      }
      if (Object.keys(overrides).length === 0) {
        delete all[scaffoldId];
      } else {
        all[scaffoldId] = overrides;
      }
      try { localStorage.setItem(SCOPE_DAYS_STORAGE_KEY, JSON.stringify(all)); } catch { /* quota / private mode */ }
    }, 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scaffoldId, JSON.stringify(days), defaultsKey]);

  return [days, setDays] as const;
}

function detectVariants(matches: Node[]): Set<string> {
  const out = new Set<string>();
  for (const m of matches) {
    const p = m.path.replace(/\\/g, '/').toLowerCase();
    if (p.includes('xwechat_files') || p.includes('tencent/xwechat')) out.add('4.x');
    if (p.includes('wechat files') || p.includes('tencent/wechat')) out.add('3.x');
  }
  return out;
}

function aggregateScopeSizes(rowsList: ScopeSize[][]): ScopeSize[] {
  const merged = new Map<string, ScopeSize>();
  for (const rows of rowsList) {
    for (const r of rows) {
      const prev = merged.get(r.scope_id);
      if (prev) {
        prev.bytes += r.bytes;
        prev.file_count += r.file_count;
      } else {
        merged.set(r.scope_id, { scope_id: r.scope_id, bytes: r.bytes, file_count: r.file_count });
      }
    }
  }
  return [...merged.values()];
}

function formatLastActive(ts: number | null): string {
  if (ts === null) return '从未';
  const now = Math.floor(Date.now() / 1000);
  const diffSecs = Math.max(0, now - ts);
  const days = Math.floor(diffSecs / 86400);
  if (days < 1) return '今天';
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

interface Props {
  scaffold: Scaffold;
  matches: Node[];
  onClose: () => void;
  onCleaned: (bytes: number) => void;
}

export function CleanupModal({ scaffold: sc, matches, onClose, onCleaned }: Props) {
  const isConda = sc.id === 'conda';

  // ── Days inputs (per-scope, persisted across sessions) ──
  const defaultDays = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    for (const scope of sc.scopes ?? []) {
      if (scope.prompt?.kind === 'days') out[scope.id] = scope.prompt.default;
    }
    return out;
  }, [sc.scopes]);
  const [daysByScope, setDaysByScope] = useScopeDays(sc.id, defaultDays);

  // ── WeChat: per-account (wxid_*) filter ──
  const wxids = useMemo<string[]>(() => {
    const out = new Set<string>();
    for (const m of matches) {
      for (const c of m.children ?? []) {
        if (c.is_dir && c.name.startsWith('wxid_')) out.add(c.name);
      }
    }
    return [...out].sort();
  }, [matches]);
  const [selectedWxids, setSelectedWxids] = useState<Set<string>>(() => new Set(wxids));
  useEffect(() => { setSelectedWxids(new Set(wxids)); }, [wxids.join('|')]);
  const wxidFilterArg = wxids.length > 0 && selectedWxids.size < wxids.length
    ? [...selectedWxids]
    : undefined;
  const wxidKey = wxidFilterArg ? wxidFilterArg.slice().sort().join('|') : '';

  // ── Conda: env picker ──
  const [condaEnvs, setCondaEnvs] = useState<CondaEnv[] | null>(null);
  const [condaEnvsLoading, setCondaEnvsLoading] = useState(false);
  const [selectedEnvs, setSelectedEnvs] = useState<Set<string>>(new Set());

  // ── Scope sizes (live preview, refetched when filters change) ──
  const [scopeSizes, setScopeSizes] = useState<ScopeSize[] | null>(null);
  const [scopeLoading, setScopeLoading] = useState(false);

  // ── Which scopes are checked for cleanup ──
  const detectedVariants = useMemo(() => detectVariants(matches), [matches]);
  const visibleScopes = useMemo(
    () => (sc.scopes ?? []).filter((s) => !s.variant || detectedVariants.has(s.variant)),
    [sc.scopes, detectedVariants],
  );
  const [selectedScopes, setSelectedScopes] = useState<Set<string>>(() => new Set());

  // ── Execute state ──
  const [running, setRunning] = useState(false);
  const [armed, setArmed] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const matchKey = matches.map((m) => m.path).sort().join('|');
  const daysKey = JSON.stringify(daysByScope);

  // Load conda envs.
  useEffect(() => {
    if (!isConda || matches.length === 0) return;
    let cancelled = false;
    setCondaEnvsLoading(true);
    api
      .listCondaEnvs(matches[0].path)
      .then((envs) => {
        if (cancelled) return;
        setCondaEnvs(envs);
        setSelectedEnvs(new Set(envs.filter((e) => e.default_checked).map((e) => e.name)));
      })
      .catch((e) => { if (!cancelled) setErr(`读取 conda env 失败：${String(e)}`); })
      .finally(() => { if (!cancelled) setCondaEnvsLoading(false); });
    return () => { cancelled = true; };
  }, [isConda, matchKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch scope sizes (debounced).
  useEffect(() => {
    if (isConda) return;
    if (matches.length === 0 || (sc.scopes ?? []).length === 0) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      setScopeLoading(true);
      Promise.all(
        matches.map((m) =>
          api.scopeSizes(sc.id, m.path, daysByScope, wxidFilterArg).catch(() => [] as ScopeSize[]),
        ),
      )
        .then((rowsList) => {
          if (cancelled) return;
          setScopeSizes(aggregateScopeSizes(rowsList));
        })
        .catch((e) => { if (!cancelled) setErr(`扫描 scope 大小失败：${String(e)}`); })
        .finally(() => { if (!cancelled) setScopeLoading(false); });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [isConda, matchKey, sc.id, (sc.scopes ?? []).length, daysKey, wxidKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bytes for a scope from current sizes.
  const bytesForScope = (id: string) => scopeSizes?.find((r) => r.scope_id === id)?.bytes ?? 0;
  const filesForScope = (id: string) => scopeSizes?.find((r) => r.scope_id === id)?.file_count ?? 0;

  const sortedMediaScopes = useMemo(() => {
    const list = visibleScopes.filter((s) => s.category === 'media');
    return [...list].sort((a, b) => bytesForScope(b.id) - bytesForScope(a.id));
  }, [visibleScopes, scopeSizes]);

  const cacheScopes = visibleScopes.filter((s) => (s.category ?? 'cache') === 'cache');
  const backupScopes = visibleScopes.filter((s) => s.category === 'backup');

  const toggleScope = (id: string) => {
    setSelectedScopes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleScopeGroup = (group: Scope[]) => {
    const ids = group.map((s) => s.id);
    const allOn = ids.every((id) => selectedScopes.has(id));
    setSelectedScopes((prev) => {
      const next = new Set(prev);
      if (allOn) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => { if (bytesForScope(id) > 0) next.add(id); });
      return next;
    });
  };

  // ── Total bytes for the cleanup button label ──
  const totalSelected = useMemo(() => {
    if (isConda) {
      let count = 0;
      let bytes = 0;
      if (condaEnvs) {
        for (const e of condaEnvs) {
          if (selectedEnvs.has(e.name)) { count += 1; bytes += e.size_bytes; }
        }
      }
      return { count, bytes };
    }
    let count = 0;
    let bytes = 0;
    for (const id of selectedScopes) {
      const b = bytesForScope(id);
      if (b > 0) { count += 1; bytes += b; }
    }
    return { count, bytes };
  }, [isConda, selectedEnvs, condaEnvs, selectedScopes, scopeSizes]);

  // ── Execute ──
  const execute = async () => {
    if (running) return;
    if (!armed) {
      setArmed(true);
      setMsg(null);
      window.setTimeout(() => setArmed(false), 5000);
      return;
    }
    setArmed(false);
    setRunning(true);
    setMsg(null);
    setErr(null);
    try {
      let totalBytes = 0;
      let totalEntries = 0;

      if (isConda) {
        if (selectedEnvs.size === 0 || matches.length === 0) {
          setErr('没有勾选任何 environment');
          setRunning(false);
          return;
        }
        const envFilterArg = [...selectedEnvs];
        const beforeBytes = totalSelected.bytes;
        const entries = await api.executeScope(
          sc.id, 'envs-stale', matches[0].path, false,
          undefined, undefined, envFilterArg,
        );
        totalBytes = beforeBytes;
        totalEntries = entries.length;
        // Refresh env list.
        const refreshed = await api.listCondaEnvs(matches[0].path).catch(() => [] as CondaEnv[]);
        setCondaEnvs(refreshed);
        setSelectedEnvs(new Set(refreshed.filter((e) => e.default_checked).map((e) => e.name)));
      } else {
        // Parallel-execute every selected scope across every matched root.
        const scopeIdsToRun = [...selectedScopes].filter((id) => bytesForScope(id) > 0);
        if (scopeIdsToRun.length === 0) {
          setErr('没有勾选任何要清理的 scope');
          setRunning(false);
          return;
        }
        const beforeBytes = scopeIdsToRun.reduce((s, id) => s + bytesForScope(id), 0);
        const tasks: Promise<unknown>[] = [];
        for (const scopeId of scopeIdsToRun) {
          const days = daysByScope[scopeId];
          for (const m of matches) {
            tasks.push(
              api.executeScope(sc.id, scopeId, m.path, false, days, wxidFilterArg).then(
                (entries) => { totalEntries += entries.length; },
                (e) => { console.warn(`[diskwise] executeScope ${sc.id}/${scopeId} on ${m.path} failed:`, e); },
              ),
            );
          }
        }
        await Promise.all(tasks);
        totalBytes = beforeBytes;
        // Refresh sizes.
        const rowsList = await Promise.all(
          matches.map((m) =>
            api.scopeSizes(sc.id, m.path, daysByScope, wxidFilterArg).catch(() => [] as ScopeSize[]),
          ),
        );
        setScopeSizes(aggregateScopeSizes(rowsList));
        setSelectedScopes(new Set());
      }

      onCleaned(totalBytes);
      setMsg(`已清理 ${totalEntries} 个文件 · 约 ${formatBytes(totalBytes)} · 进了系统回收站`);
    } catch (e) {
      setErr(`清理失败：${String(e)}`);
    } finally {
      setRunning(false);
    }
  };

  const renderScopeRow = (scope: Scope) => {
    const bytes = bytesForScope(scope.id);
    const fileCount = filesForScope(scope.id);
    const empty = scopeSizes !== null && bytes === 0;
    const checked = selectedScopes.has(scope.id) && !empty;
    const days = daysByScope[scope.id] ?? (scope.prompt?.kind === 'days' ? scope.prompt.default : undefined);
    return (
      <li key={scope.id} className={'cleanup-row' + (empty ? ' empty' : '') + (checked ? ' checked' : '')}>
        <label className="cleanup-row-main">
          <input
            type="checkbox"
            checked={checked}
            disabled={empty || running}
            onChange={() => toggleScope(scope.id)}
          />
          <div className="cleanup-row-text">
            <span className="cleanup-row-label">{scope.label}</span>
            <span className="cleanup-row-meta">
              {scopeSizes === null
                ? '扫描中…'
                : empty
                  ? '空'
                  : `${formatBytes(bytes)}${fileCount ? ` · ${fileCount.toLocaleString()} 文件` : ''}`}
            </span>
          </div>
        </label>
        {scope.prompt?.kind === 'days' && (
          <div className="cleanup-row-days">
            <span>保留最近</span>
            <input
              type="number"
              min={0}
              value={days ?? 0}
              onChange={(e) => {
                const v = Number(e.target.value);
                setDaysByScope((prev) => ({ ...prev, [scope.id]: Number.isFinite(v) && v >= 0 ? v : 0 }));
              }}
              disabled={running}
            />
            <span>天</span>
          </div>
        )}
      </li>
    );
  };

  const renderScopeGroup = (label: string, group: Scope[]) => {
    if (group.length === 0) return null;
    const allOn = group.every((s) => selectedScopes.has(s.id));
    const someOn = !allOn && group.some((s) => selectedScopes.has(s.id));
    return (
      <section className="cleanup-section">
        <div className="cleanup-section-head">
          <span>{label}</span>
          <button
            type="button"
            className="ghost cleanup-toggle-all"
            onClick={() => toggleScopeGroup(group)}
            disabled={running}
          >
            {allOn ? '全不选' : someOn ? '全选' : '全选'}
          </button>
        </div>
        <ul className="cleanup-rows">
          {group.map((s) => renderScopeRow(s))}
        </ul>
      </section>
    );
  };

  const userEnvs = (condaEnvs ?? []).filter((e) => !e.is_base);
  const baseEnv = (condaEnvs ?? []).find((e) => e.is_base);

  const canExecute = !running && totalSelected.count > 0;

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal cleanup-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            清理 · {sc.name}
            {scopeLoading && <Loader2 size={13} className="spin" style={{ marginLeft: 8, verticalAlign: 'middle' }} />}
          </div>
          <button className="ghost icon" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="cleanup-paths">
          {matches.map((m) => (
            <div key={m.path} className="cleanup-path-row" title={m.path}>
              <span className="cleanup-path">{m.path}</span>
              <span className="muted small">{formatBytes(m.size)}</span>
            </div>
          ))}
        </div>

        {/* WeChat: account (wxid) filter */}
        {wxids.length > 0 && (
          <section className="cleanup-section">
            <div className="cleanup-section-head">
              <span>账号</span>
              <span className="muted small">只清勾选账号下的文件 · 跨账号目录不受影响</span>
            </div>
            <div className="cleanup-wxid-grid">
              {wxids.map((w) => {
                const checked = selectedWxids.has(w);
                return (
                  <label key={w} className="cleanup-wxid-chip">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={running}
                      onChange={() => {
                        setSelectedWxids((prev) => {
                          const next = new Set(prev);
                          if (next.has(w)) next.delete(w);
                          else next.add(w);
                          return next;
                        });
                      }}
                    />
                    <span className={checked ? '' : 'muted'}>{w}</span>
                  </label>
                );
              })}
            </div>
          </section>
        )}

        {/* Conda: env picker */}
        {isConda && (
          <section className="cleanup-section">
            <div className="cleanup-section-head">
              <span>Environments</span>
              {condaEnvsLoading && <Loader2 size={11} className="spin" />}
            </div>
            {condaEnvs === null && !condaEnvsLoading && (
              <div className="muted small">读取失败</div>
            )}
            {condaEnvs && userEnvs.length === 0 && (
              <div className="muted small">没有用户 environment（envs/ 为空）</div>
            )}
            {condaEnvs && userEnvs.length > 0 && (
              <ul className="cleanup-rows">
                {baseEnv && (
                  <li className="cleanup-row empty" title="base 是 conda 安装本身，永不可清。">
                    <label className="cleanup-row-main">
                      <input type="checkbox" disabled checked={false} />
                      <div className="cleanup-row-text">
                        <span className="cleanup-row-label muted">base · 不可清</span>
                        <span className="cleanup-row-meta">{formatBytes(baseEnv.size_bytes)} · {formatLastActive(baseEnv.last_active_ts)}</span>
                      </div>
                    </label>
                  </li>
                )}
                {userEnvs.map((e) => {
                  const checked = selectedEnvs.has(e.name);
                  return (
                    <li key={e.name} className={'cleanup-row' + (checked ? ' checked' : '')} title={e.path}>
                      <label className="cleanup-row-main">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={running}
                          onChange={() => {
                            setSelectedEnvs((prev) => {
                              const next = new Set(prev);
                              if (next.has(e.name)) next.delete(e.name);
                              else next.add(e.name);
                              return next;
                            });
                          }}
                        />
                        <div className="cleanup-row-text">
                          <span className="cleanup-row-label">{e.name}</span>
                          <span className="cleanup-row-meta">{formatBytes(e.size_bytes)} · {formatLastActive(e.last_active_ts)}{e.default_checked ? ' · 90 天没动过' : ''}</span>
                        </div>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {/* Scope groups (non-conda scaffolds) */}
        {!isConda && (
          <>
            {renderScopeGroup('接收的媒体', sortedMediaScopes)}
            {renderScopeGroup('缓存与临时数据', cacheScopes)}
            {renderScopeGroup('聊天备份', backupScopes)}
          </>
        )}

        <p className="cleanup-disclaimer">
          <AlertTriangle size={12} /> {sc.disclaimer}
        </p>

        {msg && <div className="ok">{msg}</div>}
        {err && <div className="error">{err}</div>}

        <div className="cleanup-footer">
          <div className="cleanup-summary">
            {totalSelected.count > 0
              ? <>共 <strong>{totalSelected.count}</strong> 项 · <strong>{formatBytes(totalSelected.bytes)}</strong> · 进系统回收站可还原</>
              : <span className="muted">勾选要清理的项目</span>}
          </div>
          <div className="cleanup-actions">
            <button className="ghost" onClick={onClose} disabled={running}>取消</button>
            <button
              className={'primary cleanup-execute' + (armed ? ' armed' : '')}
              onClick={execute}
              disabled={!canExecute}
              title={armed ? '5 秒内再点一次确认' : '点一次进入确认状态，再点一次执行'}
            >
              {running
                ? <><Loader2 size={13} className="spin" /> 清理中…</>
                : armed
                  ? <><Trash2 size={13} /> 再点确认</>
                  : <><Trash2 size={13} /> 执行清理</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
