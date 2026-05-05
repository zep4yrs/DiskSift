import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  RefreshCw,
  Folder,
  Trash2,
  Search,
  Zap,
  AlertTriangle,
  X,
  FileText,
  ChevronRight,
  Boxes,
} from 'lucide-react';
import clsx from 'clsx';
import { api } from '../api';
import type { SteamGame, SteamInventory } from '../types';
import { formatBytes } from '../format';
import { SteamWorkshopModal } from './SteamWorkshopModal';

type Pivot = 'sleep' | 'size' | 'library' | 'lastplayed';

const PIVOT_LABELS: Record<Pivot, string> = {
  sleep: '推荐顺序',
  size: '按占用大小',
  library: '按所在硬盘',
  lastplayed: '按最近玩过',
};

const PIVOT_ORDER: Pivot[] = ['sleep', 'size', 'library', 'lastplayed'];

function relativeTime(ts: number | null): string {
  if (ts == null) return '从未启动';
  const now = Date.now() / 1000;
  const diff = now - ts;
  if (diff < 0) return '刚刚';
  const day = 86400;
  const month = day * 30.4375;
  const year = month * 12;
  if (diff < day) return '今天';
  if (diff < 2 * day) return '昨天';
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  if (diff < month) return `${Math.floor(diff / day / 7)} 周前`;
  if (diff < 2 * month) return '上月';
  if (diff < year) return `${Math.floor(diff / month)} 个月前`;
  return `${Math.floor(diff / year)} 年前`;
}

function absoluteTime(ts: number | null): string {
  if (ts == null) return '从未启动';
  const d = new Date(ts * 1000);
  return d.toISOString().slice(0, 10);
}

function sleepScore(g: SteamGame): number {
  if (g.is_ghost) return Number.POSITIVE_INFINITY;
  const sizeGb = g.size_bytes / 1_000_000_000;
  const now = Date.now() / 1000;
  const monthsSince = g.last_played_ts == null ? 12 : (now - g.last_played_ts) / (86400 * 30.4375);
  return sizeGb * monthsSince;
}

function sortByPivot(games: SteamGame[], pivot: Pivot): SteamGame[] {
  const list = [...games];
  switch (pivot) {
    case 'sleep':
      list.sort((a, b) => sleepScore(b) - sleepScore(a));
      break;
    case 'size':
      list.sort((a, b) => b.size_bytes - a.size_bytes);
      break;
    case 'library':
      list.sort((a, b) => {
        const lib = a.library_root.localeCompare(b.library_root);
        if (lib !== 0) return lib;
        return b.size_bytes - a.size_bytes;
      });
      break;
    case 'lastplayed':
      list.sort((a, b) => {
        // Never-played sinks; ghost surfaces. Most-recent at top.
        const aT = a.last_played_ts ?? 0;
        const bT = b.last_played_ts ?? 0;
        return bT - aT;
      });
      break;
  }
  return list;
}

