import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, ChevronDown, FolderOpen, Copy, Trash2, Recycle } from 'lucide-react';
import type { Node } from '../types';
import { formatBytes, formatCount } from '../format';
import { api } from '../api';
import { ContextMenu, type ContextMenuState } from './ContextMenu';
import { Icon } from './Icon';
import type { VerdictEntry } from '../triage-cache';

type Props = {
  root: Node;
  selectedPath: string | null;
  onSelect: (p: string) => void;
  /** 双向同步导航（sync-nav）：外部聚焦路径（空间图下钻/面包屑返回）。
   *  变化时祖先链全部自动展开 + scrollIntoView；不在扫描根子树内则不动。 */
  focusPath?: string | null;
  /** 分诊图层 O1（triage-overlay-spec §4）：有判定的行加左缘 3px 同色条 */
  verdicts?: Map<string, VerdictEntry>;
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

export function TreeView({ root, selectedPath, onSelect, focusPath, verdicts }: Props) {
  const [ctx, setCtx] = useState<ContextMenuState | null>(null);

  // ── 受控展开（sync-nav：Row 的 open 状态提升到这里）──────────────────
  // key=目录 path。初值 = 仅根展开（等价旧 initialOpen）。新扫描（root 变化）
  // 在渲染期重置（React「props 变化时调整状态」范式，避免旧键残留/首帧塌缩）。
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => ({ [root.path]: true }));
  const [prevRoot, setPrevRoot] = useState(root);
  // focus 链手动收起覆盖：focusAncestors 会把链上目录强制顶在展开态，用户点
  // chevron 收起时改 expanded[p] 也会被 includes(p) 盖回去（收不起来的根因）。
  // 这个集合显式记录「用户要它合上」，在 isOpen 里判定优先级最高。
  const [collapsedOverrides, setCollapsedOverrides] = useState<Set<string>>(() => new Set());
  const [prevFocusPath, setPrevFocusPath] = useState(focusPath);
  // 行元素注册表：path → DOM，供 focusPath 滚动定位用
  const rowEls = useRef<Map<string, HTMLDivElement>>(new Map());
  if (prevRoot !== root) {
    setPrevRoot(root);
    setExpanded({ [root.path]: true });
    setCollapsedOverrides(new Set()); // 新扫描 = 新树，旧链的收起意图一并作废
    rowEls.current.clear();
  }
  if (prevFocusPath !== focusPath) {
    // focusPath 换目标：旧链的收起覆盖全部作废，新链回到默认强制展开
    setPrevFocusPath(focusPath);
    setCollapsedOverrides(new Set());
  }

  // focusPath 的祖先链（root → … → 父目录），渲染期派生：行可见性直接吃它，
  // 展开在本次 commit 就生效，滚动 effect 拿到的 DOM 一定是最新布局。
  const focusAncestors = useMemo<string[] | null>(() => {
    if (!focusPath) return null;
    const chain = chainTo(root, focusPath);
    if (!chain) return null; // 不在扫描根子树内（跨盘等）：不动
    return chain.slice(0, -1).map((a) => a.path);
  }, [focusPath, root]);

  // 滚动定位：focusPath/祖先链变化后的那次 commit 里执行（行已渲染，元素可查）
  useEffect(() => {
    if (!focusPath) return;
    rowEls.current.get(focusPath)?.scrollIntoView({ block: 'nearest' });
  }, [focusPath, focusAncestors]);

  const registerEl = (p: string, el: HTMLDivElement | null) => {
    if (el) rowEls.current.set(p, el);
    else rowEls.current.delete(p);
  };
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
    setExpanded((m) => ({ ...m, [p]: !m[p] }));
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
      <div className="tree-body">
        <Row
          node={root}
          parentSize={root.size || 1}
          depth={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onCtx={openCtx}
          isOpen={isOpen}
          onToggle={toggleOpen}
          registerEl={registerEl}
          verdicts={verdicts}
        />
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
// 永远可见——旧长条填充色 --pink 别名桥在 Trae 色板下解析为白色系，导致只有选中行显形。
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

function Row({
  node,
  parentSize,
  depth,
  selectedPath,
  onSelect,
  onCtx,
  isOpen,
  onToggle,
  registerEl,
  verdicts,
}: {
  node: Node;
  parentSize: number;
  depth: number;
  selectedPath: string | null;
  onSelect: (p: string) => void;
  onCtx: (e: React.MouseEvent, node: Node) => void;
  /** open 状态由 TreeView 受控（sync-nav：支持外部 focusPath 展开祖先链） */
  isOpen: (p: string) => boolean;
  onToggle: (p: string) => void;
  registerEl: (p: string, el: HTMLDivElement | null) => void;
  verdicts?: Map<string, VerdictEntry>;
}) {
  const open = isOpen(node.path);
  const hasKids = (node.children?.length ?? 0) > 0;
  const sel = node.path === selectedPath;
  const pct = parentSize > 0 ? (node.size / parentSize) * 100 : 0;
  const entry = verdicts?.get(node.path) ?? null;

  return (
    <>
      <div
        ref={(el) => registerEl(node.path, el)}
        className={
          'tree-row' + (sel ? ' selected' : '') + (node.is_dir ? '' : ' is-file') +
          (entry ? ` verdict-${entry.verdict}` : '')
        }
        onClick={() => onSelect(node.path)}
        onContextMenu={(e) => onCtx(e, node)}
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
          {node.scaffold_id && <span className="badge">{node.scaffold_id}</span>}
        </div>
        <div className="col-pct">
          <PctRing pct={pct} />
          <span className="pct-num">{pct.toFixed(1)}%</span>
        </div>
        <div className="col-size">{formatBytes(node.size)}</div>
        <div className="col-count">{formatCount(node.file_count)}</div>
      </div>
      {open && hasKids && node.children.slice(0, 500).map((c) => (
        <Row
          key={c.path}
          node={c}
          parentSize={node.size || 1}
          depth={depth + 1}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onCtx={onCtx}
          isOpen={isOpen}
          onToggle={onToggle}
          registerEl={registerEl}
          verdicts={verdicts}
        />
      ))}
    </>
  );
}
