import { useCallback, useEffect, useMemo, useState } from 'react';
import { X, Boxes, RefreshCw, ExternalLink, RotateCcw } from 'lucide-react';
import { api } from '../api';
import type { SteamGame, WorkshopItem } from '../types';
import { formatBytes } from '../format';

/// localStorage cache keyed by stringified item ID. Workshop titles are
/// extremely stable (renames are rare and not safety-critical), so we cache
/// permanently — the next time the modal opens we skip the network round
/// trip entirely. This is what makes the demo robust against flaky
/// connectivity to api.steampowered.com from mainland China: once you've
/// fetched successfully even once, every subsequent run is offline-clean.
const CACHE_KEY = 'pinkbin.workshopTitles';

function readTitleCache(): Record<number, string> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string>;
    const out: Record<number, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const n = Number(k);
      if (Number.isFinite(n) && typeof v === 'string') out[n] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeTitleCache(titles: Record<number, string>) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(titles));
  } catch {
    /* quota / private mode */
  }
}

/// Modal listing one game's installed Steam Workshop items. Lazily-loaded
/// (full size + mtime per item is too slow for the bulk inspect, so we
/// compute on-demand when the user clicks the detail-rail button).
///
/// Honesty caveat: `last_modified_ts` is the workshop item folder's mtime —
/// roughly "Steam last updated this item", **not** "user last used this
/// item". Steam doesn't record the latter anywhere accessible. UI labels
/// this as "上次更新" and the empty-state hint explains the distinction.
export function SteamWorkshopModal({
  game,
  onClose,
}: {
  game: SteamGame;
  onClose: () => void;
}) {
  const [items, setItems] = useState<WorkshopItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'oldest' | 'size'>('oldest');
  // Titles seed from localStorage cache so previously-seen items render with
  // names instantly, before any network call.
  const [titles, setTitles] = useState<Record<number, string>>(() => readTitleCache());
  const [titlesLoading, setTitlesLoading] = useState(false);
  const [titlesError, setTitlesError] = useState<string | null>(null);

  /// Fetch titles for IDs missing from the current `titles` map. Reused by
  /// initial load and the manual retry button; cancellation is handled per-call.
  const fetchMissingTitles = useCallback(
    async (allItems: WorkshopItem[]) => {
      const cached = readTitleCache();
      const missing = allItems.map((it) => it.id).filter((id) => !(id in cached));
      if (missing.length === 0) {
        // All known. Make sure UI reflects cache (in case it was newer).
        setTitles(cached);
        setTitlesError(null);
        setTitlesLoading(false);
        return;
      }
      setTitlesLoading(true);
      setTitlesError(null);
      try {
        const fetched = await api.fetchWorkshopTitles(missing);
        const merged = { ...cached, ...fetched };
        setTitles(merged);
        writeTitleCache(merged);
        setTitlesError(null);
      } catch (e) {
        // Show cached results regardless; surface only the missing-fetch error.
        setTitles(cached);
        setTitlesError(String(e));
      } finally {
        setTitlesLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Don't reset titles — keep cache-seeded values so the user sees names
    // immediately even before the item list arrives.
    setTitlesError(null);
    api
      .listSteamWorkshopItems(game.library_root, game.appid)
      .then((list) => {
        if (cancelled) return;
        setItems(list);
        setLoading(false);
        if (list.length > 0) {
          fetchMissingTitles(list);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [game.appid, game.library_root, fetchMissingTitles]);

  const onRetryTitles = useCallback(() => {
    if (items) fetchMissingTitles(items);
  }, [items, fetchMissingTitles]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        const inEditable =
          e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLTextAreaElement;
        if (!inEditable) onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const sorted = useMemo(() => {
    if (!items) return [];
    const list = [...items];
    if (sortBy === 'oldest') {
      list.sort((a, b) => a.last_modified_ts - b.last_modified_ts);
    } else {
      list.sort((a, b) => b.size_bytes - a.size_bytes);
    }
    return list;
  }, [items, sortBy]);

  const totalSize = items?.reduce((s, it) => s + it.size_bytes, 0) ?? 0;

  return (
    <div
      className="steam-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="steam-modal-dialog steam-workshop-dialog" role="dialog" aria-modal="true">
        <div className="steam-modal-head">
          <div className="steam-modal-title">
            <Boxes size={16} /> 创意工坊 · {game.name_cn ?? game.name_en}
          </div>
          <div className="steam-modal-subtitle">
            {loading
              ? '正在统计每个项目的大小和修改时间…'
              : `共 ${items?.length ?? 0} 项 · ${formatBytes(totalSize)}`}
          </div>
          <button className="steam-modal-close" onClick={onClose} title="关闭 (Esc)">
            <X size={16} />
          </button>
        </div>

        <div className="steam-modal-body steam-workshop-body">
          {/* Sort toolbar */}
          {!loading && items && items.length > 0 && (
            <div className="steam-workshop-toolbar">
              <span className="steam-workshop-toolbar-label">排序</span>
              <button
                className={'steam-workshop-sortbtn' + (sortBy === 'oldest' ? ' active' : '')}
                onClick={() => setSortBy('oldest')}
              >
                按最久没更新
              </button>
              <button
                className={'steam-workshop-sortbtn' + (sortBy === 'size' ? ' active' : '')}
                onClick={() => setSortBy('size')}
              >
                按占用大小
              </button>
            </div>
          )}

          {loading && (
            <div className="steam-workshop-loading">
              <RefreshCw size={14} className="spin" />
              <span>正在扫描 {game.workshop_item_count} 项创意工坊…</span>
            </div>
          )}

          {error && <div className="steam-workshop-error">扫描失败：{error}</div>}

          {!loading && !error && items && items.length === 0 && (
            <div className="steam-workshop-empty">
              没有找到创意工坊内容。可能 Steam 把它们放在别的地方，或者订阅都已经取消。
            </div>
          )}

          {!loading && !error && sorted.length > 0 && (
            <>
              <div className="steam-workshop-caveat">
                ⓘ "上次更新"是 Steam 上次同步这个内容的时间——Steam 没有记录每个工坊项的实际启动次数，但更新时间通常能近似判断"在不在用"。
              </div>
              {titlesLoading && (
                <div className="steam-workshop-titles-status">
                  <RefreshCw size={11} className="spin" />
                  <span>正在从 Steam 获取游戏名称…</span>
                </div>
              )}
              {!titlesLoading && titlesError && (
                <div className="steam-workshop-titles-status steam-workshop-titles-status--error">
                  <span>未能从 Steam 获取游戏名称（如果在国内可挂代理后重试）</span>
                  <button
                    className="steam-workshop-retry-btn"
                    onClick={onRetryTitles}
                    title="重新请求 Steam Web API"
                  >
                    <RotateCcw size={11} />
                    重试
                  </button>
                </div>
              )}
              <ul className="steam-workshop-list">
                {sorted.map((it) => (
                  <WorkshopRow key={it.id} item={it} title={titles[it.id]} />
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function WorkshopRow({ item, title }: { item: WorkshopItem; title?: string }) {
  const onOpenInSteam = async () => {
    try {
      await api.openSteamUrl('workshop_page', item.id);
    } catch {
      /* swallow — user can copy the URL by other means if Steam isn't running */
    }
  };
  return (
    <li className="steam-workshop-item">
      <div className="steam-workshop-item-main">
        {title ? (
          <>
            <div className="steam-workshop-item-title">{title}</div>
            <div className="steam-workshop-item-meta">
              <span className="steam-workshop-item-id-secondary">#{item.id}</span>
              <span className="steam-workshop-item-time">{relativeTime(item.last_modified_ts)}</span>
              <span className="steam-workshop-item-size">{formatBytes(item.size_bytes)}</span>
            </div>
          </>
        ) : (
          <>
            <div className="steam-workshop-item-id">#{item.id}</div>
            <div className="steam-workshop-item-meta">
              <span className="steam-workshop-item-time">{relativeTime(item.last_modified_ts)}</span>
              <span className="steam-workshop-item-size">{formatBytes(item.size_bytes)}</span>
            </div>
          </>
        )}
      </div>
      <button
        className="steam-workshop-item-link"
        onClick={onOpenInSteam}
        title="在 Steam 客户端中打开这个工坊页面"
      >
        <ExternalLink size={12} />
        <span>在 Steam 中打开</span>
      </button>
    </li>
  );
}

function relativeTime(ts: number): string {
  if (ts === 0) return '未知';
  const now = Date.now() / 1000;
  const diff = now - ts;
  const day = 86400;
  const month = day * 30.4375;
  const year = month * 12;
  if (diff < 0) return '刚刚';
  if (diff < day) return '今天更新';
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前更新`;
  if (diff < month) return `${Math.floor(diff / day / 7)} 周前更新`;
  if (diff < year) return `${Math.floor(diff / month)} 个月前更新`;
  return `${Math.floor(diff / year)} 年前更新`;
}
