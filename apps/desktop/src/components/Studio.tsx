import { useMemo, useState } from 'react';
import { ChevronRight, ChevronDown, Sparkles, MessageSquare, Trash2, FolderOpen, Copy, ExternalLink, Gamepad2, Power, Download, FileUp } from 'lucide-react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { useStore } from '../store';
import { formatBytes } from '../format';
import { api } from '../api';
import { isTauri } from '../env';
import type { Node, Scaffold } from '../types';
import { ErrorBoundary } from './ErrorBoundary';
import { ContextMenu, type ContextMenuState } from './ContextMenu';
import { CleanupModal } from './CleanupModal';
import { SteamInspectorModal } from './SteamInspectorModal';
import { Icon } from './Icon';

export const FEATURED_IDS = [
  'wechat-pc',
  'conda',
];

/// Collect every top-level node tagged with `scaffoldId`. We deliberately
/// don't recurse into a subtree that already matched — a single scaffold
/// rarely re-tags itself deeper, and skipping the descent keeps walks under
/// each match disjoint so scope_sizes aggregation can't double-count the
/// same files.
export function findAllMatchesByScaffold(root: Node | null, scaffoldId: string): Node[] {
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

export function fallbackByNameContains(root: Node | null, sc: Scaffold): Node | null {
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

export interface CardData {
  scaffold: Scaffold;
  matches: Node[];
  totalSize: number;
  totalFiles: number;
}

/// 检测态聚合（Studio 拆解时抽出，逻辑不动）：编辑区大卡片与侧栏精简列表
/// 共用这一份检测/排序/合计逻辑，避免两处各算各的出现口径不一致。
export function buildScaffoldCards(root: Node | null, scaffolds: Scaffold[]): CardData[] {
  const items: CardData[] = scaffolds.map((sc) => {
    let matches = findAllMatchesByScaffold(root, sc.id);
    if (matches.length === 0) {
      const fb = fallbackByNameContains(root, sc);
      if (fb) matches = [fb];
    }
    matches.sort((a, b) => b.size - a.size);
    const totalSize = matches.reduce((s, m) => s + m.size, 0);
    const totalFiles = matches.reduce((s, m) => s + m.file_count, 0);
    return { scaffold: sc, matches, totalSize, totalFiles };
  });
  items.sort((a, b) => {
    const aDet = a.matches.length > 0;
    const bDet = b.matches.length > 0;
    if (aDet && !bDet) return -1;
    if (!aDet && bDet) return 1;
    if (aDet && bDet) return b.totalSize - a.totalSize;
    return a.scaffold.name.localeCompare(b.scaffold.name);
  });
  return items;
}

/// 启停落地：scaffold_set_enabled → 重拉 list_scaffolds（后端滤掉停用项后的
/// 生效名单）→ 按「id 是否还在名单里」的实测结果更新前端启停留档，而不是
/// 想当然写本地：预览模式两个命令都 no-op、名单里仍有该 id，这里自然退化为
/// 无操作；桌面模式名单为准，localStorage 只负责停用对象的可视留档。
export async function applyScaffoldEnabled(sc: Scaffold, enabled: boolean): Promise<void> {
  await api.scaffoldSetEnabled(sc.id, enabled);
  const st = useStore.getState();
  const list = await api.listScaffolds().catch(() => st.scaffolds);
  st.setScaffolds(list);
  const rest = st.disabledScaffolds.filter((d) => d.id !== sc.id);
  st.setDisabledScaffolds(list.some((s) => s.id === sc.id) ? rest : [...rest, sc]);
}

export function Studio({ focusId }: { focusId?: string }) {
  const root = useStore((s) => s.root);
  const scaffolds = useStore((s) => s.scaffolds);
  const disabledScaffolds = useStore((s) => s.disabledScaffolds);
  const requestStudio = useStore((s) => s.requestStudio);

  // v2（spec §4 脚本详情 tab）：focusId = 从侧栏脚本卡片点进来的脚手架 id，
  // 该卡片初始即展开（检测详情 / CleanupModal 入口都还在卡片里，逻辑不动）。
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(focusId ? [focusId] : []));
  const [openTool, setOpenTool] = useState<null | 'steam-inspector'>(null);
  // 导入/导出/启停的结果回显（Studio 内局部提示，不进底面板输出）
  const [opMsg, setOpMsg] = useState<string | null>(null);

  const hidden = (() => {
    try { return localStorage.getItem('pinkbin.hideStudio') === '1'; } catch { return false; }
  })();

  const allCards: CardData[] = useMemo(
    () => (hidden ? [] : buildScaffoldCards(root, scaffolds)),
    [root, scaffolds, hidden],
  );

  // 启停期间本地留档可能与生效名单短暂重叠（预览模式 list 恒含全部 id）：
  // 以生效名单为准，已在名单里的不再重复渲染灰色卡。
  const disabledCards = useMemo(
    () => disabledScaffolds.filter((d) => !allCards.some((c) => c.scaffold.id === d.id)),
    [disabledScaffolds, allCards],
  );

  if (hidden) {
    return (
      <div className="studio">
        <div className="studio-head">
          <span>Studio</span>
          <span className="muted small">已隐藏（pinkbin.hideStudio=1）</span>
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

  const toggleEnabled = (sc: Scaffold, enabled: boolean) => {
    setOpMsg(null);
    applyScaffoldEnabled(sc, enabled)
      .then(() => {
        // 以生效名单实测结果回显：预览模式 no-op 后名单不变，如实说明
        const inList = useStore.getState().scaffolds.some((s) => s.id === sc.id);
        if (inList !== enabled) {
          setOpMsg('浏览器预览模式无后端，启停不生效——请在桌面应用中使用');
          return;
        }
        setOpMsg(enabled
          ? `已启用「${sc.name}」，下次扫描起参与检测`
          : `已停用「${sc.name}」，不再参与扫描与检测`);
      })
      .catch((e) => setOpMsg(`${enabled ? '启用' : '停用'}失败：${String(e)}`));
  };

  const exportScaffold = async (sc: Scaffold) => {
    setOpMsg(null);
    if (!isTauri) {
      setOpMsg('浏览器预览模式不支持导出，请在桌面应用中使用');
      return;
    }
    try {
      const toml = await api.scaffoldExport(sc.id);
      const path = await save({
        defaultPath: `${sc.id}.toml`,
        filters: [{ name: 'TOML', extensions: ['toml'] }],
      });
      if (!path) return;
      await writeTextFile(path, toml);
      setOpMsg(`已导出 ${sc.id}.toml`);
    } catch (e) {
      setOpMsg(`导出失败：${String(e)}`);
    }
  };

  const importScaffold = async () => {
    setOpMsg(null);
    if (!isTauri) {
      setOpMsg('浏览器预览模式不支持导入，请在桌面应用中使用');
      return;
    }
    try {
      const picked = await open({
        multiple: false,
        filters: [{ name: 'TOML', extensions: ['toml'] }],
      });
      if (typeof picked !== 'string') return;
      const toml = await readTextFile(picked);
      const id = await api.scaffoldImport(toml);
      const st = useStore.getState();
      const list = await api.listScaffolds().catch(() => st.scaffolds);
      st.setScaffolds(list);
      const imported = list.find((s) => s.id === id);
      const rest = st.disabledScaffolds.filter((d) => d.id !== id);
      if (imported) {
        st.setDisabledScaffolds(rest);
        setOpMsg(`已导入「${imported.name}」（${id}）`);
      } else {
        // 导入同名 id 但它躺在后端停用名单里：scaffold_import 不动名单，
        // 留档里也没有它的完整对象，如实提示去名单里启用。
        setOpMsg(`已导入 ${id}，但它在停用名单里——在下方「已停用」区启用后才会显示`);
      }
    } catch (e) {
      setOpMsg(`导入失败：${String(e)}`);
    }
  };

  return (
    <div className="studio">
      <div className="studio-head">
        <span>Studio</span>
        <span className="muted small">
          {allCards.length} 个脚本{disabledCards.length > 0 ? ` · 停用 ${disabledCards.length}` : ''}
        </span>
        <span className="studio-head-actions">
          <button
            className="ghost studio-import-btn"
            onClick={() => void importScaffold()}
            title="从 .toml 文件导入清理脚本（后端会校验红线与 scope）"
          >
            <FileUp size={12} /> 导入 TOML
          </button>
        </span>
      </div>
      {opMsg && <div className="studio-op-msg">{opMsg}</div>}

      <div className="studio-section-label">推荐</div>
      <div className="studio-grid">
        <ErrorBoundary fallbackLabel="Steam Inspector 卡片渲染失败">
          <ToolCard
            icon={<Gamepad2 size={14} />}
            name="Steam Inspector"
            blurb="哪些游戏好久没玩 · 一键唤起 Steam 卸载"
            onClick={() => setOpenTool('steam-inspector')}
          />
        </ErrorBoundary>
        {featured.map((c) => (
          <ErrorBoundary key={c.scaffold.id} fallbackLabel={`${c.scaffold.name} 卡片渲染失败`}>
            <Card
              card={c}
              expanded={expanded.has(c.scaffold.id)}
              onToggle={() => toggle(c.scaffold.id)}
              onAsk={() => requestStudio(c.scaffold.id)}
              onDisable={() => toggleEnabled(c.scaffold, false)}
              onExport={() => void exportScaffold(c.scaffold)}
            />
          </ErrorBoundary>
        ))}
      </div>

      {others.length > 0 && (
        <>
          <div className="studio-section-label">更多</div>
          <div className="studio-grid">
            {others.map((c) => (
              <ErrorBoundary key={c.scaffold.id} fallbackLabel={`${c.scaffold.name} 卡片渲染失败`}>
                <Card
                  card={c}
                  expanded={expanded.has(c.scaffold.id)}
                  onToggle={() => toggle(c.scaffold.id)}
                  onAsk={() => requestStudio(c.scaffold.id)}
                  onDisable={() => toggleEnabled(c.scaffold, false)}
                  onExport={() => void exportScaffold(c.scaffold)}
                />
              </ErrorBoundary>
            ))}
          </div>
        </>
      )}

      {disabledCards.length > 0 && (
        <>
          <div className="studio-section-label">已停用 · 不参与扫描</div>
          <div className="studio-grid">
            {disabledCards.map((d) => (
              <DisabledCard
                key={d.id}
                sc={d}
                onEnable={() => toggleEnabled(d, true)}
                onExport={() => void exportScaffold(d)}
              />
            ))}
          </div>
        </>
      )}

      {openTool === 'steam-inspector' && (
        <SteamInspectorModal onClose={() => setOpenTool(null)} />
      )}
    </div>
  );
}

/// Tool cards live in Studio alongside scaffold cards but behave differently:
/// no inline expansion, no "X 个位置" detection meta — just a card-shaped
/// entry point that opens a dedicated modal. Steam Inspector is the first
/// tool; future "always-on" panels (Epic / GOG inspectors, library reports)
/// can reuse this shape.
function ToolCard({
  icon,
  name,
  blurb,
  onClick,
}: {
  icon: React.ReactNode;
  name: string;
  blurb: string;
  onClick: () => void;
}) {
  return (
    <div className="studio-card-wrap risk-low tool-card-wrap">
      <button className="studio-card tool-card" onClick={onClick} title={blurb}>
        <ExternalLink size={12} className="studio-caret tool-card-arrow" />
        <div className="studio-card-icon tool-card-icon">{icon}</div>
        <div className="studio-card-body">
          <div className="studio-card-name">{name}</div>
          <div className="studio-card-meta">{blurb}</div>
        </div>
      </button>
    </div>
  );
}

function Card({
  card, expanded, onToggle, onAsk, onDisable, onExport,
}: {
  card: CardData;
  expanded: boolean;
  onToggle: () => void;
  onAsk: () => void;
  onDisable: () => void;
  onExport: () => void;
}) {
  const sc = card.scaffold;
  const matches = card.matches;
  const detected = matches.length > 0;
  const Caret = expanded ? ChevronDown : ChevronRight;
  const addReclaimed = useStore((s) => s.addReclaimed);

  const [showCleanup, setShowCleanup] = useState(false);
  const [showAllChildren, setShowAllChildren] = useState(false);
  const [ctx, setCtx] = useState<ContextMenuState | null>(null);

  const openCtx = (e: React.MouseEvent, p: string) => {
    e.preventDefault();
    setCtx({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: '在文件管理器中打开',
          icon: <FolderOpen size={12} />,
          onClick: () => { api.revealInExplorer(p).catch(() => { /* path may have been deleted */ }); },
        },
        {
          label: '复制路径',
          icon: <Copy size={12} />,
          onClick: () => { navigator.clipboard?.writeText(p).catch(() => { /* ignore */ }); },
        },
      ],
    });
  };

  const topChildrenAll = (() => {
    const all: Node[] = [];
    for (const m of matches) {
      for (const c of m.children ?? []) all.push(c);
    }
    all.sort((a, b) => b.size - a.size);
    return all.slice(0, 30);
  })();
  const topChildren = showAllChildren ? topChildrenAll : topChildrenAll.slice(0, 3);
  const hiddenChildrenCount = Math.max(0, topChildrenAll.length - topChildren.length);

  return (
    <div className={'studio-card-wrap risk-' + sc.risk + (detected ? ' detected' : '')}>
      <div className="studio-card-topline">
        <button
          className="studio-card"
          onClick={onToggle}
          title={sc.disclaimer}
        >
          <Caret size={14} className="studio-caret" />
          <div className="studio-card-icon"><Icon name="package" size={18} /></div>
          <div className="studio-card-body">
            <div className="studio-card-name">{sc.name}</div>
            <div className="studio-card-meta">
              {detected
                ? <><Sparkles size={10} /> {formatBytes(card.totalSize)}{matches.length > 1 && <> · {matches.length} 个位置</>}</>
                : <>未扫到 · 用脚本默认路径</>}
            </div>
          </div>
        </button>
        <button
          className="studio-card-tool"
          onClick={onDisable}
          title={`停用「${sc.name}」——不再参与扫描与检测，可随时在「已停用」区启用`}
          aria-label={`停用 ${sc.name}`}
        >
          <Power size={13} />
        </button>
      </div>

      {expanded && (
        <div className="studio-card-expanded">
          {detected ? (
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
                        e.dataTransfer.setData('application/x-pinkbin-path', m.path);
                        e.dataTransfer.setData('application/x-pinkbin-name', m.name);
                        e.dataTransfer.effectAllowed = 'copy';
                      }}
                      onContextMenu={(e) => openCtx(e, m.path)}
                      title="拖到中间问 AI · 右键查看选项"
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

              {topChildrenAll.length > 0 && (
                <>
                  <div className="studio-detail-label" style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>占用最大的子项</span>
                    {topChildrenAll.length > 3 && (
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => setShowAllChildren((v) => !v)}
                        style={{ fontSize: 10.5, padding: '0 6px' }}
                      >
                        {showAllChildren
                          ? '收起'
                          : `展开全部（还有 ${hiddenChildrenCount}）`}
                      </button>
                    )}
                  </div>
                  <ul className="studio-children">
                    {topChildren.map((c) => (
                      <li
                        key={c.path}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData('application/x-pinkbin-path', c.path);
                          e.dataTransfer.setData('application/x-pinkbin-name', c.name);
                          e.dataTransfer.effectAllowed = 'copy';
                        }}
                        onContextMenu={(e) => openCtx(e, c.path)}
                        title={c.path + '  ·  右键查看选项'}
                      >
                        <span className="studio-child-name" style={{display:"inline-flex",alignItems:"center",gap:5}}><Icon name={c.is_dir ? 'folder' : 'file'} size={12} /> {c.name}</span>
                        <span className="mono-num">{formatBytes(c.size)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              <div className="studio-card-actions has-export">
                <button
                  className="primary studio-cleanup-btn"
                  onClick={() => setShowCleanup(true)}
                >
                  <Trash2 size={12} /> 配置清理…
                </button>
                <button className="secondary studio-ask-btn" onClick={onAsk}>
                  <MessageSquare size={12} /> 问 AI
                </button>
                <button
                  className="ghost studio-export-btn"
                  onClick={onExport}
                  title={`导出「${sc.name}」的 TOML 到本地文件`}
                >
                  <Download size={12} /> 导出
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="studio-detail-label">脚本默认匹配路径</div>
              <ul className="studio-children muted small">
                {sc.detect.slice(0, 4).map((p) => <li key={p}>{p}</li>)}
              </ul>
              <div className="studio-detail-label" style={{ marginTop: 6 }}>说明</div>
              <p className="muted small" style={{ margin: '4px 0' }}>{sc.disclaimer}</p>
              <button className="primary studio-ask-btn" onClick={onAsk} style={{ marginTop: 6 }}>
                <MessageSquare size={12} /> 问 AI：它一般在哪、能不能删
              </button>
            </>
          )}
        </div>
      )}

      {showCleanup && detected && (
        <CleanupModal
          scaffold={sc}
          matches={matches}
          onClose={() => setShowCleanup(false)}
          onCleaned={(bytes) => addReclaimed(bytes)}
        />
      )}
      <ContextMenu state={ctx} onClose={() => setCtx(null)} />
    </div>
  );
}

/// 停用脚本的灰色卡：list_scaffolds 已把它滤掉（不参与扫描与检测），这里只
/// 依赖本地留档渲染名字与启停操作；检测态一概不显示——停用后前端根本拿不到。
function DisabledCard({ sc, onEnable, onExport }: { sc: Scaffold; onEnable: () => void; onExport: () => void }) {
  return (
    <div className="studio-card-wrap scaffold-disabled">
      <div className="studio-card-topline">
        <div className="studio-card scaffold-disabled-head" title={sc.disclaimer}>
          <div className="studio-card-icon"><Icon name="package" size={18} /></div>
          <div className="studio-card-body">
            <div className="studio-card-name">{sc.name}</div>
            <div className="studio-card-meta">已停用 · 不参与扫描与检测</div>
          </div>
        </div>
      </div>
      <div className="scaffold-disabled-row">
        <button className="ghost" onClick={onEnable} title="重新启用：下次扫描起恢复检测">
          <Power size={12} /> 启用
        </button>
        <button className="ghost" onClick={onExport} title="导出该脚本的 TOML 到本地文件">
          <Download size={12} /> 导出 TOML
        </button>
      </div>
    </div>
  );
}
