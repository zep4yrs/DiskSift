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

/// Collect every top-level node tagged with `scaffoldId`. We deliberately
/// don't recurse into a subtree that already matched — a single scaffold
/// rarely re-tags itself deeper, and skipping the descent keeps walks under
/// each match disjoint so scope_sizes aggregation can't double-count the
/// same files.
///
/// A scaffold may legitimately match in multiple places — e.g. wechat-pc
/// matches both `Documents\xwechat_files` (chat data) AND
/// `AppData\Roaming\Tencent\xwechat` (logs / plugins / network state).
/// Each location is the only one of its scopes that has the right files,
/// so we have to walk both to fill all 16 scope buckets correctly.
function findAllMatchesByScaffold(root: Node | null, scaffoldId: string): Node[] {
  if (!root) return [];
  const out: Node[] = [];
  const dfs = (n: Node) => {
    if (n.scaffold_id === scaffoldId) {
      out.push(n);
      return;
    }
    for (const c of n.children ?? []) dfs(c);
  };
  dfs(root);
  return out;
}

/// Fallback when no node was tagged in the scan tree (e.g. the user picked
/// a too-narrow scan root). Searches by `name_contains` substring on full
/// path. Returns at most one node — fallback's job is to give the user a
/// hint, not to enumerate.
function fallbackByNameContains(root: Node | null, sc: Scaffold): Node | null {
  const fragments = (sc.match?.name_contains ?? []).map((s) => s.toLowerCase());
  if (fragments.length === 0 || !root) return null;
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
  matches: Node[];   // empty = undetected
  totalSize: number; // sum of all matches' sizes (or fallback's, or 0)
  totalFiles: number;
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
      let matches = findAllMatchesByScaffold(root, sc.id);
      if (matches.length === 0) {
        // Fall back to substring match for cases where the scaffold defines
        // matcher fragments but nothing was tagged (e.g. scan root too narrow).
        const fb = fallbackByNameContains(root, sc);
        if (fb) matches = [fb];
      }
      // Sort matches by size desc so the largest one is the "primary" for
      // display (path, dragging, children list).
      matches.sort((a, b) => b.size - a.size);
      const totalSize = matches.reduce((s, m) => s + m.size, 0);
      const totalFiles = matches.reduce((s, m) => s + m.file_count, 0);
      return { scaffold: sc, matches, totalSize, totalFiles };
    });
    // Sort: detected (by aggregate size desc), then undetected (alphabetical).
    items.sort((a, b) => {
      const aDet = a.matches.length > 0;
      const bDet = b.matches.length > 0;
      if (aDet && !bDet) return -1;
      if (!aDet && bDet) return 1;
      if (aDet && bDet) return b.totalSize - a.totalSize;
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

/// Aggregate ScopeSize rows from multiple `scope_sizes` calls (one per matched
/// location) into a single rows-per-scope_id list. Bytes / file counts sum;
/// the same scope_id may appear in multiple rows lists (one per location).
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

function Card({ card, expanded, onToggle, onAsk }: { card: CardData; expanded: boolean; onToggle: () => void; onAsk: () => void }) {
  const sc = card.scaffold;
  const matches = card.matches;
  const primary = matches[0] ?? null;
  const detected = matches.length > 0;
  const Caret = expanded ? ChevronDown : ChevronRight;
  const addReclaimed = useStore((s) => s.addReclaimed);

  const [scopeSizes, setScopeSizes] = useState<ScopeSize[] | null>(null);
  const [scopeLoading, setScopeLoading] = useState(false);
  const [busyScope, setBusyScope] = useState<string | null>(null);
  const [scopeMsg, setScopeMsg] = useState<string | null>(null);
  const [armedScope, setArmedScope] = useState<string | null>(null); // two-step click confirm

  // Stable cache key for the matches array — useEffect needs a primitive so it
  // doesn't re-fire just because Studio re-rendered with a fresh array identity.
  const matchKey = matches.map((m) => m.path).sort().join('|');

  // Load per-scope sizes once expanded. Fan-out across all matches and aggregate
  // by scope_id so all 16 wechat scopes can light up even when matches live in
  // separate roots (Documents\xwechat_files and AppData\Roaming\Tencent\xwechat).
  useEffect(() => {
    if (!expanded || matches.length === 0 || (sc.scopes ?? []).length === 0) return;
    let cancelled = false;
    setScopeLoading(true);
    Promise.all(matches.map((m) => api.scopeSizes(sc.id, m.path).catch(() => [] as ScopeSize[])))
      .then((rowsList) => {
        if (cancelled) return;
        setScopeSizes(aggregateScopeSizes(rowsList));
      })
      .catch((e) => { if (!cancelled) setScopeMsg(`扫描 scope 大小失败：${String(e)}`); })
      .finally(() => { if (!cancelled) setScopeLoading(false); });
    return () => { cancelled = true; };
  }, [expanded, matchKey, sc.id, (sc.scopes ?? []).length]);

  const runScope = async (scopeId: string, _scopeLabel: string, bytes: number) => {
    if (matches.length === 0) return;
    setArmedScope(null);
    setBusyScope(scopeId);
    setScopeMsg(null);
    try {
      // Fan executeScope across every matched root. Roots whose globs don't
      // match anything return [] from the executor — safe to ignore.
      const entriesPerRoot = await Promise.all(
        matches.map((m) =>
          api.executeScope(sc.id, scopeId, m.path, false).catch((e) => {
            // eslint-disable-next-line no-console
            console.warn(`[diskwise] executeScope ${sc.id}/${scopeId} on ${m.path} failed:`, e);
            return [];
          }),
        ),
      );
      const totalEntries = entriesPerRoot.reduce((s, arr) => s + arr.length, 0);
      addReclaimed(bytes);
      setScopeMsg(`已清理 ${totalEntries} 个文件 · 约 ${formatBytes(bytes)}`);
      // Refresh sizes — same fan-out + aggregate.
      const rowsList = await Promise.all(
        matches.map((m) => api.scopeSizes(sc.id, m.path).catch(() => [] as ScopeSize[])),
      );
      setScopeSizes(aggregateScopeSizes(rowsList));
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

  // For "占用最大的子项": pull the union of all matches' children, sort by
  // size desc, take top 8. Each child carries its own absolute path so there's
  // no ambiguity even when matches span unrelated roots.
  const topChildren = (() => {
    const all: Node[] = [];
    for (const m of matches) {
      for (const c of m.children ?? []) all.push(c);
    }
    all.sort((a, b) => b.size - a.size);
    return all.slice(0, 8);
  })();

  return (
    <div className={'studio-card-wrap risk-' + sc.risk + (detected ? ' detected' : '')}>
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
            {detected
              ? <><Sparkles size={10} /> {formatBytes(card.totalSize)}{matches.length > 1 && <> · {matches.length} 个位置</>}</>
              : <>未扫到 · 用脚本默认路径</>}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="studio-card-expanded">
          {detected && primary ? (
            <>
              <div className="studio-detail-row">
                <span className="studio-detail-label">路径</span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                  {matches.map((m) => (
                    <span
                      key={m.path}
                      className="studio-detail-path"
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('application/x-diskwise-path', m.path);
                        e.dataTransfer.setData('application/x-diskwise-name', m.name);
                        e.dataTransfer.effectAllowed = 'copy';
                      }}
                      title="拖到中间问 AI"
                    >
                      {m.path}
                      {matches.length > 1 && (
                        <span className="muted small" style={{ marginLeft: 6 }}>
                          {formatBytes(m.size)}
                        </span>
                      )}
                    </span>
                  ))}
                </span>
              </div>
              <div className="studio-detail-row">
                <span className="studio-detail-label">大小</span>
                <span className="mono-num">
                  {formatBytes(card.totalSize)} · {card.totalFiles.toLocaleString()} 文件
                  {matches.length > 1 && <span className="muted small" style={{ marginLeft: 6 }}>（{matches.length} 处合计）</span>}
                </span>
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

              {topChildren.length > 0 && (
                <>
                  <div className="studio-detail-label" style={{ marginTop: 6 }}>占用最大的子项</div>
                  <ul className="studio-children">
                    {topChildren.map((c) => (
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
            <MessageSquare size={12} /> {detected ? '问 AI 这里面具体是什么 / 能不能删' : '问 AI：它一般在哪、能不能删'}
          </button>
        </div>
      )}
    </div>
  );
}
