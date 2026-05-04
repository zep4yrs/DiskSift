import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, ChevronDown, Sparkles, MessageSquare, Trash2, Loader2 } from 'lucide-react';
import { useStore } from '../store';
import { formatBytes } from '../format';
import { api } from '../api';
import type { Node, Scaffold, CondaEnv } from '../types';
import { ErrorBoundary } from './ErrorBoundary';

/// Relative-time renderer for conda env's last `conda-meta/history` mtime.
/// `null` means history is missing (broken env or fresh install pre-first-op);
/// surfaced as "从未" so user knows the staleness signal couldn't be read.
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

/// Sentinel id for the envs cleanup button to participate in the
/// armedScope/busyScope two-step-confirm machinery without colliding
/// with any real scope id.
const ENVS_BUTTON_ID = '__envs_cleanup__';

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

/// Per-scaffold `{ scopeId -> days }` persistence, sourced from localStorage.
/// Only entries that DIFFER from the scaffold's own `prompt.default` are saved
/// — when the user edits a value back to default, the entry is dropped to keep
/// the store from accumulating noise. Wxid checkboxes and scope enable state
/// are NOT persisted by design (per user decision).
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

interface ScopeSize {
  scope_id: string;
  bytes: number;
  file_count: number;
}

/// Sentinel id used by the merged cache button to participate in the
/// existing `armedScope` / `busyScope` two-step-confirm machinery without
/// colliding with any real scope id.
const BULK_CACHE_ID = '__bulk_cache__';

