import { useEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { api } from './api';
import { isTauri } from './env';
import { buildWalkQueue, useStore, type EditorTab, type TabKind, type WalkItem } from './store';
import type { Triaged } from './triage';
import type { Node, UndoEntry } from './types';
import { TreeView } from './components/TreeView';
import { Studio } from './components/Studio';
import { ChatPanel } from './components/ChatPanel';
import { ScaffoldSideList } from './components/ScaffoldSideList';
import { RecordsView } from './components/RecordsView';
import { Settings } from './components/Settings';
import { Treemap } from './components/Treemap';
import { TriageView } from './components/TriageView';
import { TriageLegend } from './components/TriageLegend';
import { BlockDetailCard } from './components/BlockDetailCard';
import { AutoWalk } from './components/AutoWalk';
import { Splitter } from './components/Splitter';
import { Logo } from './components/Logo';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Icon } from './components/Icon';
import { formatBytes } from './format';
import { loadSettings, isConfigured, ensureApiKey } from './advisorClient';
import { applyCache, parseCache, serializeCache, useVerdicts, type CachedVerdict } from './triage-cache';
import { cacheHitFor, pickAiTriageTargets, runAiTriage, FREE_AI_PATHS } from './triage-ai';

// ═══ pinkbin · workbench v2（redesign-spec v2 §2 五区）══════════════════
// titlebar 35（品牌+呼吸点 · 菜单占位 · 区域三开关 icon-only · 主题切换）
// activitybar 48（explorer/queue/scripts/records + 设置；只切侧栏，编辑器是
//   独立 tab 床，两者零重复；active=左缘 2px accent；点同项=折叠/展开侧栏）
// sidebar 240 可折叠（四面板挂既有组件）· tab 床（store tab 模型驱动）·
// bottompanel 150 可折叠（输出/诊断/记录）· aipanel 300 可折叠（占位，
//   ChatPanel 下一阶段挂）· statusbar 22。
// 扫描全套逻辑/事件监听/诊断、Splitter、ErrorBoundary、Settings 原样保留。
// 图标一律 docs/_icons.json 的 Lucide 提取路径（components/Icon.tsx），禁手绘。

// 版本规则（2026-09-27 用户定）：年份后两位.破坏性+1.新功能+1.补丁+1
// Cargo/tauri 只认三段 semver，第四位补丁段仅在用户可见处展示。
const APP_VERSION = '26.1.3.1';

function isDriveRoot(p: string): boolean {
  // C: / C:\ / C:/  — anything beyond is a subfolder
  return /^[A-Za-z]:[\\/]?$/.test(p);
}

function driveOf(p: string): string {
  return /^[A-Za-z]:/.test(p) ? `${p[0]}:` : p;
}

interface ScanStatsEvent {
  mode: string;
  mft_attempted: boolean;
  mft_succeeded: boolean;
  mft_ms: number;
  walk_ms: number;
  build_tree_ms: number;
  scanner_total_ms: number;
  tag_ms: number;             // post-scan walk: detect_compiled + truncation
  cmd_total_ms: number;
  files_seen: number;
  bytes_seen: number;
  dirs_in_acc: number;
}

interface ScanDiag {
  backend: ScanStatsEvent | null;
  ipcMs: number | null;       // null when backend stats event didn't arrive
  scanCallMs: number;         // total api.scan() round-trip
  setRootMs: number;          // setRoot+select sync work
  totalMs: number;            // entire scan() handler
}

// ── 几何（spec §2：sidebar 240 / aipanel 300 / bottompanel 150，均可拖拽） ──
const DEFAULT_SIDEBAR = 300;
const MIN_SIDEBAR = 280;
const DEFAULT_AI = 340;
const MIN_AI = 280;
const DEFAULT_BOTTOM = 150;
const MIN_BOTTOM = 90;
const MAX_BOTTOM = 420;
const MIN_CENTER = 360;
// f5-0 × f0-2 坐标系统一（独立复核项）：非默认字号档下 .app-v2 带 CSS zoom
// （styles.css：sm 0.88 / lg 1.04 / xl 1.12），侧板宽度状态是 zoom 子树内的
// 逻辑 px，而 window.innerWidth 是视觉像素——侧板钳制（dragSidebar/dragAI/
// clampPanels/初值）必须先把视口换算成逻辑 px，MIN_CENTER=360 的「窄窗不把
// 中央区压成细条」才在所有字号档严格成立（缺省档 zoom=1 无影响）。
const FS_ZOOM: Record<string, number> = { sm: 0.88, lg: 1.04, xl: 1.12 };
const viewportLogical = () =>
  window.innerWidth / (FS_ZOOM[document.documentElement.dataset.fs ?? ''] ?? 1);

// 操作记录筛选（第三波增量，spec §2 侧栏 records 面板 = 筛选分段控件）
const RECORD_ACTIONS: { id: 'all' | UndoEntry['action']; label: string; icon: string }[] = [
  { id: 'all', label: '全部', icon: 'list-checks' },
  { id: 'recycle', label: '回收站', icon: 'trash-2' },
  { id: 'quarantine', label: '隔离', icon: 'archive-restore' },
  { id: 'delete', label: '删除', icon: 'circle-x' },
];
const RECORD_SINCE: { id: number | null; label: string; icon: string }[] = [
  { id: null, label: '全部时间', icon: 'clock' },
  { id: 1, label: '24 小时', icon: 'clock' },
  { id: 7, label: '近 7 天', icon: 'calendar-days' },
  { id: 30, label: '近 30 天', icon: 'calendar-days' },
];

const TAB_ICONS: Record<TabKind, string> = {
  map: 'map',
  walk: 'list-checks',
  script: 'package',
  records: 'history',
};

type SideId = 'explorer' | 'queue' | 'scripts' | 'records';
const SIDE_IDS: SideId[] = ['explorer', 'queue', 'scripts', 'records'];
const SIDE_META: { id: SideId; icon: string; label: string }[] = [
  { id: 'explorer', icon: 'folder-tree', label: '资源管理器' },
  { id: 'queue', icon: 'list-checks', label: '巡查队列' },
  { id: 'scripts', icon: 'package', label: '脚本列表' },
  { id: 'records', icon: 'history', label: '记录筛选' },
];

type BpTab = 'out' | 'diag' | 'records';
type OutLine = { level: 'info' | 'warn' | 'error'; text: string };

