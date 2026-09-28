import { create } from 'zustand';
import type { Node, Scaffold, AdvisorResponse } from './types';
import { collectDirs, isNeverTouch } from './triage';

export interface WalkItem {
  node: Node;
  scaffoldId: string | null;
  advice?: AdvisorResponse;
  status: 'pending' | 'advising' | 'ready' | 'done' | 'skipped';
}

export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  // optional structured advice that goes with the turn
  advice?: AdvisorResponse;
  // optional scaffold suggestion the user can act on inline
  scaffoldId?: string | null;
  pending?: boolean;
  // f4-2：错误轮标记——构造多轮 history 时排除（错误文本塞回模型只会
  // 带偏下一轮），渲染不变。
  error?: boolean;
}

export interface ChatSession {
  // the node currently being discussed in the chat panel
  node: Node | null;
  scaffoldId: string | null;
  turns: ChatTurn[];
  busy: boolean;
}

// ── 编辑器 tab 模型（redesign-spec §3，v2 定稿）──────────────────────
// wave-3 的 activeView 模型废除：活动栏只切侧栏，编辑器是独立的 tab 床，
// 两者零重复。openTabs 快照 + activeTabId 持久化 localStorage（pinkbin.tabs /
// pinkbin.activeTab）；恢复时按 kind+title 重建（id 不持久化）。
export type TabKind = 'map' | 'walk' | 'script' | 'records';

export interface EditorTab {
  id: string;
  kind: TabKind;
  title: string;
  /** tab 顶部面包屑（空间图 tab 存盘符等） */
  crumb?: string;
}

const TABS_KEY = 'pinkbin.tabs';
const ACTIVE_KEY = 'pinkbin.activeTab';
const TAB_KINDS: string[] = ['map', 'walk', 'script', 'records'];

let tabSeq = 0;
const nextTabId = () => `t${++tabSeq}`;

type TabSnapshot = { kind: string; title: string; crumb?: string };

function loadTabs(): EditorTab[] {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (t): t is TabSnapshot =>
          !!t &&
          typeof t === 'object' &&
          typeof (t as TabSnapshot).kind === 'string' &&
          (TAB_KINDS as string[]).includes((t as TabSnapshot).kind) &&
          typeof (t as TabSnapshot).title === 'string',
      )
      .map((t) => ({ id: nextTabId(), kind: t.kind as TabKind, title: t.title, crumb: t.crumb }));
  } catch {
    return [];
  }
}

function loadActiveTabId(tabs: EditorTab[]): string | null {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const snap = parsed as TabSnapshot;
    const hit = tabs.find((t) => t.kind === snap.kind && t.title === snap.title);
    return hit ? hit.id : null;
  } catch {
    return null;
  }
}

function persistTabs(openTabs: EditorTab[], activeTabId: string | null) {
  try {
    localStorage.setItem(
      TABS_KEY,
      JSON.stringify(openTabs.map(({ kind, title, crumb }) => (crumb === undefined ? { kind, title } : { kind, title, crumb }))),
    );
    const active = openTabs.find((t) => t.id === activeTabId);
    if (active) localStorage.setItem(ACTIVE_KEY, JSON.stringify({ kind: active.kind, title: active.title }));
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* 忽略持久化失败 */
  }
}

interface AppState {
  // ── 编辑器 tab 床（spec §3）──
  openTabs: EditorTab[];
  /** null = 入口页 */
  activeTabId: string | null;
  /** 去重（kind+title）→ 激活；返回 tab id */
  openTab: (kind: TabKind, title: string, crumb?: string) => string;
  closeTab: (id: string) => void;
  activateTab: (id: string) => void;
  /** 回入口页（tabbar 的 [⌂] / [＋]）：activeTabId = null */
  goEntry: () => void;

  // ── 既有能力（零删除）──
  root: Node | null;
  scaffolds: Scaffold[];
  /** 已停用 scaffold 的前端留档：后端 list_scaffolds 直接过滤掉停用项，
   *  没有命令能再枚举它们，这里留副本让 Studio 渲染灰色卡片并支持重新
   *  启用；localStorage 持久化，跨重启仍可启用回来。 */
  disabledScaffolds: Scaffold[];
  selectedPath: string | null;
  walkQueue: WalkItem[];
  walkIndex: number;
  walkThresholdGB: number;
  reclaimedBytes: number;
  /** f2-3：隔离不释放空间，按件数单独计数（walk-bar / 侧栏展示）。 */
  quarantinedCount: number;
  chat: ChatSession;
  studioRequest: { scaffoldId: string; ts: number } | null;

  setRoot: (n: Node | null) => void;
  setScaffolds: (s: Scaffold[]) => void;
  setDisabledScaffolds: (s: Scaffold[]) => void;
  selectPath: (p: string | null) => void;
  setWalk: (q: WalkItem[], startIndex?: number) => void;
  advanceWalk: () => void;
  patchWalkItem: (i: number, patch: Partial<WalkItem>) => void;
  setThreshold: (gb: number) => void;
  addReclaimed: (n: number) => void;
  addQuarantined: (n: number) => void;

  focusChatOn: (node: Node, scaffoldId: string | null) => void;
  pushChatTurn: (t: ChatTurn) => void;
  patchChatTurn: (id: string, patch: Partial<ChatTurn>) => void;
  removeChatTurn: (id: string) => void;
  setChatBusy: (b: boolean) => void;
  resetChat: () => void;
  requestStudio: (scaffoldId: string) => void;
  consumeStudio: () => void;
}

const restoredTabs = loadTabs();

