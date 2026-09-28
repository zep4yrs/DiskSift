import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronRight, ChevronDown, FolderOpen, Copy, Trash2, Recycle } from 'lucide-react';
import type { Node } from '../types';
import { formatBytes, formatCount } from '../format';
import { api } from '../api';
import { useStore } from '../store';
import { ContextMenu, type ContextMenuState } from './ContextMenu';
import { Icon } from './Icon';
import { isFocusDimmed, type VerdictEntry } from '../triage-cache';

type Props = {
  root: Node;
  selectedPath: string | null;
  onSelect: (p: string) => void;
  /** 双向同步导航（sync-nav）：外部聚焦路径（空间图下钻/面包屑返回）。
   *  变化时祖先链全部自动展开 + scrollToIndex 定位；不在扫描根子树内则不动。 */
  focusPath?: string | null;
  /** 分诊图层 O1（triage-overlay-spec §4）：有判定的行加左缘 3px 同色条 */
  verdicts?: Map<string, VerdictEntry>;
  /** 祖先聚合徽标数据源（spec §2.1.1）：聚焦模式（§2.1.2）的祖先链豁免判定用 */
  cleanableUnder?: Map<string, number>;
  /** 「只看可清理」聚焦模式（spec §2.1.2）：非可清理行同步淡显 */
  focusClean?: boolean;
  /** f5-0 字号档位的 CSS zoom（.app-v2 上 sm 0.88 / lg 1.04 / xl 1.12）。
   *  虚拟滚动的行高/偏移在视觉像素空间运算（scrollTop 与 rect 都是视觉 px），
   *  而 translateY/高度样式写在 zoom 子树内吃逻辑 px —— 缺省档 1 两者相等，
   *  非 1 档必须带 zoom 换算，否则 scrollToIndex 越滚越偏。 */
  zoom?: number;
};

// DFS 找 root → 目标 的节点链（含两端）；目标不在子树内返回 null。
// 用真实节点链而非字符串拼路径：路径分隔符/盘符写法由扫描端决定，这里不猜。
function chainTo(n: Node, p: string): Node[] | null {
  if (n.path === p) return [n];
  for (const c of n.children) {
    const sub = chainTo(c, p);
    if (sub) return [n, ...sub];
  }
  return null;
}

// 树行固定几何（styles.css .tree-row：height 22px + border-box，含 1px 底边）。
// 虚拟滚动的 estimateSize 必须与它严格一致，否则滚动定位漂移。
const ROW_H = 22;
const OVERSCAN = 12;

/** 可见行（v26.1.4.0 树虚拟滚动）：展开集合按 DFS 展平的行模型。 */
interface FlatRow {
  node: Node;
  depth: number;
  /** 行占比的分母（父目录 size）；根行 = 自身 size */
  parentSize: number;
}