export default function App() {
  const root = useStore((s) => s.root);
  const setRoot = useStore((s) => s.setRoot);
  const setScaffolds = useStore((s) => s.setScaffolds);
  const scaffolds = useStore((s) => s.scaffolds);
  const selectedPath = useStore((s) => s.selectedPath);
  const select = useStore((s) => s.selectPath);
  const walkQueue = useStore((s) => s.walkQueue);
  const walkIndex = useStore((s) => s.walkIndex);
  const walkThresholdGB = useStore((s) => s.walkThresholdGB);
  const reclaimedBytes = useStore((s) => s.reclaimedBytes);
  const quarantinedCount = useStore((s) => s.quarantinedCount);
  const setWalk = useStore((s) => s.setWalk);
  const setThreshold = useStore((s) => s.setThreshold);
  // tab 床（spec §3）
  const openTabs = useStore((s) => s.openTabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const openTab = useStore((s) => s.openTab);
  const closeTab = useStore((s) => s.closeTab);
  const activateTab = useStore((s) => s.activateTab);
  const goEntry = useStore((s) => s.goEntry);
  // AI 面板表头「新对话」（square-pen）——与 ChatPanel 内部清空同源
  const resetChat = useStore((s) => s.resetChat);

  // ── 主题（localStorage pinkbin.theme + document 根 .dark class） ──
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    localStorage.getItem('pinkbin.theme') === 'dark' ? 'dark' : 'light',
  );
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('pinkbin.theme', theme);
  }, [theme]);

  // ── 字号档位（spec §1 data-fs：md(默认) → sm → lg → xl 循环，状态栏 A·md） ──
  const [fsTier, setFsTier] = useState<'md' | 'sm' | 'lg' | 'xl'>(() => {
    const v = localStorage.getItem('pinkbin.fs');
    return v === 'sm' || v === 'lg' || v === 'xl' ? v : 'md';
  });
  useEffect(() => {
    if (fsTier === 'md') delete document.documentElement.dataset.fs;
    else document.documentElement.dataset.fs = fsTier;
    localStorage.setItem('pinkbin.fs', fsTier);
  }, [fsTier]);
  const cycleFsTier = () =>
    setFsTier((t) => (t === 'md' ? 'sm' : t === 'sm' ? 'lg' : t === 'lg' ? 'xl' : 'md'));

  // ── 「只看可清理」聚焦模式（triage-overlay-spec §2.1.2，pinkbin.focusClean） ──
  // 状态提升在 App：图例（地图 tab 工具行）与空间图/树视图分处不同子树，经 props
  // 下传；开启后非可清理块/行淡至 12%（判定读 applyCache 合并索引：user-ignored
  // 条目在 applyCache 被跳过、回落规则判定，isFocusDimmed 只读合并结果）。
  const [focusClean, setFocusClean] = useState<boolean>(
    () => localStorage.getItem('pinkbin.focusClean') === '1',
  );
  useEffect(() => {
    localStorage.setItem('pinkbin.focusClean', focusClean ? '1' : '0');
  }, [focusClean]);
  const toggleFocusClean = () => setFocusClean((v) => !v);

  // ── 区域三开关（spec §2：侧栏/底面板/右 AI 面板任意组合，Trae 五态全可达） ──
  const [regions, setRegions] = useState<{ sidebar: boolean; bottom: boolean; ai: boolean }>(() => {
    try {
      const raw = localStorage.getItem('pinkbin.regions');
      if (raw) {
        const r = JSON.parse(raw) as { sidebar?: boolean; bottom?: boolean; ai?: boolean };
        return { sidebar: r.sidebar !== false, bottom: r.bottom !== false, ai: r.ai !== false };
      }
    } catch { /* 忽略持久化读取失败 */ }
    return { sidebar: true, bottom: true, ai: true };
  });
  useEffect(() => {
    localStorage.setItem('pinkbin.regions', JSON.stringify(regions));
  }, [regions]);
  const toggleRegion = (k: 'sidebar' | 'bottom' | 'ai') =>
    setRegions((r) => ({ ...r, [k]: !r[k] }));

  // ── 活动栏（只切侧栏；点同项=折叠/展开侧栏） ──
  const [activeSide, setActiveSide] = useState<SideId>(() => {
    const v = localStorage.getItem('pinkbin.side') as SideId | null;
    return v && (SIDE_IDS as string[]).includes(v) ? v : 'explorer';
  });
  useEffect(() => { localStorage.setItem('pinkbin.side', activeSide); }, [activeSide]);
  const clickAct = (side: SideId) => {
    if (activeSide === side) {
      toggleRegion('sidebar');
    } else {
      setActiveSide(side);
      setRegions((r) => (r.sidebar ? r : { ...r, sidebar: true }));
    }
  };

  // ── 区域几何（Splitter 拖拽 + 双击重置；持久化键为 v2 新键） ──
  const [sidebarW, setSidebarW] = useState<number>(() => {
    const v = Number(localStorage.getItem('pinkbin.sidebarW'));
    const raw = Number.isFinite(v) && v >= MIN_SIDEBAR ? v : DEFAULT_SIDEBAR;
    // f0-2：历史持久值可能比当前窗口宽——同 resize 钳制（留出 AI 侧板最小宽），
    // 逻辑视口换算见 viewportLogical。
    const budget = Math.max(MIN_SIDEBAR, viewportLogical() - 48 - 8 - MIN_CENTER);
    return Math.min(raw, Math.max(MIN_SIDEBAR, budget - MIN_AI));
  });
  const [aiW, setAiW] = useState<number>(() => {
    const v = Number(localStorage.getItem('pinkbin.aiW'));
    const raw = Number.isFinite(v) && v >= MIN_AI ? v : DEFAULT_AI;
    const budget = Math.max(MIN_AI, viewportLogical() - 48 - 8 - MIN_CENTER);
    return Math.min(raw, Math.max(MIN_AI, budget - MIN_SIDEBAR));
  });
  const [bottomH, setBottomH] = useState<number>(() => {
    const v = Number(localStorage.getItem('pinkbin.bottomH'));
    return Number.isFinite(v) && v >= MIN_BOTTOM && v <= MAX_BOTTOM ? v : DEFAULT_BOTTOM;
  });
  useEffect(() => { localStorage.setItem('pinkbin.sidebarW', String(sidebarW)); }, [sidebarW]);
  useEffect(() => { localStorage.setItem('pinkbin.aiW', String(aiW)); }, [aiW]);
  useEffect(() => { localStorage.setItem('pinkbin.bottomH', String(bottomH)); }, [bottomH]);
  // f0-2：窄窗约束——侧板是固定宽，窗口缩窄后会把中央 treemap 压扁。两侧板
  // 共享 budget = winW - 48(活动栏) - 8(splitter) - MIN_CENTER，只缩不放大；
  // 各自给对方留最小宽度。localStorage 初值（懒初始化）走同一钳制。
  useEffect(() => {
    const clampPanels = () => {
      const budget = Math.max(MIN_SIDEBAR, viewportLogical() - 48 - 8 - MIN_CENTER);
      setSidebarW((w) => Math.min(w, Math.max(MIN_SIDEBAR, budget - (regions.ai ? MIN_AI : 0))));
      setAiW((w) => Math.min(w, Math.max(MIN_AI, budget - (regions.sidebar ? MIN_SIDEBAR : 0))));
    };
    window.addEventListener('resize', clampPanels);
    return () => window.removeEventListener('resize', clampPanels);
    // f5-0：字号档位切换改变 zoom 但不触发 resize——fsTier 入 deps 让换档
    // 后立即按新逻辑视口重钳（dataset.fs 由前面的 effect 先行更新）。
  }, [regions.ai, regions.sidebar, fsTier]);
  const dragSidebar = (dx: number) => {
    setSidebarW((w) => {
      // f5-0 × f0-2：逻辑视口（见 viewportLogical 注释）
      const winW = viewportLogical();
      // f5-1：others 补 +8（两条 splitter 宽度），与 dragAI 口径对称——
      // 缺 8px 时侧栏可比理论最大值多占 8px，挤压中央区。
      const others = 48 + (regions.ai ? aiW : 0) + 8;
      const maxSide = Math.max(MIN_SIDEBAR, winW - others - MIN_CENTER);
      return Math.max(MIN_SIDEBAR, Math.min(maxSide, w + dx));
    });
  };
  const dragAI = (dx: number) => {
    setAiW((w) => {
      const winW = viewportLogical();
      const others = 48 + (regions.sidebar ? sidebarW : 0) + 8 /* 两条 splitter */;
      const maxAi = Math.max(MIN_AI, winW - others - MIN_CENTER);
      return Math.max(MIN_AI, Math.min(maxAi, w - dx));
    });
  };
  const dragBottom = (dy: number) => {
    // 上拖（dy<0）增高
    setBottomH((h) => Math.max(MIN_BOTTOM, Math.min(MAX_BOTTOM, h - dy)));
  };

  // ── 底面板 tab（输出/诊断/记录） ──
  const [bpTab, setBpTab] = useState<BpTab>('out');
  const [outLines, setOutLines] = useState<OutLine[]>([
    { level: 'info', text: '就绪。选择磁盘并点「扫描」；扫描时这里会显示进度。' },
  ]);
  const pushOut = (level: OutLine['level'], text: string) =>
    setOutLines((ls) => [...ls.slice(-199), { level, text }]);

  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ files: number; bytes: number; path: string } | null>(null);
  const [scanTotalBytes, setScanTotalBytes] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pickedPath, setPickedPath] = useState<string>('');
  const [showSettings, setShowSettings] = useState(false);
  const [advisorTag, setAdvisorTag] = useState<{ provider: string } | null>(null);
  const [diag, setDiag] = useState<ScanDiag | null>(null);
  // Holds the latest scan-stats event so we can merge it into ScanDiag once
  // api.scan() returns. Tauri emits the event right before the command resolves.
  const lastBackendStats = useRef(null as ScanStatsEvent | null);

  const refreshAdvisorTag = () => {
    const s = loadSettings();
    setAdvisorTag(isConfigured(s) ? { provider: s.provider } : null);
    // 启动/配置变化即把 DPAPI 里的 key 预热进内存，之后 freeChat 免去首聊解密等待。
    void ensureApiKey(s);
  };
  useEffect(() => { refreshAdvisorTag(); }, []);

  // 脚本库装载（此前 listScaffolds 从未被调用，能力恢复；状态栏「脚本数」依赖它）
  useEffect(() => {
    api.listScaffolds()
      .then((scs) => {
        setScaffolds(scs);
        // 启停留档对账：本地留档里已回到生效名单的 id（比如在配置文件里手工
        // 启用过）从留档剔除，剩下的才是真正仍停用的。
        const enabledIds = new Set(scs.map((s) => s.id));
        const st = useStore.getState();
        const stillDisabled = st.disabledScaffolds.filter((d) => !enabledIds.has(d.id));
        if (stillDisabled.length !== st.disabledScaffolds.length) {
          st.setDisabledScaffolds(stillDisabled);
        }
        pushOut('info', `脚本库已加载：${scs.length} 个清理脚本${stillDisabled.length ? ` · 另有 ${stillDisabled.length} 个已停用` : ''}`);
      })
      .catch(() => pushOut('warn', '脚本库加载失败（可稍后重扫）'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 空间图 tab 的 Treemap 需要实测容器尺寸（窗口/分栏/区域折叠都会经过 ResizeObserver）
  const activeTab = activeTabId ? (openTabs.find((t) => t.id === activeTabId) ?? null) : null;
  const treemapWrapRef = useRef<HTMLDivElement | null>(null);
  const [treemapSize, setTreemapSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (activeTab?.kind !== 'map') return;
    const el = treemapWrapRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      // 恒等守卫：尺寸没变就不 setState，杜绝 ResizeObserver→重渲染→布局微变→再触发的回流循环
      setTreemapSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id, activeTab?.kind, root]);

  // 空间图下钻：每个 map tab 各自的 treemap 根（点目录块/面包屑切换）；新扫描重置
  const [mapRoots, setMapRoots] = useState<Record<string, Node>>({});
  useEffect(() => { setMapRoots({}); }, [root]);
  const findNodeByPath = (n: Node | null, p: string): Node | null => {
    if (!n || n.path === p) return n;
    for (const c of n.children) {
      const f = findNodeByPath(c, p);
      if (f) return f;
    }
    return null;
  };

  // ── 双向同步导航（sync-nav）────────────────────────────────────────
  // ①③ 空间图 → 资源管理器：drillTo（点目录块下钻/面包屑返回）时记录聚焦路径，
  // TreeView 据此自动展开祖先链 + scrollIntoView。
  const [treeFocusPath, setTreeFocusPath] = useState<string | null>(null);
  useEffect(() => { setTreeFocusPath(null); }, [root]); // 新扫描：旧聚焦路径失效

  // ② 资源管理器 → 空间图：map tab 激活时，TreeView 选中目录 300ms 防抖后下钻。
  // 防抖回调读「最新」tab/roots（300ms 内用户可能已切 tab/再选），经 ref 取现值。
  const navRef = useRef({ activeTabId, openTabs, mapRoots, root });
  navRef.current = { activeTabId, openTabs, mapRoots, root };
  const mapFollowTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (mapFollowTimer.current !== null) window.clearTimeout(mapFollowTimer.current);
  }, []);

  const drillTo = (tabId: string, n: Node) => {
    select(n.path);
    // 换根判定用 is_dir 而非 children?.length：空目录（mock 的 ProgramData/
    // Eastmoney 叶子、真实扫描里的空文件夹）也是合法图根——按 children 判会
    // 跳过 setMapRoots，表现为「选中态变了、图停在上一个根」（2d-19 残留）。
    // 文件仍不换根（is_dir=false），只同步选中与树聚焦。
    if (n.is_dir) setMapRoots((m) => ({ ...m, [tabId]: n }));
    setTreeFocusPath(n.path); // 资源管理器跟随：展开祖先链并滚动定位
  };

  // TreeView 专用选中：普通选中之外，若活动 tab 是空间图，300ms 防抖后自动
  // 下钻跟随（拖动选择不狂跳）；跨盘/非目录不动。目标从整棵扫描根解析。
  const selectFromTree = (p: string) => {
    select(p);
    if (mapFollowTimer.current !== null) window.clearTimeout(mapFollowTimer.current);
    mapFollowTimer.current = window.setTimeout(() => {
      mapFollowTimer.current = null;
      const cur = navRef.current;
      const tab = cur.activeTabId ? cur.openTabs.find((t) => t.id === cur.activeTabId) : null;
      if (!tab || tab.kind !== 'map' || !cur.root) return;
      if (tab.crumb && driveOf(tab.crumb) !== driveOf(cur.root.path)) return; // 该 tab 属其他盘
      const mapNode = cur.mapRoots[tab.id] ?? cur.root;
      if (p === mapNode.path) return; // 已是当前空间图根
      // 从整棵扫描根解析目标——只查当前图根子树会让手动下钻后的图
      // 永久卡死（点子树外目录静默失效，换目录看图的主路径被堵）。
      const target = findNodeByPath(cur.root, p);
      if (target && target.is_dir) drillTo(tab.id, target); // 目录才跟随（换根即图跟着走）
    }, 300);
  };


  const walkThresholdBytes = walkThresholdGB * 1024 ** 3;
  // ── 分诊图层 O1（triage-overlay-spec §3）：规则染色（scaffold + NEVER_TOUCH + 阈值）──
  const ruleVerdicts = useVerdicts(root, walkThresholdBytes);
  // ── O2：判定缓存（triage-cache.json，api.cacheGetAll/ SetAll；§7 决策 1）──
  // cacheMap = 持久化缓存的单一副本（启动恢复 + 批量判定 + 忽略反馈都写这里）；
  // cacheRef 供异步批量循环读现值（App 既有 navRef 同款渲染期同步模式）。
  const [cacheMap, setCacheMap] = useState<Map<string, CachedVerdict>>(new Map());
  const cacheRef = useRef(cacheMap);
  cacheRef.current = cacheMap;
  useEffect(() => {
    api.cacheGetAll()
      .then((json) => setCacheMap(parseCache(json)))
      .catch(() => { /* 读不到缓存就当空表，规则层照常 */ });
  }, []);
  const upsertCache = (path: string, entry: CachedVerdict) => {
    const next = new Map(cacheRef.current);
    next.set(path, entry);
    cacheRef.current = next;
    setCacheMap(next);
    api.cacheSetAll(serializeCache(next)).catch(() => pushOut('warn', '判定缓存写盘失败（triage-cache.json）'));
  };
  // ── O2：AI 批量分诊（spec §6 串行可停 / §7 决策 2 半自动确认 + 决策 4 免费接入引导）──
  type AiPhase = 'idle' | 'confirm' | 'running';
  const [aiPhase, setAiPhase] = useState<AiPhase>('idle');
  const [aiProgress, setAiProgress] = useState({ done: 0, total: 0 });
  const aiStopRef = useRef(false);
  const [showAiGuide, setShowAiGuide] = useState(false);
  const [settingsPrefill, setSettingsPrefill] = useState<{ baseUrl: string; model: string } | null>(null);
  // AI 分诊候选（spec §2：无规则判定且 ≥ 阈值的未识别目录，体积降序）
  const aiTargets = useMemo(
    () => (root ? pickAiTriageTargets(root, walkThresholdBytes) : []),
    [root, walkThresholdBytes],
  );
  const aiUncachedCount = useMemo(
    () => aiTargets.filter((t) => !cacheHitFor(t, cacheMap)).length,
    [aiTargets, cacheMap],
  );
  const startAiTriage = () => {
    if (aiTargets.length === 0) return;
    aiStopRef.current = false;
    setAiProgress({ done: 0, total: aiTargets.length });
    setAiPhase('running');
    pushOut('info', `AI 分诊开始：${aiTargets.length} 个目录 · 串行执行（只发目录元数据，不读文件内容）`);
    void runAiTriage(aiTargets, cacheRef.current, {
      onVerdict: (path, entry) => upsertCache(path, entry),
      onProgress: (done, total) => setAiProgress({ done, total }),
      shouldStop: () => aiStopRef.current,
    }).then((out) => {
      setAiPhase('idle');
      if (out.failed > 0) pushOut('error', `AI 分诊结束：新增 ${out.applied}（其中缓存复用 ${out.skipped}）· 失败 ${out.failed}${out.stopped ? ' · 已停止' : ''} · 首个错误：${out.errors[0]}`);
      else pushOut('info', `AI 分诊结束：新增 ${out.applied}（其中缓存复用 ${out.skipped}）· 失败 0${out.stopped ? ' · 已停止' : ''}`);
    });
  };
  const stopAiTriage = () => { aiStopRef.current = true; };
  // 新扫描替换 root：在途批量立即叫停（旧目标的判定即使落盘也会被签名校验挡住，但不该继续花钱）
  useEffect(() => { aiStopRef.current = true; }, [root]);
  // 忽略反馈闭环（spec §5.3）：verdict=user-ignored 入缓存；下次 AI prompt 附提示
  const ignoreVerdict = (path: string) => {
    const n = root ? findNodeByPath(root, path) : null;
    if (!n) return;
    upsertCache(path, {
      verdict: 'user-ignored',
      bytes: n.size, fileCount: n.file_count,
      reason: '用户忽略了此前的 AI 判定',
      source: 'user', ts: Date.now(),
    });
    pushOut('info', `已忽略 ${n.name} 的 AI 判定（反馈只存本机）`);
  };
  // 合并索引：规则 + 缓存/AI（签名校验、规则 safe/system 优先、user-ignored 不上色）
  // ——每条 AI 判定落地 upsertCache → cacheMap 变化 → 这里重算 → 图/树/卡渐进上色
  const verdicts = useMemo(
    () => (root ? applyCache(ruleVerdicts, root, cacheMap) : ruleVerdicts),
    [ruleVerdicts, root, cacheMap],
  );
  // 巡查进行中（队列未空且还有未完成的项）；空队列或走完后回到 TriageView。
  const walkActive = walkQueue.length > 0 && walkIndex < walkQueue.length;

  // 操作记录筛选（第三波增量；侧栏 records 面板与记录 tab 共享）
  const [recordAction, setRecordAction] = useState<'all' | UndoEntry['action']>('all');
  const [recordSinceDays, setRecordSinceDays] = useState<number | null>(null);

  const startWalk = (jumpTo?: string) => {
    if (!root) return;
    const items: WalkItem[] = buildWalkQueue(root, walkThresholdBytes)
      .map((w) => ({ ...w, status: 'pending' as const }));
    // f2-1：空队列不再静默开 tab——此前照样 openTab('walk')，页面只有
    // 「巡查待启动」零反馈。给出原因与出路（调阈值）后留在原地。
    if (items.length === 0) {
      pushOut('warn', `没有大于阈值 ${walkThresholdGB} GB 的目录，调低阈值再试`);
      return;
    }
    const idx = jumpTo ? items.findIndex((w) => w.node.path === jumpTo) : -1;
    // f2-1：jumpTo 不在队列（低于阈值 / never-touch 过滤）不再静默回退队首，
    // 至少给一条可见提示。
    if (jumpTo && idx < 0) {
      pushOut('warn', `「${jumpTo}」不在巡查队列（可能低于阈值或属系统保护区），已从队首开始`);
    }
    setWalk(items, idx >= 0 ? idx : 0);
    if (jumpTo) select(jumpTo);
    // spec §3 侧栏联动：开巡查 tab
    openTab('walk', '巡查');
  };

  useEffect(() => {
    if (!isTauri) return;
    const unlisten = listen<{ files_seen: number; bytes_seen: number; current_path: string }>(
      'scan-progress',
      (e) => setScanProgress({ files: e.payload.files_seen, bytes: e.payload.bytes_seen, path: e.payload.current_path }),
    );
    return () => { unlisten.then((u) => u()); };
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    const unlisten = listen<ScanStatsEvent>('scan-stats', (e) => {
      lastBackendStats.current = e.payload;
    });
    return () => { unlisten.then((u) => u()); };
  }, []);

  const pickDirectory = async () => {
    if (!isTauri) {
      const p = window.prompt('浏览器预览模式：输入一个路径（任意值都可以）', 'C:\\');
      if (p) setPickedPath(p);
      return;
    }
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === 'string') setPickedPath(picked);
  };

  const scan = async () => {
    if (!pickedPath) return;
    setErr(null); setScanning(true); setScanProgress(null); setScanTotalBytes(null); setDiag(null);
    lastBackendStats.current = null;
    pushOut('info', `开始扫描 ${pickedPath}`);
    // spec §2：扫描时自动展开底面板显示进度
    setRegions((r) => (r.bottom ? r : { ...r, bottom: true }));
    setBpTab('out');
    if (isTauri) {
      if (isDriveRoot(pickedPath)) {
        // Drive root: ask the OS for used bytes — instant, exact.
        api.volumeInfo(pickedPath)
          .then((info) => { if (info) setScanTotalBytes(info.used_bytes); })
          .catch(() => {});
      } else {
        // Subfolder: run a fast size-only walk in parallel with the real scan.
        // The real scan is doing the same work either way; this just gives the
        // progress bar an exact denominator a bit ahead of completion.
        api.estimateSize(pickedPath)
          .then((bytes) => { if (bytes > 0) setScanTotalBytes(bytes); })
          .catch(() => {});
      }
    }
    const tTotal0 = performance.now();
    try {
      const tScan0 = performance.now();
      const node = await api.scan(pickedPath);
      const tScan1 = performance.now();

      const tSet0 = performance.now();
      setRoot(node);
      select(node.path);
      const tSet1 = performance.now();

      const totalMs = tSet1 - tTotal0;
      // Cast through the ref accessor: TS narrows `.current` to the last
      // assignment it sees in this flow (the `= null` reset earlier), missing
      // the listener's assignment from another effect.
      const backend = (lastBackendStats.current as unknown) as ScanStatsEvent | null;
      const ipcMs: number | null =
        backend !== null ? Math.max(0, (tScan1 - tScan0) - backend.cmd_total_ms) : null;
      const next: ScanDiag = {
        backend,
        ipcMs,
        scanCallMs: tScan1 - tScan0,
        setRootMs: tSet1 - tSet0,
        totalMs,
      };
      setDiag(next);
      pushOut(
        'info',
        `扫描完成 · mode=${backend?.mode ?? 'n/a'} · ${node.file_count.toLocaleString()} 文件 · ${formatBytes(node.size)} · 总耗时 ${fmtMs(totalMs)}`,
      );
      // eslint-disable-next-line no-console
      console.log('[pinkbin.diag]', {
        backend,
        scanCallMs: next.scanCallMs.toFixed(1),
        ipcMs: ipcMs?.toFixed(1) ?? null,
        setRootMs: next.setRootMs.toFixed(1),
        totalMs: totalMs.toFixed(1),
      });
      // spec §3：扫描完成 → 自动开/聚焦对应「空间图」tab
      const drive = driveOf(pickedPath);
      openTab('map', `空间图 · ${drive}`, drive);
    } catch (e) {
      setErr(String(e));
      pushOut('error', `扫描失败：${String(e)}`);
    } finally {
      setScanning(false);
    }
  };

  // ── 编辑器 tab 床内容（spec §3：tab 种类 map/walk/script/records） ──
  const renderTabContent = (tab: EditorTab) => {
    if (tab.kind === 'map') {
      const matchesRoot = !!root && (!tab.crumb || tab.crumb === driveOf(root.path));
      // 下钻根：tab 专属；无下钻记录时 = 整盘扫描根
      const mapNode = matchesRoot ? (mapRoots[tab.id] ?? root) : null;
      const segs = (mapNode?.path ?? tab.crumb ?? '').split(/[\\/]/).filter(Boolean);
      let acc = '';
      // 详情卡数据（spec §2.0：单击块 = 选中 → 卡片）。选中即当前空间图根时
      // （刚下钻/刚扫描完）不展示——信息已在面包屑行，卡片纯属遮挡；
      // 选中路径不在当前 tab 子树内（另一盘的 tab）同样不展示。
      const detailNode = root && selectedPath ? findNodeByPath(root, selectedPath) : null;
      const inMapSubtree = !!detailNode && !!mapNode &&
        (detailNode.path === mapNode.path || detailNode.path.startsWith(mapNode.path + (mapNode.path.endsWith('\\') ? '' : '\\')));
      const showDetail = !!(mapNode && detailNode && detailNode.path !== mapNode.path && inMapSubtree);
      return (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div className="crumb">
            {/* 2c-13：面包屑段包进弹性容器（.crumb-path），深路径时自身收缩、
                overflow 裁浅层保最深段，右侧 AI 按钮/图例/统计不再被顶出。
                title 给完整路径兜底（段被裁时悬停可读全路径）。 */}
            {mapNode ? (
              <span className="crumb-path" title={mapNode.path}>
                {/* f0-1：深路径（>4 段）裁剪后浅层段不可点——行首给「⌂」一键
                    回扫描根，免逐段点面包屑或重扫。 */}
                {segs.length > 4 && root && (
                  <>
                    <button
                      className="crumb-link"
                      title={`回到扫描根：${root.path}`}
                      onClick={() => drillTo(tab.id, root)}
                    >⌂</button>
                    <span className="crumb-sep">›</span>
                  </>
                )}
                {segs.map((seg, i) => {
                  acc = i === 0 ? seg + '\\' : (acc.endsWith('\\') ? acc + seg : acc + '\\' + seg);
                  const n = findNodeByPath(root, acc) ?? findNodeByPath(root, seg);
                  return (
                    <span key={i}>
                      {n ? (
                        <button className="crumb-link" onClick={() => drillTo(tab.id, n)}>{seg}</button>
                      ) : (
                        <span className="crumb-link" style={{ cursor: 'default' }}>{seg}</span>
                      )}
                      {i < segs.length - 1 && <span className="crumb-sep">›</span>}
                    </span>
                  );
                })}
              </span>
            ) : (
              <>
                <span className="path-clip">{tab.crumb ?? tab.title}</span>
                <div className="grow" />
              </>
            )}
            {/* AI 批量分诊（spec §6/§7：半自动确认 + 串行可停 + 未配置走免费接入引导） */}
            {aiPhase === 'running' ? (
              <span className="ai-triage-strip">
                <span className="ai-triage-progress" title="AI 串行分诊中 · 只发目录元数据">
                  AI 分诊 {aiProgress.done}/{aiProgress.total}
                </span>
                <button className="btn ghost" onClick={stopAiTriage}>停止</button>
              </span>
            ) : aiPhase === 'confirm' ? (
              <span className="ai-triage-strip">
                <span className="ai-triage-progress" title="未识别且 ≥ 巡查阈值的目录 · 缓存命中不重复请求">
                  AI 可分诊 {aiTargets.length} 个未知目录 · 约 {aiUncachedCount} 次请求
                </span>
                <button className="btn primary" onClick={startAiTriage} disabled={aiUncachedCount === 0 && aiTargets.length === 0}>开始</button>
                <button className="btn ghost" onClick={() => setAiPhase('idle')}>取消</button>
              </span>
            ) : (
              <button
                className="btn ghost ai-triage-btn"
                disabled={!root}
                title={advisorTag
                  ? `对 ${aiTargets.length} 个未识别目录逐个问 AI（约 ${aiUncachedCount} 次请求）`
                  : '还没有配置 AI — 点开有免费接入方案'}
                onClick={() => (advisorTag ? setAiPhase('confirm') : setShowAiGuide(true))}
              >
                <Icon name="sparkles" size={12} /> AI 分诊
              </button>
            )}
            {/* 分诊图例（triage-overlay-spec §3：图例条常驻 tab 工具行）；
                聚焦开关状态提升在 App，经 props 下传（§2.1.2） */}
            <TriageLegend focusClean={focusClean} onToggleFocusClean={toggleFocusClean} />
            {mapNode && (
              <span className="sz">{formatBytes(mapNode.size)} · {mapNode.file_count.toLocaleString()} 文件</span>
            )}
          </div>
          <div className="treemap-wrap" ref={treemapWrapRef} style={{ flex: 1, minHeight: 0 }}>
            {mapNode ? (
              treemapSize && treemapSize.w > 0 && treemapSize.h > 0 ? (
                <Treemap
                  node={mapNode}
                  width={treemapSize.w}
                  height={treemapSize.h}
                  onSelect={select}
                  selectedPath={selectedPath}
                  verdicts={verdicts.verdicts}
                  cleanableUnder={verdicts.cleanableUnder}
                  focusClean={focusClean}
                  onOpen={(p) => {
                    const n = findNodeByPath(root, p);
                    if (n) drillTo(tab.id, n);
                  }}
                />
              ) : null
            ) : (
              <div className="empty">
                <div className="empty-title">还没扫描</div>
                <div className="empty-sub">{tab.crumb ?? '该盘'} 还没有扫描数据；回入口页选择路径并点「扫描」。</div>
              </div>
            )}
            {showDetail && detailNode && (
              <ErrorBoundary fallbackLabel="详情卡渲染失败">
                <BlockDetailCard
                  node={detailNode}
                  entry={verdicts.verdicts.get(detailNode.path) ?? null}
                  cleanableBytes={verdicts.cleanableUnder.get(detailNode.path) ?? 0}
                  canEnter={detailNode.is_dir && (detailNode.children?.length ?? 0) > 0}
                  canIgnore={verdicts.verdicts.get(detailNode.path)?.source === 'ai'}
                  onIgnore={() => ignoreVerdict(detailNode.path)}
                  scriptName={detailNode.scaffold_id
                    ? scaffolds.find((sc) => sc.id === detailNode.scaffold_id)?.name ?? null
                    : null}
                  onJumpToScript={(name) => openTab('script', name)}
                  onEnter={() => drillTo(tab.id, detailNode)}
                  onClose={() => select(null)}
                />
              </ErrorBoundary>
            )}
          </div>
        </div>
      );
    }
    if (tab.kind === 'walk') {
      return (
        <div className="center-body">
          {!root ? (
            <div className="empty">
              <div className="empty-title">还没扫描</div>
              <div className="empty-sub">先选好磁盘并点「扫描」，扫描完成后这里才能分类和巡查。</div>
            </div>
          ) : walkActive ? (
            <AutoWalk />
          ) : (
            <>
              <div className="walk-entry">
                <span className="muted small">逐个审阅大于 {walkThresholdGB} GB 的目录</span>
                <button className="btn primary" onClick={() => startWalk()}>
                  <Icon name="list-checks" size={14} /> 开始巡查
                </button>
              </div>
              <TriageView
                root={root}
                thresholdBytes={walkThresholdBytes}
                verdicts={verdicts.verdicts}
                onJumpToWalk={(it: Triaged) => startWalk(it.node.path)}
                onSelect={select}
              />
            </>
          )}
        </div>
      );
    }
    if (tab.kind === 'script') {
      // spec §4：脚本详情 tab —— Studio 全量挂载（buildScaffoldCards 复用）：
      // 卡片展开详情、CleanupModal、问 AI、Steam Inspector 工具卡都在。
      // 从侧栏脚本卡片点进来的 tab（title=脚本名）初始展开该卡片（focusId）。
      const sc = scaffolds.find((s) => s.name === tab.title);
      if (tab.title !== '脚本库' && !sc) {
        return (
          <div className="tbody">
            <p className="muted">没有找到脚本「{tab.title}」。</p>
          </div>
        );
      }
      return (
        <div className="center-body">
          <ErrorBoundary fallbackLabel="脚本详情渲染失败">
            <Studio key={tab.id} focusId={sc?.id} />
          </ErrorBoundary>
        </div>
      );
    }
    // records
    return (
      <div className="center-body">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 14px 0' }}>
          <div className="seg">
            {RECORD_ACTIONS.map((a) => (
              <button
                key={a.id}
                className={recordAction === a.id ? 'on' : ''}
                onClick={() => setRecordAction(a.id)}
              >
                <Icon name={a.icon} size={12} /> {a.label}
              </button>
            ))}
          </div>
          <div className="seg">
            {RECORD_SINCE.map((s) => (
              <button
                key={String(s.id)}
                className={recordSinceDays === s.id ? 'on' : ''}
                onClick={() => setRecordSinceDays(s.id)}
              >
                <Icon name={s.icon} size={12} /> {s.label}
              </button>
            ))}
          </div>
        </div>
        <ErrorBoundary fallbackLabel="操作记录视图渲染失败">
          <RecordsView actionFilter={recordAction} sinceDays={recordSinceDays} />
        </ErrorBoundary>
      </div>
    );
  };

  // ── 入口页（无 tab 空态）：居中大标题 + 提示行 + 扫描行 + 六卡格 3×2 ──
  const entryDrive = driveOf(pickedPath || 'C:\\');
  // 六卡接线：空间图卡直接开空间图 tab（v5 预览行为）；未扫描时 tab 内有空态兜底
  const renderEntry = () => {
    const cards: { key: string; icon: string; cap: string; sub: string; onClick: () => void }[] = [
      {
        key: 'map-new',
        icon: 'map',
        cap: '空间图',
        sub: root ? '新扫描' : `${entryDrive} 新扫描`,
        onClick: () => openTab('map', `空间图 · ${entryDrive}`),
      },
      { key: 'walk', icon: 'list-checks', cap: '巡查', sub: '分诊报告', onClick: () => openTab('walk', '巡查') },
      { key: 'lib', icon: 'package', cap: '脚本库', sub: `${scaffolds.length} 个`, onClick: () => openTab('script', '脚本库') },
      { key: 'records', icon: 'history', cap: '操作记录', sub: 'undo', onClick: () => openTab('records', '操作记录') },
      {
        key: 'rescan',
        icon: 'refresh-cw',
        cap: '重新扫描',
        sub: pickedPath || '先选择目录',
        onClick: () => void scan(),
      },
      { key: 'settings', icon: 'settings', cap: '设置', sub: 'AI · 主题 · 字号', onClick: () => setShowSettings(true) },
    ];
    return (
      <div className="entrypage">
        <div className="entry-hello">开始清理 <b>{entryDrive}</b></div>
        <div className="entry-hint">点卡片打开一个标签页 · 顶部可多开 · 可关闭 · 各区域可独立折叠</div>
        <div className="entry-scan">
          <Icon name="folder-open" size={14} />
          <span className="path-clip" style={{ maxWidth: 320 }} title={pickedPath || undefined}>
            {pickedPath || '选择磁盘或文件夹'}
          </span>
          {/* §2b-9：次级按钮归一为标准 .btn（有边框），与右侧 primary 扫描成对 */}
          <button className="btn" onClick={() => void pickDirectory()}>选择…</button>
          <button className="btn primary" onClick={() => void scan()} disabled={!pickedPath || scanning}>
            <Icon name="scan-line" size={13} /> {scanning ? '扫描中…' : '扫描'}
          </button>
        </div>
        <div className="entry-grid">
          {cards.map((c) => (
            <button key={c.key} className="entry-card" onClick={c.onClick}>
              <span className="ico"><Icon name={c.icon} size={18} /></span>
              <span className="cap"><b>{c.cap}</b><small>{c.sub}</small></span>
            </button>
          ))}
        </div>
      </div>
    );
  };

  // ── 侧栏四面板（spec §2；本阶段挂既有组件） ──
  const renderSideBody = (side: SideId) => {
    switch (side) {
      case 'explorer':
        return root ? (
          <TreeView
            root={root}
            selectedPath={selectedPath}
            onSelect={selectFromTree}
            focusPath={treeFocusPath}
            verdicts={verdicts.verdicts}
            cleanableUnder={verdicts.cleanableUnder}
            focusClean={focusClean}
          />
        ) : (
          <div className="side-info">
            <p className="muted">先选一个文件夹并点「扫描」，这里会列出每个文件夹和文件（支持右键删除）。</p>
          </div>
        );
      case 'queue':
        return (
          <div className="side-list">
            <div className="side-line" onClick={() => openTab('walk', '巡查')} role="button" tabIndex={0}>
              <Icon name="list-checks" size={14} />
              <span className="side-line-name">已审阅 {Math.min(walkIndex, walkQueue.length)} / {walkQueue.length}</span>
              <span className="side-line-meta">巡查 →</span>
            </div>
            <div className="side-line">
              <Icon name="hard-drive" size={14} />
              <span className="side-line-name">本次已释放</span>
              <span className="side-line-meta">{formatBytes(reclaimedBytes)}</span>
            </div>
            {/* f2-3：隔离不释放空间，单独计件数展示（不再混入已释放字节） */}
            {quarantinedCount > 0 && (
              <div className="side-line">
                <Icon name="archive-restore" size={14} />
                <span className="side-line-name">已隔离</span>
                <span className="side-line-meta">{quarantinedCount} 项</span>
              </div>
            )}
            <div className="side-line">
              <Icon name="gauge" size={14} />
              <span className="side-line-name">大小阈值</span>
              <input
                className="side-line-input"
                type="number"
                min={1}
                max={100}
                value={walkThresholdGB}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (!Number.isFinite(v) || v < 1) return;
                  // f2-1：上限钳到 100 GB（与输入框 max 一致；超大阈值只会造出
                  // 空队列），钳制时给出可见提示。
                  const clamped = Math.min(v, 100);
                  if (v > 100) pushOut('warn', '巡查阈值上限 100 GB，已自动调整');
                  setThreshold(clamped);
                }}
                title="巡查只审阅大于该体积的目录"
              />
              <span className="side-line-meta">GB</span>
            </div>
            {root && (
              <div className="side-actions">
                <button className="btn primary" onClick={() => startWalk()}>
                  <Icon name="radar" size={14} /> 开始巡查
                </button>
              </div>
            )}
          </div>
        );
      case 'scripts':
        return <ScaffoldSideList onOpen={(sc) => openTab('script', sc.name)} />;
      case 'records':
        return (
          <div className="side-list">
            <div className="side-group">按动作</div>
            <div className="seg">
              {RECORD_ACTIONS.map((a) => (
                <button
                  key={a.id}
                  className={recordAction === a.id ? 'on' : ''}
                  onClick={() => setRecordAction(a.id)}
                >
                  <Icon name={a.icon} size={12} /> {a.label}
                </button>
              ))}
            </div>
            <div className="side-group">按时间</div>
            <div className="seg">
              {RECORD_SINCE.map((s) => (
                <button
                  key={String(s.id)}
                  className={recordSinceDays === s.id ? 'on' : ''}
                  onClick={() => setRecordSinceDays(s.id)}
                >
                  <Icon name={s.icon} size={12} /> {s.label}
                </button>
              ))}
            </div>
            <div className="side-actions">
              <button className="btn ghost" onClick={() => openTab('records', '操作记录')}>
                <Icon name="history" size={13} /> 打开操作记录
              </button>
            </div>
          </div>
        );
    }
  };

  return (
    <div className="app-v2">
      {/* ── 顶带 35px ── */}
      <header className="titlebar">
        <span className="brand">
          <Logo size={16} />
          <span className="dot" />
          DiskSift
        </span>
        <nav className="menus" aria-label="菜单占位">
          <span>文件</span><span>编辑</span><span>查看</span><span>扫描</span><span>帮助</span>
        </nav>
        <div className="grow" />
        <div className="rg" role="group" aria-label="区域开关">
          <button
            className={regions.sidebar ? 'on' : ''}
            onClick={() => toggleRegion('sidebar')}
            title="侧栏"
            aria-label="侧栏开关"
            aria-pressed={regions.sidebar}
          >
            <Icon name="panel-left" size={14} />
          </button>
          <button
            className={regions.bottom ? 'on' : ''}
            onClick={() => toggleRegion('bottom')}
            title="底面板"
            aria-label="底面板开关"
            aria-pressed={regions.bottom}
          >
            <Icon name="panel-bottom" size={14} />
          </button>
          <button
            className={regions.ai ? 'on' : ''}
            onClick={() => toggleRegion('ai')}
            title="AI 面板"
            aria-label="AI 面板开关"
            aria-pressed={regions.ai}
          >
            <Icon name="panel-right" size={14} />
          </button>
        </div>
        <button
          className="tb-icon"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
          aria-label="切换主题"
        >
          {/* 主题切换：sun/moon 均 docs/_icons.json 已提取键（Icon.tsx 渲染），
              替换原文本字符方案（§1-D 图标纪律） */}
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={14} />
        </button>
      </header>

      {/* ── 工作台 ── */}
      <div className="workbench-v2">
        <nav className="activitybar" aria-label="活动栏">
          {SIDE_META.map((m) => (
            <button
              key={m.id}
              className={'act' + (activeSide === m.id ? ' active' : '')}
              onClick={() => clickAct(m.id)}
              title={m.label}
              aria-label={m.label}
              aria-pressed={activeSide === m.id}
            >
              <Icon name={m.icon} size={20} />
            </button>
          ))}
          <button
            className="act act-bottom"
            onClick={() => setShowSettings(true)}
            title={advisorTag ? `设置 · 已绑定 ${advisorTag.provider}` : '设置 · AI 还没配置'}
            aria-label="设置"
          >
            <Icon name="settings" size={20} />
          </button>
        </nav>

        {regions.sidebar && (
          <>
            <aside className="sidebar" style={{ width: sidebarW }}>
              <div className="side-head">
                <Icon name={SIDE_META.find((m) => m.id === activeSide)?.icon ?? 'folder-tree'} size={13} />
                {activeSide === 'scripts' ? `脚本列表 · ${scaffolds.length}` : SIDE_META.find((m) => m.id === activeSide)?.label}
              </div>
              <div className="side-body">{renderSideBody(activeSide)}</div>
            </aside>
            <Splitter onDrag={dragSidebar} onDoubleClick={() => setSidebarW(DEFAULT_SIDEBAR)} />
          </>
        )}

        <section className="maincol">
          {err && <div className="banner error" style={{ flexShrink: 0 }}>{err}</div>}
          <div className="tabbar" role="tablist" aria-label="编辑器标签页">
            <button className="tb-btn" onClick={goEntry} title="回入口页" aria-label="回入口页">
              <Icon name="home" size={14} />
            </button>
            {openTabs.map((t) => (
              <button
                key={t.id}
                className={'edittab' + (t.id === activeTabId ? ' active' : '')}
                onClick={() => activateTab(t.id)}
                role="tab"
                aria-selected={t.id === activeTabId}
                title={t.title}
              >
                <span className="ticon"><Icon name={TAB_ICONS[t.kind]} size={13} /></span>
                <span className="tlabel">{t.title}</span>
                <span
                  className="x"
                  role="button"
                  aria-label={`关闭 ${t.title}`}
                  onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
                >
                  <Icon name="x" size={12} />
                </span>
              </button>
            ))}
            <div className="grow" />
            <button className="tb-btn" onClick={goEntry} title="新标签页（回入口页）" aria-label="新标签页">
              <Icon name="plus" size={14} />
            </button>
          </div>

          <div className="editorarea">
            {activeTab ? renderTabContent(activeTab) : renderEntry()}
          </div>

          {regions.bottom && (
            <>
              <Splitter orientation="vertical" onDrag={dragBottom} onDoubleClick={() => setBottomH(DEFAULT_BOTTOM)} />
              <section className="bottompanel" style={{ height: bottomH }}>
                <div className="bp-head">
                  <button className={'bptab' + (bpTab === 'out' ? ' on' : '')} onClick={() => setBpTab('out')}>
                    <Icon name="terminal" size={13} /> 输出
                  </button>
                  <button className={'bptab' + (bpTab === 'diag' ? ' on' : '')} onClick={() => setBpTab('diag')}>
                    <Icon name="activity" size={13} /> 诊断
                  </button>
                  <button className={'bptab' + (bpTab === 'records' ? ' on' : '')} onClick={() => setBpTab('records')}>
                    <Icon name="history" size={13} /> 记录
                  </button>
                  <span className="bp-right">
                    {scanning
                      ? `${(scanProgress?.files ?? 0).toLocaleString()} 文件`
                      : root
                        ? `${formatBytes(root.size)} · ${root.file_count.toLocaleString()} 文件`
                        : '就绪'}
                  </span>
                </div>
                <div className="bp-body">
                  {bpTab === 'out' && (
                    <>
                      {scanning && (
                        <div className="scan-bar" style={{ marginBottom: 8 }}>
                          <div
                            className={'scan-bar-fill' + (scanTotalBytes && scanProgress ? ' determinate' : ' indeterminate')}
                            style={
                              scanTotalBytes && scanProgress
                                ? { width: `${Math.min(99, (scanProgress.bytes / scanTotalBytes) * 100)}%` }
                                : undefined
                            }
                          />
                          <div className="scan-bar-label">
                            {scanProgress
                              ? `${scanProgress.files.toLocaleString()} 个文件 · ${formatBytes(scanTotalBytes ? Math.min(scanProgress.bytes, scanTotalBytes) : scanProgress.bytes)}${scanTotalBytes ? ` / ${formatBytes(scanTotalBytes)}` : ''}`
                              : '准备扫描…'}
                          </div>
                        </div>
                      )}
                      {outLines.map((l, i) => (
                        <div key={i}>
                          <span className={`log-tag ${l.level}`}>{l.level}</span> {l.text}
                        </div>
                      ))}
                    </>
                  )}
                  {bpTab === 'diag' && (
                    diag ? (
                      <DiagnosticsBar diag={diag} />
                    ) : (
                      <div>暂无诊断数据 — 先扫描一次。</div>
                    )
                  )}
                  {bpTab === 'records' && (
                    <ErrorBoundary fallbackLabel="记录简表渲染失败">
                      <RecordsView actionFilter={recordAction} sinceDays={recordSinceDays} />
                    </ErrorBoundary>
                  )}
                </div>
              </section>
            </>
          )}
        </section>

        {regions.ai && (
          <>
            <Splitter onDrag={dragAI} onDoubleClick={() => setAiW(DEFAULT_AI)} />
            <aside className="aipanel" style={{ width: aiW }}>
              <div className="ai-head">
                <span className="hicon"><Icon name="bot" size={14} /></span> AI 顾问
                {advisorTag && <span className="mono" title="当前 AI 提供商">{advisorTag.provider}</span>}
                <div className="grow" />
                <span className="ai-actions">
                  <button title="新对话（清空当前多轮会话）" aria-label="新对话" onClick={resetChat}>
                    <Icon name="square-pen" size={14} />
                  </button>
                  <button title="历史（暂未开放）" aria-label="历史">
                    <Icon name="history" size={14} />
                  </button>
                  <button title="搜索（暂未开放）" aria-label="搜索">
                    <Icon name="search" size={14} />
                  </button>
                  <button title="关闭 AI 面板" aria-label="关闭 AI 面板" onClick={() => toggleRegion('ai')}>
                    <Icon name="x" size={14} />
                  </button>
                </span>
              </div>
              {/* ChatPanel 全量（spec §4）：多轮（最近 20 轮上下文）/ 图片（粘贴·拖拽·选择）/
                  扫描完成自动总览 / Studio 问 AI 联动（studioRequest）。多轮历史不回退。 */}
              <div className="ai-chat-host">
                <ErrorBoundary fallbackLabel="AI 对话面板渲染失败">
                  <ChatPanel />
                </ErrorBoundary>
              </div>
            </aside>
          </>
        )}
      </div>

      {/* ── 状态栏 22px ── */}
      <footer className="statusbar">
        <span className="path-clip" style={{ maxWidth: 280 }} title={(root?.path ?? pickedPath) || '未选择路径'}>
          {(root?.path ?? pickedPath) || '未选择路径'}
        </span>
        <span>{root ? `${formatBytes(root.size)} · ${root.file_count.toLocaleString()} 文件` : '未扫描'}</span>
        <div className="grow" />
        <span>{advisorTag ? advisorTag.provider : 'AI 未配置'}</span>
        <span>{scaffolds.length} 个脚本</span>
        <button className="chip" onClick={cycleFsTier} title="界面字号（字号档位循环）">
          A·{fsTier}
        </button>
        <span>v{APP_VERSION}</span>
      </footer>

      {/* 免费 AI 接入引导（triage-overlay-spec §7 决策 4）：三条免费路径，点「去设置」
          直达设置页并预填 Base URL/Model。隐私口径与 Settings 一致：只发目录元数据。 */}
      {showAiGuide && (
        <div className="modal-bg" onClick={() => setShowAiGuide(false)}>
          <div className="card ai-guide" onClick={(e) => e.stopPropagation()}>
            <span className="sec-title">接入免费 AI，开启批量分诊</span>
            <p className="muted">
              还没有配置 AI。三个免费方案任选其一——分诊只会把目录元数据（路径、大小、文件数、
              扩展名分布、抽样路径）发给 AI，<b>绝不读取文件内容</b>。
            </p>
            {FREE_AI_PATHS.map((p) => (
              <div key={p.key} className="ai-guide-row">
                <div className="ai-guide-info">
                  <b>{p.label}</b>
                  <div className="muted small">{p.note}</div>
                  <div className="ai-guide-ep mono-num">{p.baseUrl} · {p.model}</div>
                </div>
                <button
                  className="btn"
                  onClick={() => {
                    setSettingsPrefill({ baseUrl: p.baseUrl, model: p.model });
                    setShowAiGuide(false);
                    setShowSettings(true);
                  }}
                >
                  去设置
                </button>
              </div>
            ))}
            <div className="overview-actions">
              <button className="btn ghost" onClick={() => setShowAiGuide(false)}>稍后再说</button>
            </div>
          </div>
        </div>
      )}

      {showSettings && (
        <Settings
          onClose={() => { setShowSettings(false); setSettingsPrefill(null); refreshAdvisorTag(); }}
          prefill={settingsPrefill}
        />
      )}
    </div>
  );
}