/// Detect which product variants ("3.x" / "4.x" for WeChat) are present in
/// the matched paths. Used to hide scopes whose `variant` doesn't apply to
/// the user's install — e.g. WeChat 4.x users never see `[3.x]` rows.
///
/// String-includes is safe here: `xwechat_files` (underscore) and
/// `wechat files` (space) don't share a substring; `tencent/xwechat`'s
/// 9th char is `x`, not `w`, so it doesn't false-positive on
/// `tencent/wechat`.
function detectVariants(matches: Node[]): Set<string> {
  const out = new Set<string>();
  for (const m of matches) {
    const p = m.path.replace(/\\/g, '/').toLowerCase();
    if (p.includes('xwechat_files') || p.includes('tencent/xwechat')) out.add('4.x');
    if (p.includes('wechat files') || p.includes('tencent/wechat')) out.add('3.x');
  }
  return out;
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
          <ErrorBoundary key={c.scaffold.id} fallbackLabel={`${c.scaffold.name} 卡片渲染失败`}>
            <Card card={c} expanded={expanded.has(c.scaffold.id)} onToggle={() => toggle(c.scaffold.id)} onAsk={() => requestStudio(c.scaffold.id)} />
          </ErrorBoundary>
        ))}
      </div>

      {others.length > 0 && (
        <>
          <div className="studio-section-label">更多</div>
          <div className="studio-grid">
            {others.map((c) => (
              <ErrorBoundary key={c.scaffold.id} fallbackLabel={`${c.scaffold.name} 卡片渲染失败`}>
                <Card card={c} expanded={expanded.has(c.scaffold.id)} onToggle={() => toggle(c.scaffold.id)} onAsk={() => requestStudio(c.scaffold.id)} />
              </ErrorBoundary>
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

  // Days-prompt scopes: pull each scope's `prompt.default` once and seed state.
  // Subsequent edits live in `daysByScope`; we never mutate the scaffold itself.
  // Persisted across sessions via localStorage (only non-default values are stored).
  const defaultDays = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    for (const scope of sc.scopes ?? []) {
      if (scope.prompt?.kind === 'days') out[scope.id] = scope.prompt.default;
    }
    return out;
  }, [sc.scopes]);
  const [daysByScope, setDaysByScope] = useScopeDays(sc.id, defaultDays);

  // Enumerate per-account wxids from matches' direct children. WeChat 4.x lays
  // accounts out as `xwechat_files/wxid_*/...`, 3.x as `WeChat Files/wxid_*/...`.
  // We only consider direct children of matches (the matched root IS xwechat_files
  // / WeChat Files itself), so `Backup/wxid_*/`, `all_users/`, and roaming dirs
  // like `%APPDATA%/Tencent/xwechat` (no wxid layer) all get filtered out here.
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
  // Re-seed selection when the wxid set itself changes (e.g. after rescan).
  // We only persist days (Step C); wxid checkboxes default to all-on each session.
  useEffect(() => { setSelectedWxids(new Set(wxids)); }, [wxids.join('|')]);

  // Conda envs: only populated when sc.id === 'conda'. The matched root path
  // IS the conda root (detect points there), so we can hand it directly to
  // list_conda_envs. selectedEnvs is seeded from each env's `default_checked`
  // (backend's stale-90d recommendation).
  const [condaEnvs, setCondaEnvs] = useState<CondaEnv[] | null>(null);
  const [condaEnvsLoading, setCondaEnvsLoading] = useState(false);
  const [selectedEnvs, setSelectedEnvs] = useState<Set<string>>(new Set());

  // Stable cache key for the matches array — useEffect needs a primitive so it
  // doesn't re-fire just because Studio re-rendered with a fresh array identity.
  const matchKey = matches.map((m) => m.path).sort().join('|');
  // Same idea for daysByScope and wxid selection.
  const daysKey = JSON.stringify(daysByScope);
  const wxidFilterArg = wxids.length > 0 && selectedWxids.size < wxids.length
    ? [...selectedWxids]
    : undefined;
  const wxidKey = wxidFilterArg ? wxidFilterArg.slice().sort().join('|') : '';

  // Conda env list: fetch when card expands. Only the first matched root is
  // queried — users with both anaconda3 AND miniconda3 detected as separate
  // matches would only see the larger one's envs (out-of-scope for v1, real
  // users typically have one conda install).
  useEffect(() => {
    if (sc.id !== 'conda' || !expanded || matches.length === 0) return;
    let cancelled = false;
    setCondaEnvsLoading(true);
    api
      .listCondaEnvs(matches[0].path)
      .then((envs) => {
        if (cancelled) return;
        setCondaEnvs(envs);
        setSelectedEnvs(new Set(envs.filter((e) => e.default_checked).map((e) => e.name)));
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        if (!cancelled) console.warn('[diskwise] listCondaEnvs failed:', e);
      })
      .finally(() => { if (!cancelled) setCondaEnvsLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sc.id, expanded, matchKey]);

  // Load per-scope sizes once expanded. Fan-out across all matches and aggregate
  // by scope_id so all 16 wechat scopes can light up even when matches live in
  // separate roots (Documents\xwechat_files and AppData\Roaming\Tencent\xwechat).
  // Debounced 300ms so dragging a number input doesn't fire one jwalk per keystroke.
  useEffect(() => {
    if (!expanded || matches.length === 0 || (sc.scopes ?? []).length === 0) return;
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
        .catch((e) => { if (!cancelled) setScopeMsg(`扫描 scope 大小失败：${String(e)}`); })
        .finally(() => { if (!cancelled) setScopeLoading(false); });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [expanded, matchKey, sc.id, (sc.scopes ?? []).length, daysKey, wxidKey]);

  const runScope = async (scopeId: string, _scopeLabel: string, bytes: number) => {
    if (matches.length === 0) return;
    setArmedScope(null);
    setBusyScope(scopeId);
    setScopeMsg(null);
    const days = daysByScope[scopeId];
    try {
      // Fan executeScope across every matched root. Roots whose globs don't
      // match anything return [] from the executor — safe to ignore.
      const entriesPerRoot = await Promise.all(
        matches.map((m) =>
          api.executeScope(sc.id, scopeId, m.path, false, days, wxidFilterArg).catch((e) => {
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
        matches.map((m) =>
          api.scopeSizes(sc.id, m.path, daysByScope, wxidFilterArg).catch(() => [] as ScopeSize[]),
        ),
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

  // Hide scopes whose variant isn't detected in the matched paths.
  // E.g. on a WeChat 4.x install, the 3.x bucket never appears.
  const detectedVariants = useMemo(() => detectVariants(matches), [matchKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const visibleScopes = useMemo(
    () => (sc.scopes ?? []).filter((s) => !s.variant || detectedVariants.has(s.variant)),
    [sc.scopes, detectedVariants],
  );

  // Group by category. `category` defaults to "cache" when missing — matches
  // the conservative pre-feature behavior (anything unclassified bunches up
  // with the merged cache button rather than dangerously appearing as media).
  const mediaScopes = visibleScopes.filter((s) => s.category === 'media');
  const cacheScopes = visibleScopes.filter((s) => (s.category ?? 'cache') === 'cache');
  const backupScopes = visibleScopes.filter((s) => s.category === 'backup');

  // Sort media by current bytes desc so the user sees the biggest target on top.
  const sortedMediaScopes = useMemo(() => {
    const byBytes = (id: string) => scopeSizes?.find((r) => r.scope_id === id)?.bytes ?? 0;
    return [...mediaScopes].sort((a, b) => byBytes(b.id) - byBytes(a.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaScopes.map((s) => s.id).join('|'), scopeSizes]);

  // Aggregate cache bytes/files for the merged button label.
  const cacheTotal = useMemo(() => {
    if (!scopeSizes) return { bytes: 0, files: 0 };
    return cacheScopes.reduce(
      (acc, s) => {
        const row = scopeSizes.find((r) => r.scope_id === s.id);
        return { bytes: acc.bytes + (row?.bytes ?? 0), files: acc.files + (row?.file_count ?? 0) };
      },
      { bytes: 0, files: 0 },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheScopes.map((s) => s.id).join('|'), scopeSizes]);

  // Bulk cache run: fan out per cache scope per match. Backend stays split —
  // we just call executeScope individually for each, so per-bucket logs and
  // failure isolation are preserved (debug-friendly), only the UI is merged.
  const runBulkCache = async () => {
    if (cacheScopes.length === 0 || matches.length === 0) return;
    setArmedScope(null);
    setBusyScope(BULK_CACHE_ID);
    setScopeMsg(null);
    const beforeBytes = cacheTotal.bytes;
    try {
      const allEntries = await Promise.all(
        cacheScopes.flatMap((scope) =>
          matches.map((m) =>
            api
              .executeScope(sc.id, scope.id, m.path, false, daysByScope[scope.id], wxidFilterArg)
              .catch((e) => {
                // eslint-disable-next-line no-console
                console.warn(`[diskwise] bulk: ${scope.id} on ${m.path} failed:`, e);
                return [];
              }),
          ),
        ),
      );
      const totalEntries = allEntries.reduce((s, arr) => s + arr.length, 0);
      addReclaimed(beforeBytes);
      setScopeMsg(
        `已清理 ${totalEntries} 个文件 · 约 ${formatBytes(beforeBytes)} · 共 ${cacheScopes.length} 个桶`,
      );
      const rowsList = await Promise.all(
        matches.map((m) =>
          api.scopeSizes(sc.id, m.path, daysByScope, wxidFilterArg).catch(() => [] as ScopeSize[]),
        ),
      );
      setScopeSizes(aggregateScopeSizes(rowsList));
    } catch (e) {
      setScopeMsg(`清理失败：${String(e)}`);
    } finally {
      setBusyScope(null);
    }
  };

  const handleBulkClick = () => {
    if (busyScope) return;
    if (armedScope === BULK_CACHE_ID) {
      runBulkCache();
    } else {
      setArmedScope(BULK_CACHE_ID);
      setScopeMsg(null);
      window.setTimeout(() => {
        setArmedScope((cur) => (cur === BULK_CACHE_ID ? null : cur));
      }, 5000);
    }
  };

  // Aggregate of currently-selected envs (count + bytes). Drives the cleanup
  // button label and the disabled state — empty selection → no-op + disabled.
  const selectedEnvsTotal = useMemo(() => {
    if (!condaEnvs) return { count: 0, bytes: 0 };
    let count = 0;
    let bytes = 0;
    for (const e of condaEnvs) {
      if (selectedEnvs.has(e.name)) {
        count += 1;
        bytes += e.size_bytes;
      }
    }
    return { count, bytes };
  }, [condaEnvs, selectedEnvs]);

  const runEnvsCleanup = async () => {
    if (sc.id !== 'conda' || !condaEnvs || selectedEnvs.size === 0 || matches.length === 0) return;
    setArmedScope(null);
    setBusyScope(ENVS_BUTTON_ID);
    setScopeMsg(null);
    const beforeBytes = selectedEnvsTotal.bytes;
    const beforeCount = selectedEnvsTotal.count;
    const envFilterArg = [...selectedEnvs];
    try {
      // execute_scope detects scope_id === "envs-stale" + non-empty env_filter
      // and recycles each env directory as a single Recycle Bin entry
      // (not one entry per file inside) — see apps/desktop/src-tauri/src/lib.rs.
      const entries = await api.executeScope(
        sc.id, 'envs-stale', matches[0].path, false,
        undefined, undefined, envFilterArg,
      );
      addReclaimed(beforeBytes);
      setScopeMsg(`已清理 ${beforeCount} 个 environment · 约 ${formatBytes(beforeBytes)} · ${entries.length} 个回收站条目`);
      // Refresh env list — selection re-seeds from the new default_checked set.
      const refreshed = await api.listCondaEnvs(matches[0].path).catch(() => [] as CondaEnv[]);
      setCondaEnvs(refreshed);
      setSelectedEnvs(new Set(refreshed.filter((e) => e.default_checked).map((e) => e.name)));
    } catch (e) {
      setScopeMsg(`清理失败：${String(e)}`);
    } finally {
      setBusyScope(null);
    }
  };

  const handleEnvsClick = () => {
    if (busyScope) return;
    if (selectedEnvs.size === 0) return;
    if (armedScope === ENVS_BUTTON_ID) {
      runEnvsCleanup();
    } else {
      setArmedScope(ENVS_BUTTON_ID);
      setScopeMsg(null);
      window.setTimeout(() => {
        setArmedScope((cur) => (cur === ENVS_BUTTON_ID ? null : cur));
      }, 5000);
    }
  };

  // Single-row renderer reused by media + backup sections. Cache rows go
  // through the bulk button and never call this.
  const renderScopeRow = (scope: typeof sc.scopes[number]) => {
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
          disabled={busy || empty || scopeLoading || (busyScope !== null && busyScope !== scope.id)}
          onClick={() => handleScopeClick(scope.id, scope.label, bytes)}
          title={`${scope.mode} · ${scope.glob}`}
        >
          {busy
            ? <><Loader2 size={11} className="spin" /> 清理中</>
            : armedScope === scope.id
              ? <><Trash2 size={11} /> 再点确认</>
              : <><Trash2 size={11} /> 清理</>}
        </button>
        {scope.prompt?.kind === 'days' && (
          <span
            className="muted"
            style={{ gridColumn: '1 / -1', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, marginTop: 1, paddingLeft: 2 }}
          >
            保留最近
            <input
              type="number"
              min={0}
              value={daysByScope[scope.id] ?? scope.prompt.default}
              onChange={(e) => {
                const v = Number(e.target.value);
                setDaysByScope((prev) => ({ ...prev, [scope.id]: Number.isFinite(v) && v >= 0 ? v : 0 }));
              }}
              onClick={(e) => e.stopPropagation()}
              style={{ width: 56, padding: '1px 4px', fontSize: 10.5, textAlign: 'right' }}
              title={scope.prompt.label ?? '保留最近 N 天的文件，更老的才会被清'}
            />
            天
            {daysByScope[scope.id] !== undefined && daysByScope[scope.id] !== scope.prompt.default && (
              <button
                type="button"
                className="secondary"
                onClick={() => setDaysByScope((prev) => {
                  const next = { ...prev };
                  delete next[scope.id];
                  return next;
                })}
                style={{ fontSize: 10, padding: '0 6px', marginLeft: 4 }}
                title={`恢复默认 ${scope.prompt.kind === 'days' ? scope.prompt.default : ''} 天`}
              >
                恢复默认
              </button>
            )}
          </span>
        )}
      </li>
    );
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
              {sc.id === 'conda' && (
                <CondaEnvsSection
                  envs={condaEnvs}
                  loading={condaEnvsLoading}
                  selected={selectedEnvs}
                  onToggleEnv={(name) => {
                    setSelectedEnvs((prev) => {
                      const next = new Set(prev);
                      if (next.has(name)) next.delete(name);
                      else next.add(name);
                      return next;
                    });
                  }}
                  selectedTotal={selectedEnvsTotal}
                  onCleanup={handleEnvsClick}
                  armed={armedScope === ENVS_BUTTON_ID}
                  busy={busyScope === ENVS_BUTTON_ID}
                  anyBusy={busyScope !== null}
                />
              )}
              {wxids.length > 0 && (
                <div className="studio-detail-row">
                  <span className="studio-detail-label">账号</span>
                  <span style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', flex: 1, minWidth: 0 }}>
                    {wxids.map((w) => {
                      const checked = selectedWxids.has(w);
                      return (
                        <label
                          key={w}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: 'pointer', userSelect: 'none' }}
                          title={`仅清理勾选账号的数据；跨账号目录（all_users/、漫游目录）不受影响`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
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
                  </span>
                </div>
              )}
              {visibleScopes.length > 0 && (
                <>
                  {sortedMediaScopes.length > 0 && (
                    <>
                      <div className="studio-detail-label" style={{ marginTop: 6 }}>
                        接收的媒体
                        {scopeLoading && <Loader2 size={11} className="spin" style={{ marginLeft: 6, verticalAlign: 'middle' }} />}
                      </div>
                      <ul className="studio-scopes">
                        {sortedMediaScopes.map((scope) => renderScopeRow(scope))}
                      </ul>
                    </>
                  )}

                  {cacheScopes.length > 0 && (
                    <>
                      <div className="studio-detail-label" style={{ marginTop: 8 }}>缓存与临时数据</div>
                      <ul className="studio-scopes">
                        <li
                          className="studio-scope-row bulk"
                          title={`合并清理 ${cacheScopes.length} 个无害桶（缓存 / 临时 / 日志 / 遥测）；后端仍按单 scope 执行`}
                        >
                          <span className="studio-scope-label">一键清理（{cacheScopes.length} 个桶）</span>
                          <span className="mono-num studio-scope-size">
                            {scopeSizes === null
                              ? '—'
                              : `${formatBytes(cacheTotal.bytes)}${cacheTotal.files ? ` · ${cacheTotal.files.toLocaleString()}` : ''}`}
                          </span>
                          <button
                            className={'secondary studio-scope-btn' + (armedScope === BULK_CACHE_ID ? ' armed' : '')}
                            disabled={
                              busyScope !== null ||
                              scopeLoading ||
                              scopeSizes === null ||
                              cacheTotal.bytes === 0
                            }
                            onClick={handleBulkClick}
                          >
                            {busyScope === BULK_CACHE_ID
                              ? <><Loader2 size={11} className="spin" /> 清理中</>
                              : armedScope === BULK_CACHE_ID
                                ? <><Trash2 size={11} /> 再点确认</>
                                : <><Trash2 size={11} /> 清理</>}
                          </button>
                        </li>
                      </ul>
                    </>
                  )}

                  {backupScopes.length > 0 && (
                    <>
                      <div className="studio-detail-label" style={{ marginTop: 8 }}>聊天备份</div>
                      <ul className="studio-scopes">
                        {backupScopes.map((scope) => renderScopeRow(scope))}
                      </ul>
                    </>
                  )}

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

/// Conda env list with per-env checkbox + bulk-recycle button. Base env
/// always appears as a non-clickable row at the top so users see it's
/// protected (rather than wondering "where did base go"). Stale envs
/// (default_checked from backend) are pre-selected; user can toggle.
/// Recycle Bin gets one entry per env (not per file) — see lib.rs's
/// envs-stale special case in execute_scope.
function CondaEnvsSection({
  envs,
  loading,
  selected,
  onToggleEnv,
  selectedTotal,
  onCleanup,
  armed,
  busy,
  anyBusy,
}: {
  envs: CondaEnv[] | null;
  loading: boolean;
  selected: Set<string>;
  onToggleEnv: (name: string) => void;
  selectedTotal: { count: number; bytes: number };
  onCleanup: () => void;
  armed: boolean;
  busy: boolean;
  anyBusy: boolean;
}) {
  if (envs === null) {
    return (
      <div className="studio-detail-row">
        <span className="studio-detail-label">Environments</span>
        <span className="muted small">
          {loading ? <><Loader2 size={11} className="spin" /> 读取中…</> : '—'}
        </span>
      </div>
    );
  }

  const userEnvs = envs.filter((e) => !e.is_base);
  const baseEnv = envs.find((e) => e.is_base);

  if (userEnvs.length === 0) {
    return (
      <>
        <div className="studio-detail-label" style={{ marginTop: 6 }}>Environments</div>
        {baseEnv && (
          <div className="muted small" style={{ paddingLeft: 2, marginTop: 2 }}>
            base · {formatBytes(baseEnv.size_bytes)} · 不可清
          </div>
        )}
        <div className="muted small" style={{ paddingLeft: 2, marginTop: 4 }}>
          没有用户创建的 environment（envs/ 为空）。可用 <code>conda env list</code> 在终端确认。
        </div>
      </>
    );
  }

  const staleCount = userEnvs.filter((e) => e.default_checked).length;

  return (
    <>
      <div className="studio-detail-label" style={{ marginTop: 6 }}>
        Environments
        {loading && <Loader2 size={11} className="spin" style={{ marginLeft: 6, verticalAlign: 'middle' }} />}
      </div>
      <div className="muted small" style={{ paddingLeft: 2, marginBottom: 4 }}>
        {staleCount > 0
          ? `发现 ${staleCount} 个 90 天没动过的 env · 已默认勾选`
          : `${userEnvs.length} 个 env · 都在 90 天内有过 conda 操作 · 默认全不勾`}
      </div>
      <ul className="studio-scopes">
        {baseEnv && (
          <li className="studio-scope-row empty" title="base 是 conda 安装本身，永不可清。">
            <span className="studio-scope-label muted">
              <input type="checkbox" disabled checked={false} style={{ marginRight: 6 }} />
              base · 不可清
            </span>
            <span className="mono-num studio-scope-size muted">{formatBytes(baseEnv.size_bytes)}</span>
            <span className="muted small">{formatLastActive(baseEnv.last_active_ts)}</span>
          </li>
        )}
        {userEnvs.map((e) => {
          const checked = selected.has(e.name);
          return (
            <li
              key={e.name}
              className="studio-scope-row"
              title={e.path}
            >
              <label
                className="studio-scope-label"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: anyBusy ? 'not-allowed' : 'pointer', userSelect: 'none' }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={anyBusy}
                  onChange={() => onToggleEnv(e.name)}
                />
                <span className={checked ? '' : 'muted'}>{e.name}</span>
              </label>
              <span className="mono-num studio-scope-size">{formatBytes(e.size_bytes)}</span>
              <span className="muted small">{formatLastActive(e.last_active_ts)}</span>
            </li>
          );
        })}
        <li className="studio-scope-row bulk" title="选中的 env 整个走系统回收站；可还原。base 永不动。">
          <span className="studio-scope-label">
            清理选中的 environment（{selectedTotal.count}）
          </span>
          <span className="mono-num studio-scope-size">{formatBytes(selectedTotal.bytes)}</span>
          <button
            className={'secondary studio-scope-btn' + (armed ? ' armed' : '')}
            disabled={busy || selectedTotal.count === 0 || (anyBusy && !busy)}
            onClick={onCleanup}
          >
            {busy
              ? <><Loader2 size={11} className="spin" /> 清理中</>
              : armed
                ? <><Trash2 size={11} /> 再点确认</>
                : <><Trash2 size={11} /> 清理</>}
          </button>
        </li>
      </ul>
    </>
  );
}
