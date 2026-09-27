import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { ArchiveRestore, History, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../api';
import { formatBytes } from '../format';
import type { UndoEntry } from '../types';

// 操作记录视图数据面（redesign-spec §4）：
//   · table.list 展示 undo.jsonl（时间 / 动作 / 源路径 / 操作）；
//   · 撤销中心升级：条目按天分组（今天 / 昨天 / 近 7 天 / 更早，组内时间倒序，
//     组头复用 .side-group 分组视觉语言）；
//   · 每条动作徽标带 Lucide 动作图标（recycle=refresh-cw / quarantine=archive-restore /
//     delete=trash-2），语义色沿用 ACTION_BADGE 徽标 info/warn/danger（currentColor）；
//   · 隔离条目带「还原」按钮，走两步确认（点一次进入 armed 预备态，
//     再点一次才真正调用 restore_quarantine；5 秒、点外部或 Esc 取消）；
//   · 回收站条目带「打开回收站」，交给资源管理器（后端 shell:RecycleBinFolder）。
// 供 App.tsx 的 records 视图挂载：<RecordsView />。数据与刷新由组件自管；
// 样式只消费 styles.css 既有词汇（.side-group / .badge），不引入新类。
// 注：undo 条目是否 dry-run 由后端 list_undo 按 reason 前缀 DRY_RUN 过滤
// （apps/desktop/src-tauri/src/lib.rs list_undo），前端收到的已是真实操作。

/** 一次拉取条数。undo.jsonl 只增不删，视图默认只看最近的这批，够用且省 IPC。 */
const PAGE = 200;
/** armed 预备态自动解除毫秒数（与 CleanupModal 的 5 秒纪律一致）。 */
const ARMED_MS = 5000;

const ACTION_LABEL: Record<UndoEntry['action'], string> = {
  recycle: '回收站',
  quarantine: '隔离',
  delete: '删除',
};

/** 语义徽标色：隔离=warn（可逆但已挪位），删除=danger（不可逆），回收站=info。 */
const ACTION_BADGE: Record<UndoEntry['action'], 'info' | 'warn' | 'danger'> = {
  recycle: 'info',
  quarantine: 'warn',
  delete: 'danger',
};

/** 动作图标（撤销中心升级②）：一律 Lucide 提取组件，禁手绘；
 *  色彩随徽标 currentColor（.badge.info/.warn/.danger）。 */
const ACTION_ICON: Record<UndoEntry['action'], typeof RefreshCw> = {
  recycle: RefreshCw,
  quarantine: ArchiveRestore,
  delete: Trash2,
};

// ── 按天分组（撤销中心升级①）：今天 / 昨天 / 近 7 天 / 更早 ─────────────
// 边界用本地零点 + setDate 回退（跨夏令时也稳）；解析失败的时间归入「更早」。
const DAY_GROUPS = ['今天', '昨天', '近 7 天', '更早'] as const;
type DayGroup = (typeof DAY_GROUPS)[number];

function dayGroupOf(ts: string): DayGroup {
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return '更早';
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const yesterday = new Date(start);
  yesterday.setDate(yesterday.getDate() - 1);
  const weekStart = new Date(start);
  weekStart.setDate(weekStart.getDate() - 6); // 今天往前共 7 天的窗口起点
  if (t >= start.getTime()) return '今天';
  if (t >= yesterday.getTime()) return '昨天';
  if (t >= weekStart.getTime()) return '近 7 天';
  return '更早';
}

/** 分组 + 组内时间倒序（undo.jsonl 本就倒序返回，这里显式排序不依赖顺序约定）。 */
function groupByDay(entries: UndoEntry[]): { group: DayGroup; items: UndoEntry[] }[] {
  const buckets = new Map<DayGroup, UndoEntry[]>();
  for (const e of entries) {
    const g = dayGroupOf(e.timestamp);
    const arr = buckets.get(g);
    if (arr) arr.push(e);
    else buckets.set(g, [e]);
  }
  return DAY_GROUPS.filter((g) => (buckets.get(g)?.length ?? 0) > 0).map((group) => ({
    group,
    items: (buckets.get(group) ?? []).slice().sort((a, b) => {
      const ta = new Date(a.timestamp).getTime();
      const tb = new Date(b.timestamp).getTime();
      return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
    }),
  }));
}

type Props = {
  /** Side Bar 动作筛选（spec §4）：'all' 或具体动作；缺省 'all'。对已加载条目做客户端过滤。 */
  actionFilter?: 'all' | UndoEntry['action'];
  /** Side Bar 时间筛选（spec §4）：只看最近 N 天；null/缺省 = 不限。 */
  sinceDays?: number | null;
};

function fmtTime(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

function rowKey(e: UndoEntry, i: number): string {
  // timestamp 毫秒级，同一 Plan 的多条记录可能同毫秒；补上 source + 序号保证唯一。
  return `${i}:${e.timestamp}:${e.source}`;
}

export function RecordsView({ actionFilter = 'all', sinceDays = null }: Props = {}) {
  const [entries, setEntries] = useState<UndoEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [armedKey, setArmedKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(() => {
    setArmedKey(null);
    api
      .listUndo(PAGE)
      .then((v) => {
        setEntries(v);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // armed 纪律：点组件外部 / Esc / 超时都解除预备态（ContextMenu / CleanupModal 同款）。
  useEffect(() => {
    if (!armedKey) return;
    const onDown = (ev: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) {
        setArmedKey(null);
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setArmedKey(null);
    };
    const timer = window.setTimeout(() => setArmedKey(null), ARMED_MS);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [armedKey]);

  const onRestore = (e: UndoEntry, key: string) => {
    if (key !== armedKey) {
      // 第一步：进入预备态，不产生任何副作用。
      setArmedKey(key);
      setNotice(null);
      return;
    }
    // 第二步：真正还原。源已存在等情况由后端 Err 阻断（防覆盖），错误原样展示。
    setBusyKey(key);
    api
      .restoreQuarantine(e)
      .then(() => {
        setNotice(`已还原：${e.source}`);
        setError(null);
      })
      .catch((err) => setError(String(err)))
      .finally(() => {
        setBusyKey(null);
        setArmedKey(null);
        // undo.jsonl 是 append-only 台账，还原后该记录仍在表内（源路径已恢复存在，
        // 后端会在再次尝试时阻断）；重拉让用户看到最新状态。
        reload();
      });
  };

  const canRestore = (e: UndoEntry): boolean =>
    e.action === 'quarantine' && !!e.destination;

  // 侧栏筛选（spec §4：动作/时间）在已加载条目上做客户端过滤；
  // undo.jsonl 倒序返回，截取页之外的旧记录不参与过滤（页脚计数已标明）。
  const filtered = entries?.filter((e) => {
    if (actionFilter !== 'all' && e.action !== actionFilter) return false;
    if (sinceDays != null) {
      const t = new Date(e.timestamp).getTime();
      if (Number.isNaN(t) || Date.now() - t > sinceDays * 86_400_000) return false;
    }
    return true;
  }) ?? null;

  return (
    <div ref={rootRef} className="editor-scroll">
      <div className="card-head">
        <span className="sec-title">
          <History size={15} /> 操作记录
        </span>
        <div className="grow" />
        {entries !== null && filtered !== null && (
          <span className="muted small">
            显示 {filtered.length} / 共 {entries.length} 条{entries.length >= PAGE ? '（已截取）' : ''}
          </span>
        )}
        <button className="btn ghost small" onClick={reload} title="重新读取 undo.jsonl">
          <RefreshCw size={13} /> 刷新
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}
      {notice && !error && (
        <div className="banner">
          <span className="badge ok">已还原</span> <span className="mono">{notice}</span>
        </div>
      )}

      {entries === null || filtered === null ? (
        !error && <div className="muted">读取中…</div>
      ) : filtered.length === 0 ? (
        entries.length === 0 ? (
          <div className="empty">
            <div className="empty-title">还没有操作记录</div>
            <div className="empty-sub">
              清理动作会记录在这里，可随时追溯 — 每一次回收 / 隔离 / 删除都会记进 undo.jsonl，可查可还原。
            </div>
          </div>
        ) : (
          <div className="empty">
            <div className="empty-title">当前筛选没有匹配条目</div>
            <div className="empty-sub">在侧栏调整动作或时间范围；或点「刷新」重读 undo.jsonl。</div>
          </div>
        )
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>时间</th>
              <th>动作</th>
              <th>源路径</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {groupByDay(filtered).map(({ group, items }) => {
              // 每日释放体积：recycle 条目的 bytes 合计（26.1.0 历史行无此字段，按 0 计）
              const dayBytes = items.reduce((s, e) => s + (e.bytes ?? 0), 0);
              return (
              <Fragment key={group}>
                <tr>
                  <td colSpan={4} className="side-group">
                    {group} · {items.length} 项
                    {dayBytes > 0 && ` · ${formatBytes(dayBytes)}`}
                  </td>
                </tr>
                {items.map((e, i) => {
                  const key = rowKey(e, i);
                  const armed = armedKey === key;
                  const ActionIcon = ACTION_ICON[e.action];
                  return (
                    <tr key={key}>
                      <td className="mono">{fmtTime(e.timestamp)}</td>
                      <td>
                        <span className={`badge ${ACTION_BADGE[e.action]}`} style={{ gap: 4 }}>
                          <ActionIcon size={11} /> {ACTION_LABEL[e.action]}
                        </span>
                      </td>
                      <td className="path-clip" title={e.source}>
                        {e.source}
                      </td>
                      <td>
                        {canRestore(e) ? (
                          <button
                            className={'btn danger small' + (armed ? ' armed' : '')}
                            disabled={busyKey !== null}
                            onClick={() => onRestore(e, key)}
                            title={
                              armed
                                ? '再点一次确认还原；点其他地方或按 Esc 取消'
                                : '把隔离区条目移回源路径（点一次确认，再点一次执行）'
                            }
                          >
                            <ArchiveRestore size={12} />
                            {busyKey === key ? '还原中…' : armed ? '确认还原' : '还原'}
                          </button>
                        ) : e.action === 'recycle' ? (
                          <button
                            className="btn small"
                            onClick={() => api.openRecycleBin().catch((err) => setError(String(err)))}
                            title="在资源管理器中打开系统回收站"
                          >
                            打开回收站
                          </button>
                        ) : (
                          <span className="muted small">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