export function SteamInspector() {
  const [inventory, setInventory] = useState<SteamInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedAppid, setSelectedAppid] = useState<number | null>(null);
  const [enabledLibraries, setEnabledLibraries] = useState<Set<string>>(new Set());
  const [pivot, setPivot] = useState<Pivot>('sleep');
  const [searchQuery, setSearchQuery] = useState('');
  const [showTeach, setShowTeach] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [workshopFor, setWorkshopFor] = useState<SteamGame | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // ------------------------------------------------------------------
  // Data
  // ------------------------------------------------------------------
  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .listSteamGames()
      .then((inv) => {
        setInventory(inv);
        setLoading(false);
        // §6.6 teaching banner — only when scan succeeded with games.
        const total = inv.libraries.reduce((sum, l) => sum + l.games.length, 0);
        if (inv.steam_root && total > 0) {
          setShowTeach(true);
          window.setTimeout(() => setShowTeach(false), 4500);
        }
        // Default-enable all libraries discovered (= no filter).
        setEnabledLibraries(new Set(inv.libraries.map((l) => l.root)));
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const allGames: SteamGame[] = useMemo(() => {
    if (!inventory) return [];
    const games: SteamGame[] = [];
    for (const lib of inventory.libraries) {
      if (enabledLibraries.size > 0 && !enabledLibraries.has(lib.root)) continue;
      games.push(...lib.games);
    }
    let list = games;
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (g) =>
          g.name_en.toLowerCase().includes(q) ||
          g.install_dir_name.toLowerCase().includes(q) ||
          (g.name_cn?.toLowerCase().includes(q) ?? false),
      );
    }
    return sortByPivot(list, pivot);
  }, [inventory, enabledLibraries, pivot, searchQuery]);

  const selectedGame: SteamGame | null = useMemo(
    () => allGames.find((g) => g.appid === selectedAppid) ?? null,
    [allGames, selectedAppid],
  );

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------
  const showToast = (text: string, ms = 2400) => {
    setToast(text);
    window.setTimeout(() => setToast(null), ms);
  };

  const doRevealManifest = useCallback(
    async (g: SteamGame) => {
      try {
        await api.revealInExplorer(g.appmanifest_path);
      } catch (e) {
        showToast(`打不开：${String(e)}`);
      }
    },
    [],
  );

  const doUninstallViaSteam = useCallback(async (g: SteamGame) => {
    showToast('正在唤起 Steam 卸载对话框…');
    try {
      await api.openSteamUrl('uninstall', g.appid);
      // §6.6: if Steam doesn't come to front in 800ms, gently nudge.
      window.setTimeout(() => {
        showToast('如果 Steam 没弹出来，请确认 Steam 客户端正在运行');
      }, 800);
    } catch (e) {
      showToast(`唤起 Steam 失败：${String(e)}`);
    }
  }, []);

  const navigate = useCallback(
    (delta: number) => {
      if (allGames.length === 0) return;
      const idx = selectedAppid != null ? allGames.findIndex((g) => g.appid === selectedAppid) : -1;
      const nextIdx = Math.max(0, Math.min(allGames.length - 1, idx + delta));
      setSelectedAppid(allGames[nextIdx].appid);
      // Scroll into view
      requestAnimationFrame(() => {
        listRef.current
          ?.querySelector(`[data-appid="${allGames[nextIdx].appid}"]`)
          ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    },
    [allGames, selectedAppid],
  );

  // ------------------------------------------------------------------
  // Keyboard
  // ------------------------------------------------------------------
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const inEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target?.isContentEditable ?? false);
      // Allow `/` from anywhere; allow Esc from search box.
      if (e.key === '/' && !inEditable) {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (e.key === 'Escape' && inEditable) {
        searchInputRef.current?.blur();
        return;
      }
      if (inEditable) return;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          navigate(1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          navigate(-1);
          break;
        case 'Enter':
          e.preventDefault();
          if (selectedAppid != null) setSelectedAppid(null);
          else if (allGames.length > 0) setSelectedAppid(allGames[0].appid);
          break;
        case 'Escape':
          e.preventDefault();
          setSelectedAppid(null);
          break;
        case 'u':
        case 'U':
          if (selectedGame) doUninstallViaSteam(selectedGame);
          break;
        case 'r':
        case 'R':
          refresh();
          break;
        case '1':
        case '2':
        case '3':
        case '4': {
          const idx = parseInt(e.key, 10) - 1;
          setPivot(PIVOT_ORDER[idx]);
          break;
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, selectedAppid, allGames, selectedGame, doUninstallViaSteam, refresh]);

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  const totalGames = inventory?.libraries.reduce((s, l) => s + l.games.length, 0) ?? 0;
  const totalSize = inventory?.libraries.reduce((s, l) => s + l.total_size_bytes, 0) ?? 0;

  return (
    <div className="steam-inspector">
      {/* ------ progress / teach banners ------ */}
      {loading && (
        <div className="steam-progress">
          <RefreshCw size={13} className="spin" />
          <span>正在扫描 Steam 库…</span>
        </div>
      )}
      {showTeach && (
        <div className="steam-teach">
          扫描到 <b>{totalGames}</b> 款游戏，共 <b>{formatBytes(totalSize)}</b>。建议从「沉睡分」排序看推荐处理。
          <button className="steam-teach-close" onClick={() => setShowTeach(false)} title="关闭">
            <X size={12} />
          </button>
        </div>
      )}
      {error && <div className="steam-error">扫描出错：{error}</div>}

      {/* ------ states without the three-column body ------ */}
      {!loading && !error && inventory && !inventory.steam_root && (
        <SteamNotFound candidates={inventory.candidates_checked} onRetry={refresh} />
      )}
      {!loading && !error && inventory && inventory.steam_root && totalGames === 0 && (
        <SteamEmpty steamRoot={inventory.steam_root} onRetry={refresh} />
      )}

      {/* ------ main 3-column body ------ */}
      {!loading && !error && inventory && inventory.steam_root && totalGames > 0 && (
        <div className="steam-body">
          {/* LEFT: filters & pivots */}
          <aside className="steam-filters">
            <div className="steam-filter-section">
              <h4>库根</h4>
              {inventory.libraries.map((lib) => (
                <label key={lib.root} className="steam-filter-row">
                  <input
                    type="checkbox"
                    checked={enabledLibraries.has(lib.root)}
                    onChange={(e) => {
                      setEnabledLibraries((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(lib.root);
                        else next.delete(lib.root);
                        return next;
                      });
                    }}
                  />
                  <div className="steam-filter-row-text">
                    <div className="steam-filter-row-name">{shortLibName(lib.root)}</div>
                    <div className="steam-filter-row-meta">
                      {lib.games.length} 款 · {formatBytes(lib.total_size_bytes)}
                    </div>
                  </div>
                </label>
              ))}
            </div>
            <div className="steam-filter-section">
              <h4>透视</h4>
              {PIVOT_ORDER.map((p, i) => (
                <label key={p} className={clsx('steam-pivot-row', { active: pivot === p })}>
                  <input
                    type="radio"
                    name="steam-pivot"
                    checked={pivot === p}
                    onChange={() => setPivot(p)}
                  />
                  <span>{PIVOT_LABELS[p]}</span>
                  <kbd className="steam-kbd">{i + 1}</kbd>
                </label>
              ))}
            </div>
            <div className="steam-filter-meta">
              共 {totalGames} 款 · {formatBytes(totalSize)}
              <button className="steam-icon-btn" onClick={refresh} title="重新扫描 (R)">
                <RefreshCw size={12} />
              </button>
            </div>
          </aside>

          {/* MIDDLE: list */}
          <section className="steam-list-wrap">
            <div className="steam-search">
              <Search size={13} />
              <input
                ref={searchInputRef}
                type="text"
                placeholder="搜索游戏名… (按 /)"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button className="steam-icon-btn" onClick={() => setSearchQuery('')} title="清除">
                  <X size={12} />
                </button>
              )}
            </div>
            <div className="steam-list" ref={listRef} role="listbox">
              {allGames.length === 0 && (
                <div className="steam-list-empty">没有匹配的游戏。</div>
              )}
              {allGames.map((g) => (
                <SteamRow
                  key={`${g.library_root}-${g.appid}`}
                  game={g}
                  selected={g.appid === selectedAppid}
                  onClick={() => setSelectedAppid(g.appid === selectedAppid ? null : g.appid)}
                />
              ))}
            </div>
          </section>

          {/* RIGHT: detail rail (only when a game is selected) */}
          {selectedGame && (
            <SteamDetailRail
              game={selectedGame}
              onClose={() => setSelectedAppid(null)}
              onRevealManifest={() => doRevealManifest(selectedGame)}
              onUninstall={() => doUninstallViaSteam(selectedGame)}
              onShowWorkshop={() => setWorkshopFor(selectedGame)}
            />
          )}
        </div>
      )}

      {/* ------ toast ------ */}
      {toast && <div className="steam-toast">{toast}</div>}

      {/* ------ workshop sub-modal ------ */}
      {workshopFor && (
        <SteamWorkshopModal
          game={workshopFor}
          onClose={() => setWorkshopFor(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SteamRow({
  game,
  selected,
  onClick,
}: {
  game: SteamGame;
  selected: boolean;
  onClick: () => void;
}) {
  const displayName = game.name_cn ?? game.name_en;
  const altName = game.name_cn ? game.name_en : game.install_dir_name;
  return (
    <div
      role="option"
      aria-selected={selected}
      data-appid={game.appid}
      className={clsx('steam-row', {
        selected,
        recommended: game.default_recommended && !game.is_ghost,
        ghost: game.is_ghost,
      })}
      onClick={onClick}
    >
      <div className="steam-row-icon">
        {game.is_ghost ? <AlertTriangle size={14} /> : game.default_recommended ? <Zap size={14} /> : null}
      </div>
      <div className="steam-row-name">
        <div className="steam-row-name-primary">{displayName || `appid ${game.appid}`}</div>
        {altName && altName !== displayName && (
          <div className="steam-row-name-alt">{altName}</div>
        )}
        {game.recommendation_reason && (
          <div className="steam-row-reason">{game.recommendation_reason}</div>
        )}
      </div>
      <div className="steam-row-size">{formatBytes(game.size_bytes)}</div>
      <div className="steam-row-time">{relativeTime(game.last_played_ts)}</div>
      <div className="steam-row-chevron">
        <ChevronRight size={14} />
      </div>
    </div>
  );
}

function SteamDetailRail({
  game,
  onClose,
  onRevealManifest,
  onUninstall,
  onShowWorkshop,
}: {
  game: SteamGame;
  onClose: () => void;
  onRevealManifest: () => void;
  onUninstall: () => void;
  onShowWorkshop: () => void;
}) {
  return (
    <aside className="steam-detail">
      <div className="steam-detail-head">
        <div className="steam-detail-title">{game.name_cn ?? game.name_en}</div>
        {game.name_cn && <div className="steam-detail-subtitle">{game.name_en}</div>}
        {!game.name_cn && game.name_en !== game.install_dir_name && (
          <div className="steam-detail-subtitle">{game.install_dir_name}</div>
        )}
        <button className="steam-icon-btn steam-detail-close" onClick={onClose} title="关闭 (Esc)">
          <X size={14} />
        </button>
      </div>

      {game.is_ghost && (
        <div className="steam-ghost-banner">
          <AlertTriangle size={14} />
          <div>
            <b>检测到鬼魂安装</b>
            <p>ACF 元数据存在但安装目录已缺失或不完整。建议在 Steam 中右键卸载，或属性 → 已安装文件 → 验证完整性。Inspector 不替你清 ACF。</p>
          </div>
        </div>
      )}

      <div className="steam-detail-meta">
        <div><span>appid</span><b>{game.appid}</b></div>
        <div><span>大小</span><b>{formatBytes(game.size_bytes)}</b></div>
        <div><span>上次启动</span><b>{absoluteTime(game.last_played_ts)} · {relativeTime(game.last_played_ts)}</b></div>
        <div><span>库根</span><b>{shortLibName(game.library_root)}</b></div>
        <div><span>状态</span><b>{game.is_fully_installed ? '完整' : `不完整（StateFlags=${game.state_flags}）`}</b></div>
      </div>

      {game.default_recommended && game.recommendation_reason && (
        <div className="steam-detail-reason">
          <Zap size={13} />
          <div>
            <b>建议处理</b>
            <p>{game.recommendation_reason}</p>
          </div>
        </div>
      )}

      <div className="steam-detail-citations">
        <div className="steam-citation-label">Sources</div>
        <button className="steam-citation" onClick={onRevealManifest} title="在 Explorer 中定位 ACF 文件">
          <FileText size={12} />
          <span className="steam-citation-text">{shortPath(game.appmanifest_path)}</span>
        </button>
        <div className="steam-citation steam-citation-static">
          <Folder size={12} />
          <span className="steam-citation-text">{shortPath(game.install_path)}</span>
        </div>
      </div>

      <div className="steam-detail-actions">
        <button className="steam-action steam-action-primary" onClick={onUninstall} title="唤起 Steam 卸载 (U)">
          <Trash2 size={13} />
          <span>在 Steam 中卸载</span>
          <kbd className="steam-kbd">U</kbd>
        </button>
        {game.workshop_item_count > 0 && (
          <button className="steam-action" onClick={onShowWorkshop} title="查看这个游戏的创意工坊订阅">
            <Boxes size={13} />
            <span>查看创意工坊（{game.workshop_item_count} 项）</span>
          </button>
        )}
      </div>
    </aside>
  );
}

function SteamNotFound({
  candidates,
  onRetry,
}: {
  candidates: string[];
  onRetry: () => void;
}) {
  return (
    <div className="steam-empty-state">
      <div className="steam-empty-title">未检测到 Steam</div>
      <p>我们查过了下面这些路径和 Windows 注册表（HKCU\Software\Valve\Steam），都没有找到 Steam 安装：</p>
      <ul className="steam-path-list">
        {candidates.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <p className="steam-empty-hint">
        如果你的 Steam 装在其他位置，手动指定路径功能会在后续版本支持（已登记到设计文档 §11）。先确认 Steam 装好且至少打开过一次（Steam 写注册表是登录后的行为），再点重新扫描。
      </p>
      <button className="steam-action" onClick={onRetry}>
        <RefreshCw size={13} />
        <span>重新扫描</span>
      </button>
    </div>
  );
}

function SteamEmpty({ steamRoot, onRetry }: { steamRoot: string; onRetry: () => void }) {
  return (
    <div className="steam-empty-state">
      <div className="steam-empty-title">Steam 找到了，但没游戏</div>
      <p>
        Steam 安装在 <code>{steamRoot}</code>，但 <code>steamapps/</code> 下没有 appmanifest_*.acf 文件。可能 Steam 是裸装、没装游戏，或者库都迁到了别的盘但 libraryfolders.vdf 没更新。
      </p>
      <button className="steam-action" onClick={onRetry}>
        <RefreshCw size={13} />
        <span>重新扫描</span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortLibName(libRoot: string): string {
  // "C:/Program Files (x86)/Steam" -> "C: (Steam)"
  // "D:/SteamLibrary"               -> "D: (SteamLibrary)"
  const m = libRoot.match(/^([A-Z]):.*?\/([^/]+)\/?$/);
  if (m) return `${m[1]}: (${m[2]})`;
  return libRoot;
}

function shortPath(p: string): string {
  // Trim middle if too long for the rail.
  if (p.length <= 56) return p;
  const head = p.slice(0, 30);
  const tail = p.slice(-22);
  return `${head}…${tail}`;
}
