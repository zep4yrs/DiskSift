import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, ChevronDown, Sparkles, MessageSquare, Trash2, Loader2 } from 'lucide-react';
import { useStore } from '../store';
import { formatBytes } from '../format';
import { api } from '../api';
import type { Node, Scaffold } from '../types';

interface ScopeSize {
  scope_id: string;
  bytes: number;
  file_count: number;
}

const FEATURED_IDS = [
  'wechat-pc',
  'qq-pc',
  'feishu',
  'dingtalk',
  'chrome',
  'edge',
  'cursor',
  'vscode',
  'jetbrains',
  'docker',
  'steam',
  'huggingface',
  'ollama',
  'npm',
  'pnpm',
  'cargo',
  'crash-dumps',
  'windows-temp',
  'recycle-bin',
];

const ICONS: Record<string, string> = {
  'wechat-pc':     '💬',
  'qq-pc':         '🐧',
  'feishu':        '🪶',
  'dingtalk':      '🔔',
  'chrome':        '🌐',
  'edge':          '🪟',
  'firefox':       '🦊',
  'brave':         '🦁',
  'slack':         '💼',
  'discord':       '🎮',
  'telegram':      '✈️',
  'teams':         '👥',
  'cursor':        '🖱️',
  'vscode':        '📝',
  'jetbrains':     '🧠',
  'docker':        '🐳',
  'steam':         '🎯',
  'epicgames':     '🎮',
  'battlenet':     '⚔️',
  'huggingface':   '🤗',
  'ollama':        '🦙',
  'spotify':       '🎵',
  'obs':           '📹',
  'npm':           '📦',
  'pnpm':          '📦',
  'yarn':          '🧶',
  'pip':           '🐍',
  'cargo':         '🦀',
  'go-mod':        '🐹',
  'gradle':        '🐘',
  'maven':         '🪶',
  'nuget':         '🔷',
  'conda':         '🐍',
  'crash-dumps':   '💥',
  'windows-temp':  '🗑️',
  'windows-old':   '🗂️',
  'recycle-bin':   '♻️',
  'node-modules':  '📚',
};

function findFirstMatchByScaffold(root: Node | null, scaffoldId: string): Node | null {
  if (!root) return null;
  if (root.scaffold_id === scaffoldId) return root;
  for (const c of root.children ?? []) {
    const f = findFirstMatchByScaffold(c, scaffoldId);
    if (f) return f;
  }
  return null;
}

function detectedNodeFor(root: Node | null, sc: Scaffold): Node | null {
  const tagged = findFirstMatchByScaffold(root, sc.id);
  if (tagged) return tagged;
  const fragments = (sc.match?.name_contains ?? []).map((s) => s.toLowerCase());
  if (fragments.length === 0) return null;
  const dfs = (n: Node | null): Node | null => {
    if (!n) return null;
    const lower = n.path.toLowerCase();
    if (fragments.some((f) => lower.includes(f))) return n;
    for (const c of n.children ?? []) {
      const f = dfs(c);
      if (f) return f;
    }
    return null;
  };
  return dfs(root);
}

interface CardData {
  scaffold: Scaffold;
  match: Node | null;
  size: number;     // matched size, or 0 if not detected
}