export function TreeView({ root, selectedPath, onSelect, focusPath, verdicts, cleanableUnder, focusClean = false, zoom = 1 }: Props) {
  const [ctx, setCtx] = useState<ContextMenuState | null>(null);
  // 实时监控（v26.1.4.0 §1.2）：dirtyPaths（path→tick）驱动行内脏点；monitorTick
  // 入 flatRows 依赖——监控就地改写节点 size/file_count 后，行占比（parentSize）
  // 需要扁平行表按新值重建（行结构不变，重建成本 = O(可见行)）。
  const dirtyPaths = useStore((s) => s.dirtyPaths);
  const monitorTick = useStore((s) => s.monitorTick);

  // ── 受控展开（sync-nav：open 状态提升到这里）──────────────────────────
  // key=目录 path。初值 = 仅根展开（等价旧 initialOpen）。新扫描（root 变化）
  // 在渲染期重置（React「props 变化时调整状态」范式，避免旧键残留/首帧塌缩）。
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => ({ [root.path]: true }));
  const [prevRoot, setPrevRoot] = useState(root);
  // focus 链手动收起覆盖：focusAncestors 会把链上目录强制顶在展开态，用户点
  // chevron 收起时改 expanded[p] 也会被 includes(p) 盖回去（收不起来的根因）。
  // 这个集合显式记录「用户要它合上」，在 isOpen 里判定优先级最高。
  const [collapsedOverrides, setCollapsedOverrides] = useState<Set<string>>(() => new Set());
  // 行元素注册表：path → DOM（仅当前虚拟窗口内挂载的行）。供键盘 ↑↓ 导航把
  // 焦点搬到相邻行；滚动定位已改走 scrollToIndex，不再依赖它。
  const rowEls = useRef<Map<string, HTMLDivElement>>(new Map());
  if (prevRoot !== root) {
    setPrevRoot(root);
    setExpanded({ [root.path]: true });
    setCollapsedOverrides(new Set()); // 新扫描 = 新树，旧链的收起意图一并作废
    rowEls.current.clear();
  }

  // focusPath 的祖先链（root → … → 父目录），渲染期派生：行可见性直接吃它，
  // 展开在本次 commit 就生效，滚动 effect 拿到的扁平行表一定是最新布局。
  const focusAncestors = useMemo<string[] | null>(() => {
    if (!focusPath) return null;
    const chain = chainTo(root, focusPath);
    if (!chain) return null; // 不在扫描根子树内（跨盘等）：不动
    return chain.slice(0, -1).map((a) => a.path);
  }, [focusPath, root]);

  // 行可见性判定顺序：collapsedOverrides（用户显式收起，压过 focus 链）>
  // 手动展开 > focusPath 祖先链（渲染期派生，外部聚焦无需 effect 抢跑）。
  const isOpen = (p: string) => {
    if (collapsedOverrides.has(p)) return false;
    if (expanded[p]) return true;
    return focusAncestors?.includes(p) ?? false;
  };
  const toggleOpen = (p: string) => {
    if (focusAncestors?.includes(p)) {
      // 链上目录按「有效开合态」（isOpen，同序）分支，而不是 expanded[p]——链上
      // 目录在 expanded 里多半是 undefined，按它取反会误判成「当前收起」。
      const open = isOpen(p);
      setCollapsedOverrides((s) => {
        const next = new Set(s);
        if (open) next.add(p); // 展开→收起：记入覆盖集，focusAncestors 再也顶不回开态
        else next.delete(p); // 收起→再点：移出覆盖集，回到链上默认展开
        return next;
      });
      return;
    }
    // v26.1.2 修复：非链上分支也要先清覆盖集——目录在链上被手动收起后离开
    // 聚焦链，覆盖集条目原本永远清不掉（isOpen 里覆盖集短路优先，而非链分支
    // 只翻 expanded），用户点 caret 展开：新翻出的 expanded 值被覆盖集盖回，
    // caret 永久失效，仅重扫（root 变化清集）可解。用户点开 = 要它开，先移出
    // 覆盖集再翻 expanded；无条目时返回原 Set 避免多余渲染。链上分支语义不变
    //（收起仍记入覆盖集压过 focus 链，再点移出回到链上默认展开）。
    setCollapsedOverrides((s) => {
      if (!s.has(p)) return s;
      const next = new Set(s);
      next.delete(p);
      return next;
    });
    setExpanded((m) => ({ ...m, [p]: !m[p] }));
  };

  // ── 可见行扁平数组（v26.1.4.0 树虚拟滚动，规格 §5）────────────────────
  // 展开集合按 DFS 展平成行模型交给 useVirtualizer 渲染，替换旧
  // `children.slice(0, 500)` 补丁：全量子节点都在扁平表里，DOM 行数恒定
  //（≤ 可视行 + overscan），80 万文件全展开滚动不掉帧。展开语义与旧递归
  // 渲染逐字一致：collapsedOverrides > expanded > focusAncestors，空目录不展开。
  const flatRows = useMemo<FlatRow[]>(() => {
    const rows: FlatRow[] = [];
    const walk = (n: Node, depth: number, parentSize: number) => {
      rows.push({ node: n, depth, parentSize });
      if (n.is_dir && (n.children?.length ?? 0) > 0 && isOpen(n.path)) {
        for (const c of n.children) walk(c, depth + 1, n.size || 1);
      }
    };
    walk(root, 0, root.size || 1);
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, expanded, collapsedOverrides, focusAncestors, monitorTick]);

  // ── 虚拟滚动（@tanstack/react-virtual）───────────────────────────────
  // 行高/偏移一律在视觉像素空间运算（scrollTop 与 getBoundingClientRect 都是
  // 视觉 px）；回写 DOM（translateY/spacer 高度）时除回 zoom 变成 zoom 子树里
  // 的逻辑 px。缺省字号档 zoom=1，换算退化为恒等。
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H * zoom,
    overscan: OVERSCAN,
    getItemKey: (i) => flatRows[i].node.path,
  });
  // 字号档位切换（zoom 变化）：行高估计值整体缩放，显式失效缓存尺寸重算。
  useEffect(() => { rowVirtualizer.measure(); }, [zoom, rowVirtualizer]);

  // 滚动定位：focusPath/祖先链变化后的那次 commit 里执行（扁平行表已含新链，
  // scrollToIndex 可用）。旧覆盖链收起时聚焦行不在扁平表 → 找不到索引 = no-op，
  // 与旧 scrollIntoView 对已卸载行 no-op 的语义一致。
  useEffect(() => {
    if (!focusPath) return;
    const idx = flatRows.findIndex((r) => r.node.path === focusPath);
    if (idx >= 0) rowVirtualizer.scrollToIndex(idx, { align: 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPath, focusAncestors]);

  // 键盘 ↑↓ 的焦点搬运：目标行可能还在虚拟窗口外，scrollToIndex 触发的
  // re-render 挂载后才能 focus —— pending 队列在每次渲染后补刀，找到即清。
  const pendingFocusPath = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingFocusPath.current) return;
    const el = rowEls.current.get(pendingFocusPath.current);
    if (el) {
      el.focus();
      pendingFocusPath.current = null;
    }
  });

  /** 键盘 ↑↓ 跨行导航（规格 §5）：滚动 → 选中 → 聚焦目标行。越界即 no-op。 */
  const moveRowFocus = (idx: number) => {
    if (idx < 0 || idx >= flatRows.length) return;
    rowVirtualizer.scrollToIndex(idx, { align: 'auto' });
    const target = flatRows[idx];
    onSelect(target.node.path);
    pendingFocusPath.current = target.node.path;
  };

  const registerEl = (p: string, el: HTMLDivElement | null) => {
    if (el) rowEls.current.set(p, el);
    else rowEls.current.delete(p);
  };

  // ── 右键「进回收站（可还原）」（上游 #22①）──────────────────────────
  // 两步确认纪律与 TriageView 一键清扫同款：首点进入预备态，5 秒内再点才执行，
  // 超时自动复位。禁 window.confirm（Tauri webview 里行为不稳定）。
  const [recycleTarget, setRecycleTarget] = useState<Node | null>(null);
  const [recycleArmed, setRecycleArmed] = useState(false);
  const [recycleBusy, setRecycleBusy] = useState(false);
  const [recycleErr, setRecycleErr] = useState<string | null>(null);
  const [recycleDone, setRecycleDone] = useState(false);
  const recycleArmTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (recycleArmTimer.current !== null) window.clearTimeout(recycleArmTimer.current);
  }, []);

  const openRecycleConfirm = (node: Node) => {
    setRecycleTarget(node);
    setRecycleArmed(false);
    setRecycleBusy(false);
    setRecycleErr(null);
    setRecycleDone(false);
  };

  const closeRecycleConfirm = () => {
    if (recycleBusy) return;
    if (recycleArmTimer.current !== null) {
      window.clearTimeout(recycleArmTimer.current);
      recycleArmTimer.current = null;
    }
    setRecycleTarget(null);
    setRecycleArmed(false);
  };

  const confirmRecycle = async () => {
    if (!recycleTarget) return;
    if (!recycleArmed) {
      setRecycleErr(null);
      setRecycleArmed(true);
      if (recycleArmTimer.current !== null) window.clearTimeout(recycleArmTimer.current);
      recycleArmTimer.current = window.setTimeout(() => {
        recycleArmTimer.current = null;
        setRecycleArmed(false);
      }, 5000);
      return;
    }
    if (recycleArmTimer.current !== null) {
      window.clearTimeout(recycleArmTimer.current);
      recycleArmTimer.current = null;
    }
    setRecycleArmed(false);
    setRecycleBusy(true);
    setRecycleErr(null);
    try {
      await api.execute(
        { action: 'recycle', paths: [recycleTarget.path], reason: '树视图右键：移入回收站（可还原）' },
        false,
      );
      setRecycleDone(true);
    } catch (e) {
      setRecycleErr(String(e));
    } finally {
      setRecycleBusy(false);
    }
  };

  const openCtx = (e: React.MouseEvent, node: Node) => {
    e.preventDefault();
    setCtx({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: '在文件管理器中打开',
          icon: <FolderOpen size={12} />,
          onClick: () => { api.revealInExplorer(node.path).catch(() => { /* path may have been deleted */ }); },
        },
        {
          label: '复制路径',
          icon: <Copy size={12} />,
          onClick: () => { navigator.clipboard?.writeText(node.path).catch(() => { /* ignore */ }); },
        },
        {
          label: '进回收站（可还原）',
          icon: <Recycle size={12} />,
          danger: true,
          onClick: () => openRecycleConfirm(node),
        },
      ],
    });
  };

  return (
    <div className="treeview">
      <div className="tree-headrow">
        <div className="col-name">文件夹</div>
        <div className="col-pct">父级 %</div>
        <div className="col-size">大小</div>
        <div className="col-count">文件数</div>
      </div>
      <div className="tree-body" role="tree" aria-label="目录树" ref={scrollRef}>
        {/* 虚拟 spacer：总高 = 可见行总高（视觉 px 除回 zoom 成逻辑 px），
            行用绝对定位 + translateY 落位，DOM 行数恒定（可视行 + overscan） */}
        <div style={{ height: rowVirtualizer.getTotalSize() / zoom, position: 'relative', width: '100%' }}>
          {rowVirtualizer.getVirtualItems().map((vi) => {
            const row = flatRows[vi.index];
            if (!row) return null;
            return (
              <div
                key={vi.key}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start / zoom}px)` }}
              >
                <TreeRow
                  node={row.node}
                  parentSize={row.parentSize}
                  depth={row.depth}
                  rowIndex={vi.index}
                  open={row.node.is_dir && (row.node.children?.length ?? 0) > 0 && isOpen(row.node.path)}
                  dirty={dirtyPaths[row.node.path] !== undefined}
                  selectedPath={selectedPath}
                  onSelect={onSelect}
                  onCtx={openCtx}
                  onToggle={toggleOpen}
                  onMove={moveRowFocus}
                  registerEl={registerEl}
                  verdicts={verdicts}
                  cleanableUnder={cleanableUnder}
                  focusClean={focusClean}
                />
              </div>
            );
          })}
        </div>
      </div>
      <ContextMenu state={ctx} onClose={() => setCtx(null)} />

      {/* 两步确认小卡（armed 纪律，禁 window.confirm） */}
      {recycleTarget && (
        <div className="modal-bg" onClick={closeRecycleConfirm}>
          <div className="card recycle-confirm" onClick={(e) => e.stopPropagation()}>
            <span className="sec-title">进回收站（可还原）</span>
            <div className="cell">
              <span className="cell-label">目标</span>
              <span className="cell-value path-clip" title={recycleTarget.path}>{recycleTarget.path}</span>
            </div>
            <div className="cell">
              <span className="cell-label">大小</span>
              <span className="cell-value">{formatBytes(recycleTarget.size)}</span>
            </div>
            <p className="muted">
              移入系统回收站，随时可还原。两步确认：第一次点击进入预备态，5 秒内再点才执行。
              树里的条目要等下次扫描后才会消失。
            </p>
            {recycleErr && <div className="error">{recycleErr}</div>}
            {recycleDone ? (
              <button className="btn" onClick={() => setRecycleTarget(null)}>已移入回收站 · 关闭</button>
            ) : (
              <div className="overview-actions">
                <button className="btn" disabled={recycleBusy} onClick={closeRecycleConfirm}>取消</button>
                <button
                  className={'btn danger' + (recycleArmed ? ' armed' : '')}
                  disabled={recycleBusy}
                  title={recycleArmed ? '5 秒内再点一次执行' : '点一次进入预备状态，再点一次才执行'}
                  onClick={confirmRecycle}
                >
                  <Trash2 size={13} /> {recycleArmed ? '再点一次确认移入回收站' : '进回收站（可还原）'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// 图标纪律（redesign-spec 硬约束：一律 Lucide 提取路径，禁手绘 SVG）：
// 原 FolderGlyph/FileGlyph 为手绘 Windows 风格 SVG（#f5c75e/#9c7c2a/#ffd97a/#5b4d57
// 等硬编码色 + 按扩展名着色的装饰性 tint，均未登记 spec §7 豁免清单），已整段移除，
// 改用 docs/_icons.json 的 Lucide 提取路径（folder / folder-open / file），
// 颜色走 currentColor → .tree-row .glyph 的 --fg-muted（spec §1：次级图标色）。

// 占用环：替代旧长条 pct-bar（用户 2026-09-27 拍板）。环 = 进度语义（spec §1 允许清单），
// 永远可见——旧长条填充色 --pink 别名桥在 IDE 色板下解析为白色系，导致只有选中行显形。
function PctRing({ pct }: { pct: number }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <svg className="pct-ring" width="15" height="15" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r={r} fill="none" stroke="var(--border)" strokeWidth="2.5" />
      {clamped > 0 && (
        <circle
          cx="8" cy="8" r={r} fill="none" stroke="var(--accent)" strokeWidth="2.5"
          strokeDasharray={`${(clamped / 100) * c} ${c}`} strokeLinecap="round"
          transform="rotate(-90 8 8)"
        />
      )}
    </svg>
  );
}

// v26.1.4.0 树虚拟滚动：Row 由「自渲染 + 递归子树」改为纯展示行——可见性、
// 层级与行序全部由 TreeView 的扁平行表 + useVirtualizer 决定；本组件只负责
// 一行的渲染与交互（选中/开合/键盘/右键/拖拽），不再挂子节点。
function TreeRow({
  node,
  parentSize,
  depth,
  rowIndex,
  open,
  dirty = false,
  selectedPath,
  onSelect,
  onCtx,
  onToggle,
  onMove,
  registerEl,
  verdicts,
  cleanableUnder,
  focusClean,
}: {
  node: Node;
  parentSize: number;
  depth: number;
  /** 在可见行扁平表中的下标：↑↓ 跨行导航用它找相邻行 */
  rowIndex: number;
  /** 有效开合态（collapsedOverrides > expanded > focus 链，TreeView 算好传入） */
  open: boolean;
  /** 实时监控脏标记（本会话收到过该目录的增量变更） */
  dirty?: boolean;
  selectedPath: string | null;
  onSelect: (p: string) => void;
  onCtx: (e: React.MouseEvent, node: Node) => void;
  onToggle: (p: string) => void;
  onMove: (idx: number) => void;
  registerEl: (p: string, el: HTMLDivElement | null) => void;
  verdicts?: Map<string, VerdictEntry>;
  cleanableUnder?: Map<string, number>;
  focusClean?: boolean;
}) {
  const hasKids = (node.children?.length ?? 0) > 0;
  const sel = node.path === selectedPath;
  const pct = parentSize > 0 ? (node.size / parentSize) * 100 : 0;
  const entry = verdicts?.get(node.path) ?? null;
  // 「只看可清理」聚焦（spec §2.1.2）：树行与图块同一份判定语义（§4 三处一致）。
  // safe 行与子树内含可清理的祖先行保持可见，其余淡显；选中行豁免（淡显会吞掉
  // .selected 高亮，选中上下文优先）。
  const dimmed =
    !!focusClean && !sel && isFocusDimmed(entry, cleanableUnder?.get(node.path) ?? 0);

  return (
    <div
      ref={(el) => registerEl(node.path, el)}
      className={
        'tree-row' + (sel ? ' selected' : '') + (node.is_dir ? '' : ' is-file') +
        (entry ? ` verdict-${entry.verdict}` : '') + (dimmed ? ' focus-dim' : '')
      }
      // f1-2：键盘可达——tab 聚焦（:focus-visible 全站规则自动给描边）、
      // Enter/空格选中、→/← 展开/收起、↑/↓ 跨行导航（虚拟滚动规格 §5）、
      // Menu 键开右键菜单（坐标取行元素）。
      tabIndex={0}
      role="treeitem"
      aria-expanded={node.is_dir && hasKids ? open : undefined}
      aria-level={depth + 1}
      onClick={() => onSelect(node.path)}
      onContextMenu={(e) => onCtx(e, node)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(node.path);
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          onMove(rowIndex + 1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          onMove(rowIndex - 1);
        } else if (e.key === 'ArrowRight' && hasKids && !open) {
          e.preventDefault();
          onToggle(node.path);
        } else if (e.key === 'ArrowLeft' && hasKids && open) {
          e.preventDefault();
          onToggle(node.path);
        } else if (e.key === 'ContextMenu') {
          e.preventDefault();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          onCtx({
            clientX: r.left + 8,
            clientY: r.bottom,
            preventDefault() {},
          } as unknown as React.MouseEvent, node);
        }
      }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-pinkbin-path', node.path);
        e.dataTransfer.setData('application/x-pinkbin-name', node.name);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      title={node.path + '  ·  右键查看选项'}
    >
      <div className="col-name" style={{ paddingLeft: 20 + depth * 14 }}>
        <span
          className="caret"
          aria-hidden
          onClick={(e) => { e.stopPropagation(); if (hasKids) onToggle(node.path); }}
        >
          {hasKids
            ? (open ? <ChevronDown size={11} /> : <ChevronRight size={11} />)
            : <span className="caret-stub" />}
        </span>
        <span className="glyph">
          <Icon name={node.is_dir ? (open ? 'folder-open' : 'folder') : 'file'} size={14} />
        </span>
        <span className="name">{node.name || node.path}</span>
        {dirty && <span className="tree-dirty-dot" title="实时监控：此目录刚发生变更（数值已增量更新）" />}
        {node.scaffold_id && <span className="badge">{node.scaffold_id}</span>}
      </div>
      <div className="col-pct">
        <PctRing pct={pct} />
        {/* f1-4：与 PctRing 同一钳制口径——环封顶 100%，文本不再显示 137.4% */}
        <span className="pct-num">{Math.min(100, Math.max(0, pct)).toFixed(1)}%</span>
      </div>
      <div className="col-size">{formatBytes(node.size)}</div>
      <div className="col-count">{formatCount(node.file_count)}</div>
    </div>
  );
}
