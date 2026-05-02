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

interface AppState {
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
  setWalk: (q: WalkItem[]) => void;
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

export const useStore = create<AppState>((set) => ({
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
  setWalk: (walkQueue) => set({ walkQueue, walkIndex: 0 }),
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