function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function DiagnosticsBar({ diag }: { diag: ScanDiag }) {
  const b = diag.backend;
  const parts: string[] = [];
  if (b) {
    parts.push(`mode=${b.mode}`);
    if (b.mft_attempted) parts.push(`mft=${b.mft_succeeded ? 'ok' : 'fail'}/${fmtMs(b.mft_ms)}`);
    if (b.mode === 'walkdir') {
      parts.push(`walk=${fmtMs(b.walk_ms)}`);
      parts.push(`build_tree=${fmtMs(b.build_tree_ms)}`);
      parts.push(`dirs=${b.dirs_in_acc.toLocaleString()}`);
    }
    parts.push(`scanner=${fmtMs(b.scanner_total_ms)}`);
    parts.push(`tag=${fmtMs(b.tag_ms)}`);
  }
  parts.push(`ipc=${fmtMs(diag.ipcMs)}`);
  parts.push(`setRoot=${fmtMs(diag.setRootMs)}`);
  parts.push(`total=${fmtMs(diag.totalMs)}`);
  return (
    <div className="diag-bar" title="扫描各阶段耗时 — localStorage 开关：pinkbin.hideStudio">
      <span className="diag-label">诊断</span>
      <span className="diag-stats">{parts.join(' · ')}</span>
    </div>
  );
}