// ── 已停用 scaffold 留档（脚本中心启停）──────────────────────────────────
// 后端 scaffold_set_enabled 只维护 disabled 名单，list_scaffolds 把停用项
// 整个滤掉——前端拿不到任何「已停用清单」，所以停用时把 Scaffold 对象留在
// localStorage，重启后灰色卡片仍可渲染、仍可重新启用。
const DISABLED_KEY = 'pinkbin.disabledScaffolds';

function loadDisabledScaffolds(): Scaffold[] {
  try {
    const raw = localStorage.getItem(DISABLED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is Scaffold =>
        !!s && typeof s === 'object' && typeof (s as Scaffold).id === 'string',
    );
  } catch {
    return [];
  }
}

function persistDisabledScaffolds(list: Scaffold[]) {
  try {
    localStorage.setItem(DISABLED_KEY, JSON.stringify(list));
  } catch {
    /* 忽略持久化失败（隐私模式 / 配额） */
  }
}

export const useStore = create<AppState>((set, get) => ({
  openTabs: restoredTabs,
  activeTabId: loadActiveTabId(restoredTabs),

  openTab: (kind, title, crumb) => {
    const s = get();
    const dup = s.openTabs.find((t) => t.kind === kind && t.title === title);
    if (dup) {
      persistTabs(s.openTabs, dup.id);
      set({ activeTabId: dup.id });
      return dup.id;
    }
    const tab: EditorTab = { id: nextTabId(), kind, title, crumb };
    const openTabs = [...s.openTabs, tab];
    persistTabs(openTabs, tab.id);
    set({ openTabs, activeTabId: tab.id });
    return tab.id;
  },

  closeTab: (id) => {
    const s = get();
    const i = s.openTabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const openTabs = s.openTabs.filter((t) => t.id !== id);
    // 关闭活动 tab 时激活左邻（最左则右邻，无 tab 回入口页）
    const activeTabId = s.activeTabId === id ? (openTabs[Math.max(0, i - 1)]?.id ?? null) : s.activeTabId;
    persistTabs(openTabs, activeTabId);
    set({ openTabs, activeTabId });
  },

  activateTab: (id) => {
    persistTabs(get().openTabs, id);
    set({ activeTabId: id });
  },

  goEntry: () => {
    persistTabs(get().openTabs, null);
    set({ activeTabId: null });
  },

  root: null,
  scaffolds: [],
  disabledScaffolds: loadDisabledScaffolds(),
  selectedPath: null,
  walkQueue: [],
  walkIndex: 0,
  walkThresholdGB: 1,
  reclaimedBytes: 0,
  quarantinedCount: 0,
  chat: { node: null, scaffoldId: null, turns: [], busy: false },
  studioRequest: null,

  setRoot: (root) => set({ root }),
  setScaffolds: (scaffolds) => set({ scaffolds }),
  setDisabledScaffolds: (disabledScaffolds) => {
    persistDisabledScaffolds(disabledScaffolds);
    set({ disabledScaffolds });
  },
  selectPath: (selectedPath) => set({ selectedPath }),
  setWalk: (walkQueue, startIndex = 0) => set({ walkQueue, walkIndex: startIndex }),
  advanceWalk: () => set((s) => ({ walkIndex: Math.min(s.walkIndex + 1, s.walkQueue.length) })),
  patchWalkItem: (i, patch) =>
    set((s) => {
      const q = s.walkQueue.slice();
      q[i] = { ...q[i], ...patch };
      return { walkQueue: q };
    }),
  setThreshold: (walkThresholdGB) => set({ walkThresholdGB }),
  addReclaimed: (n) => set((s) => ({ reclaimedBytes: s.reclaimedBytes + n })),
  addQuarantined: (n) => set((s) => ({ quarantinedCount: s.quarantinedCount + n })),

  focusChatOn: (node, scaffoldId) =>
    // Keep prior turns — the user wants ONE running conversation. We just
    // update the "focused" node/scaffold so any inline scaffold chips line
    // up with whatever was most recently dropped.
    set((s) => ({ chat: { ...s.chat, node, scaffoldId } })),
  pushChatTurn: (t) => set((s) => ({ chat: { ...s.chat, turns: [...s.chat.turns, t] } })),
  patchChatTurn: (id, patch) =>
    set((s) => ({
      chat: {
        ...s.chat,
        turns: s.chat.turns.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      },
    })),
  removeChatTurn: (id) =>
    set((s) => ({ chat: { ...s.chat, turns: s.chat.turns.filter((t) => t.id !== id) } })),
  setChatBusy: (b) => set((s) => ({ chat: { ...s.chat, busy: b } })),
  resetChat: () => set(() => ({ chat: { node: null, scaffoldId: null, turns: [], busy: false } })),
  requestStudio: (scaffoldId) => set({ studioRequest: { scaffoldId, ts: Date.now() } }),
  consumeStudio: () => set({ studioRequest: null }),
}));

export function buildWalkQueue(root: Node, thresholdBytes: number): { node: Node; scaffoldId: string | null }[] {
  // v26.1.2：与 triage() 共用 collectDirs（单一出处，深度上限统一 5，阈值
  // 命中不再截断子树——C:\Users 90GB 曾挡住整棵用户树）。never-touch 系统
  // 保护区仍不进队列（此前无过滤导致 C:\Windows 进队的修复保留）。
  return collectDirs(root, thresholdBytes)
    .filter(({ node }) => !isNeverTouch(node.path))
    .sort((a, b) => b.node.size - a.node.size)
    .map(({ node }) => ({ node, scaffoldId: node.scaffold_id ?? null }));
}
