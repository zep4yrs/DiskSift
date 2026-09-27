import { create } from 'zustand';
import type { Node, Scaffold, AdvisorResponse } from './types';

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
  selectedPath: string | null;
  walkQueue: WalkItem[];
  walkIndex: number;
  walkThresholdGB: number;
  reclaimedBytes: number;
  chat: ChatSession;
  studioRequest: { scaffoldId: string; ts: number } | null;

  setRoot: (n: Node | null) => void;
  setScaffolds: (s: Scaffold[]) => void;
  selectPath: (p: string | null) => void;
  setWalk: (q: WalkItem[], startIndex?: number) => void;
  advanceWalk: () => void;
  patchWalkItem: (i: number, patch: Partial<WalkItem>) => void;
  setThreshold: (gb: number) => void;
  addReclaimed: (n: number) => void;

  focusChatOn: (node: Node, scaffoldId: string | null) => void;
  pushChatTurn: (t: ChatTurn) => void;
  patchChatTurn: (id: string, patch: Partial<ChatTurn>) => void;
  setChatBusy: (b: boolean) => void;
  resetChat: () => void;
  requestStudio: (scaffoldId: string) => void;
  consumeStudio: () => void;
}

const restoredTabs = loadTabs();

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
  selectedPath: null,
  walkQueue: [],
  walkIndex: 0,
  walkThresholdGB: 1,
  reclaimedBytes: 0,
  chat: { node: null, scaffoldId: null, turns: [], busy: false },
  studioRequest: null,

  setRoot: (root) => set({ root }),
  setScaffolds: (scaffolds) => set({ scaffolds }),
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
  setChatBusy: (b) => set((s) => ({ chat: { ...s.chat, busy: b } })),
  resetChat: () => set(() => ({ chat: { node: null, scaffoldId: null, turns: [], busy: false } })),
  requestStudio: (scaffoldId) => set({ studioRequest: { scaffoldId, ts: Date.now() } }),
  consumeStudio: () => set({ studioRequest: null }),
}));

export function buildWalkQueue(root: Node, thresholdBytes: number): { node: Node; scaffoldId: string | null }[] {
  const out: { node: Node; scaffoldId: string | null }[] = [];
  const visit = (n: Node, depth: number) => {
    if (!n.is_dir) return;
    if (n.size >= thresholdBytes && depth > 0) {
      out.push({ node: n, scaffoldId: n.scaffold_id ?? null });
      return;
    }
    if (depth < 4) {
      for (const c of n.children) visit(c, depth + 1);
    }
  };
  visit(root, 0);
  out.sort((a, b) => b.node.size - a.node.size);
  return out;
}