export function Studio() {
  const root = useStore((s) => s.root);
  const scaffolds = useStore((s) => s.scaffolds);
  const requestStudio = useStore((s) => s.requestStudio);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Differential A/B knob: localStorage.setItem('diskwise.hideStudio','1')
  // skips both the useMemo DFS and the render so we can measure their cost.
  const hidden = (() => {
    try { return localStorage.getItem('diskwise.hideStudio') === '1'; } catch { return false; }
  })();

  const allCards: CardData[] = useMemo(() => {
    if (hidden) return [];
    const t0 = performance.now();
    const items: CardData[] = scaffolds.map((sc) => {
      const m = detectedNodeFor(root, sc);
      return { scaffold: sc, match: m, size: m?.size ?? 0 };
    });
    // Sort: detected first (by size desc), then undetected (alphabetical).
    items.sort((a, b) => {
      if (a.match && !b.match) return -1;
      if (!a.match && b.match) return 1;
      if (a.match && b.match) return b.size - a.size;
      return a.scaffold.name.localeCompare(b.scaffold.name);
    });
    const ms = performance.now() - t0;
    if (root) {
      // eslint-disable-next-line no-console
      console.log(`[diskwise.diag] Studio.useMemo ${ms.toFixed(1)}ms · ${scaffolds.length} scaffolds × full-tree DFS`);
    }
    return items;
  }, [scaffolds, root, hidden]);

  if (hidden) {
    return (
      <div className="studio">
        <div className="studio-head">
          <span>Studio</span>
          <span className="muted small">已隐藏（diskwise.hideStudio=1）</span>
        </div>
      </div>
    );
  }

  const featured = allCards.filter((c) => FEATURED_IDS.includes(c.scaffold.id));
  const others = allCards.filter((c) => !FEATURED_IDS.includes(c.scaffold.id));

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="studio">
      <div className="studio-head">
        <span>Studio</span>
        <span className="muted small">{allCards.length} 个脚本</span>
      </div>

      <div className="studio-section-label">推荐 · 按占用排序</div>
      <div className="studio-grid">
        {featured.map((c) => (
          <Card key={c.scaffold.id} card={c} expanded={expanded.has(c.scaffold.id)} onToggle={() => toggle(c.scaffold.id)} onAsk={() => requestStudio(c.scaffold.id)} />
        ))}
      </div>

      {others.length > 0 && (
        <>
          <div className="studio-section-label">更多</div>
          <div className="studio-grid">
            {others.map((c) => (
              <Card key={c.scaffold.id} card={c} expanded={expanded.has(c.scaffold.id)} onToggle={() => toggle(c.scaffold.id)} onAsk={() => requestStudio(c.scaffold.id)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Card({ card, expanded, onToggle, onAsk }: { card: CardData; expanded: boolean; onToggle: () => void; onAsk: () => void }) {
  const sc = card.scaffold;
  const n = card.match;
  const Caret = expanded ? ChevronDown : ChevronRight;
  const addReclaimed = useStore((s) => s.addReclaimed);

  const [scopeSizes, setScopeSizes] = useState<ScopeSize[] | null>(null);
  const [scopeLoading, setScopeLoading] = useState(false);
  const [busyScope, setBusyScope] = useState<string | null>(null);
  const [scopeMsg, setScopeMsg] = useState<string | null>(null);
  const [armedScope, setArmedScope] = useState<string | null>(null); // two-step click confirm

  // Load per-scope sizes once the card is expanded on a detected match.
  useEffect(() => {
    if (!expanded || !n || (sc.scopes ?? []).length === 0) return;
    let cancelled = false;
    setScopeLoading(true);
    api
      .scopeSizes(sc.id, n.path)
      .then((rows) => { if (!cancelled) setScopeSizes(rows); })
      .catch((e) => { if (!cancelled) setScopeMsg(`扫描 scope 大小失败：${String(e)}`); })
      .finally(() => { if (!cancelled) setScopeLoading(false); });
    return () => { cancelled = true; };
  }, [expanded, n?.path, sc.id, (sc.scopes ?? []).length]);

  const runScope = async (scopeId: string, _scopeLabel: string, bytes: number) => {
    if (!n) return;
    setArmedScope(null);
    setBusyScope(scopeId);
    setScopeMsg(null);
    try {
      const entries = await api.executeScope(sc.id, scopeId, n.path, false);
      addReclaimed(bytes);
      setScopeMsg(`已清理 ${entries.length} 个文件 · 约 ${formatBytes(bytes)}`);
      // Refresh scope sizes so this row drops to 0.
      const rows = await api.scopeSizes(sc.id, n.path);
      setScopeSizes(rows);
    } catch (e) {
      setScopeMsg(`清理失败：${String(e)}`);
    } finally {
      setBusyScope(null);
    }
  };

  // Two-step confirm: first click "arms" the row (button turns red & shows "确认"),
  // second click within ~5s actually runs. Avoids window.confirm which has had
  // flaky behavior in some Tauri webview builds.
  const handleScopeClick = (scopeId: string, scopeLabel: string, bytes: number) => {
    if (busyScope) return;
    if (armedScope === scopeId) {
      runScope(scopeId, scopeLabel, bytes);
    } else {
      setArmedScope(scopeId);
      setScopeMsg(null);
      window.setTimeout(() => {
        setArmedScope((cur) => (cur === scopeId ? null : cur));
      }, 5000);
    }
  };

  return (
    <div className={'studio-card-wrap risk-' + sc.risk + (n ? ' detected' : '')}>
      <button
        className="studio-card"
        onClick={onToggle}
        title={sc.disclaimer}
      >
        <Caret size={14} className="studio-caret" />
        <div className="studio-card-icon">{ICONS[sc.id] ?? '🧹'}</div>
        <div className="studio-card-body">
          <div className="studio-card-name">{sc.name}</div>
          <div className="studio-card-meta">
            {n
              ? <><Sparkles size={10} /> {formatBytes(n.size)}</>
              : <>未扫到 · 用脚本默认路径</>}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="studio-card-expanded">
          {n ? (
            <>
              <div className="studio-detail-row">
                <span className="studio-detail-label">路径</span>
                <span
                  className="studio-detail-path"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/x-diskwise-path', n.path);
                    e.dataTransfer.setData('application/x-diskwise-name', n.name);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  title="拖到中间问 AI"
                >
                  {n.path}
                </span>
              </div>
              <div className="studio-detail-row">
                <span className="studio-detail-label">大小</span>
                <span className="mono-num">{formatBytes(n.size)} · {n.file_count.toLocaleString()} 文件</span>
              </div>
              {(sc.scopes ?? []).length > 0 && (
                <>
                  <div className="studio-detail-label" style={{ marginTop: 6 }}>
                    脚本可清的桶 ({(sc.scopes ?? []).length})
                    {scopeLoading && <Loader2 size={11} className="spin" style={{ marginLeft: 6, verticalAlign: 'middle' }} />}
                  </div>
                  <ul className="studio-scopes">
                    {(sc.scopes ?? []).map((scope) => {
                      const row = scopeSizes?.find((r) => r.scope_id === scope.id);
                      const bytes = row?.bytes ?? 0;
                      const fileCount = row?.file_count ?? 0;
                      const empty = scopeSizes !== null && bytes === 0;
                      const busy = busyScope === scope.id;
                      return (
                        <li key={scope.id} className={'studio-scope-row' + (empty ? ' empty' : '')} title={scope.glob}>
                          <span className="studio-scope-label">{scope.label}</span>
                          <span className="mono-num studio-scope-size">
                            {scopeSizes === null ? '—' : `${formatBytes(bytes)}${fileCount ? ` · ${fileCount.toLocaleString()}` : ''}`}
                          </span>
                          <button
                            className={'secondary studio-scope-btn' + (armedScope === scope.id ? ' armed' : '')}
                            disabled={busy || empty || scopeLoading}
                            onClick={() => handleScopeClick(scope.id, scope.label, bytes)}
                            title={`${scope.mode} · ${scope.glob}`}
                          >
                            {busy
                              ? <><Loader2 size={11} className="spin" /> 清理中</>
                              : armedScope === scope.id
                                ? <><Trash2 size={11} /> 再点确认</>
                                : <><Trash2 size={11} /> 清理</>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  {scopeMsg && <div className="studio-scope-msg muted small">{scopeMsg}</div>}
                </>
              )}

              {(n.children ?? []).length > 0 && (
                <>
                  <div className="studio-detail-label" style={{ marginTop: 6 }}>占用最大的子项</div>
                  <ul className="studio-children">
                    {[...n.children]
                      .sort((a, b) => b.size - a.size)
                      .slice(0, 8)
                      .map((c) => (
                        <li
                          key={c.path}
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData('application/x-diskwise-path', c.path);
                            e.dataTransfer.setData('application/x-diskwise-name', c.name);
                            e.dataTransfer.effectAllowed = 'copy';
                          }}
                          title={c.path}
                        >
                          <span className="studio-child-name">{c.is_dir ? '📁' : '📄'} {c.name}</span>
                          <span className="mono-num">{formatBytes(c.size)}</span>
                        </li>
                      ))}
                  </ul>
                </>
              )}
            </>
          ) : (
            <>
              <div className="studio-detail-label">脚本默认匹配路径</div>
              <ul className="studio-children muted small">
                {sc.detect.slice(0, 4).map((p) => <li key={p}>{p}</li>)}
              </ul>
              <div className="studio-detail-label" style={{ marginTop: 6 }}>说明</div>
              <p className="muted small" style={{ margin: '4px 0' }}>{sc.disclaimer}</p>
            </>
          )}

          <button className="primary studio-ask-btn" onClick={onAsk}>
            <MessageSquare size={12} /> {n ? '问 AI 这里面具体是什么 / 能不能删' : '问 AI：它一般在哪、能不能删'}
          </button>
        </div>
      )}
    </div>
  );
}
