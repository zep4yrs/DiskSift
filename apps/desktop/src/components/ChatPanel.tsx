import { useEffect, useMemo, useRef, useState } from 'react';
import { Send, Trash2, ShieldCheck, ShieldAlert, ShieldX, X, MessageSquare, Sparkles, Folder, File } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api';
import { isTauri } from '../env';
import { useStore } from '../store';
import { formatBytes } from '../format';
import { freeChat, overviewChat } from '../advisorClient';
import type { Node, AdvisorRequest, AdvisorResponse, Scaffold } from '../types';

function uid() {
  return Math.random().toString(36).slice(2);
}

function findNodeByPath(root: Node | null, path: string): Node | null {
  if (!root) return null;
  if (root.path === path) return root;
  for (const c of root.children) {
    const f = findNodeByPath(c, path);
    if (f) return f;
  }
  return null;
}

function buildOverviewSummary(root: Node) {
  const flatten = (n: Node, depth: number, out: { path: string; name: string; size: number; depth: number; is_dir: boolean }[]) => {
    if (depth > 0) {
      out.push({ path: n.path, name: n.name, size: n.size, depth, is_dir: n.is_dir });
    }
    if (depth < 2) {
      for (const c of n.children ?? []) flatten(c, depth + 1, out);
    }
  };
  const all: { path: string; name: string; size: number; depth: number; is_dir: boolean }[] = [];
  flatten(root, 0, all);
  all.sort((a, b) => b.size - a.size);
  const top = all.slice(0, 25).map((x) => ({
    path: x.path,
    name: x.name,
    size_human: formatBytes(x.size),
    size_bytes: x.size,
    depth: x.depth,
    kind: x.is_dir ? 'dir' : 'file',
  }));
  return {
    root: root.path,
    total_size_human: formatBytes(root.size),
    total_files: root.file_count,
    top_entries: top,
  };
}

export function ChatPanel() {
  const root = useStore((s) => s.root);
  const chat = useStore((s) => s.chat);
  const pushTurn = useStore((s) => s.pushChatTurn);
  const patchTurn = useStore((s) => s.patchChatTurn);
  const setBusy = useStore((s) => s.setChatBusy);
  const resetChat = useStore((s) => s.resetChat);
  const scaffolds = useStore((s) => s.scaffolds);
  const addReclaimed = useStore((s) => s.addReclaimed);
  const studioRequest = useStore((s) => s.studioRequest);
  const consumeStudio = useStore((s) => s.consumeStudio);

  const [input, setInput] = useState('');
  const [pendingDrops, setPendingDrops] = useState<{ path: string; name: string }[]>([]);
  const [dropping, setDropping] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const overviewFiredFor = useRef<string | null>(null);

  const node = chat.node;
  const scaffold: Scaffold | null = useMemo(
    () => (chat.scaffoldId ? scaffolds.find((s) => s.id === chat.scaffoldId) ?? null : null),
    [chat.scaffoldId, scaffolds],
  );

  // Auto-fire overview the moment scan finishes, once per scan.
  useEffect(() => {
    if (!root) return;
    if (overviewFiredFor.current === root.path) return;
    overviewFiredFor.current = root.path;
    runOverview(root);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root?.path]);

  // No more auto-advice on node change — the user runs ONE conversation,
  // dropped items become pending pills until they send.

  // Handle Studio card clicks — synthesize a prompt about the scaffold.
  useEffect(() => {
    if (!studioRequest) return;
    const sc = scaffolds.find((s) => s.id === studioRequest.scaffoldId);
    consumeStudio();
    if (!sc) return;
    runStudioPrompt(sc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studioRequest?.ts]);

  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: 'smooth' });
  }, [chat.turns.length, chat.busy]);

  const findScaffoldNode = (sc: Scaffold): Node | null => {
    if (!root) return null;
    const dfs = (n: Node): Node | null => {
      if (n.scaffold_id === sc.id) return n;
      for (const c of n.children) {
        const f = dfs(c);
        if (f) return f;
      }
      return null;
    };
    return dfs(root);
  };

  const runStudioPrompt = async (sc: Scaffold) => {
    const matched = findScaffoldNode(sc);

    // Phrase the question from the user's POV: they're looking at the right-
    // side card and asking "what's actually in this thing".
    const userText = matched
      ? `右侧显示扫描里检测到了【${sc.name}】(${formatBytes(matched.size)}, \`${matched.path}\`)。这个文件夹里具体都是什么？哪些是可以删的？`
      : `右侧的【${sc.name}】这次扫描里没扫到。它一般会在哪些路径下？里面通常存什么？`;
    pushTurn({ id: uid(), role: 'user', text: userText });

    setBusy(true);
    const turnId = uid();
    pushTurn({ id: turnId, role: 'assistant', text: `正在分析 ${sc.name}…`, pending: true, scaffoldId: sc.id });
    try {
      const samples = matched && matched.is_dir
        ? await api.inspect(matched.path, 25).catch(() => [] as string[])
        : [];
      const ctx = {
        app: sc.name,
        scaffold_id: sc.id,
        risk: sc.risk,
        disclaimer: sc.disclaimer,
        declared_paths: sc.detect,
        cleanable_scopes: sc.scopes.map((s) => ({ id: s.id, label: s.label, mode: s.mode, glob: s.glob })),
        scanned_match: matched
          ? {
              path: matched.path,
              size: formatBytes(matched.size),
              file_count: matched.file_count,
              top_extensions: (matched.top_extensions ?? []).slice(0, 6),
              top_children: (matched.children ?? []).slice(0, 12).map((c) => ({
                name: c.name,
                size: formatBytes(c.size),
                is_dir: c.is_dir,
              })),
              sample_paths: samples,
            }
          : null,
      };
      const reply = await freeChat(
        `用户在 Studio 里点了【${sc.name}】这张卡片。下面是这个清理脚本的元数据，以及本次扫描中真实匹配到的目录（含子项 + 抽样路径，如果扫到了的话）：\n${JSON.stringify(ctx, null, 2)}`,
        userText,
      );
      patchTurn(turnId, { text: reply, pending: false });
    } catch (e) {
      patchTurn(turnId, { text: `AI 调用失败：${String(e)}`, pending: false });
    } finally {
      setBusy(false);
    }
  };

  const runOverview = async (r: Node) => {
    setBusy(true);
    const turnId = uid();
    pushTurn({
      id: turnId,
      role: 'assistant',
      text: `已扫完 ${r.path} · ${formatBytes(r.size)} · ${r.file_count.toLocaleString()} 个文件。AI 正在生成整体解析…`,
      pending: true,
    });
    try {
      const summary = buildOverviewSummary(r);
      const reply = await overviewChat(summary);
      patchTurn(turnId, { text: reply, pending: false });
    } catch (e) {
      patchTurn(turnId, {
        text: `（AI 总览失败：${String(e)}）\n你可以从左边把任意文件夹/文件拖进来问。`,
        pending: false,
      });
    } finally {
      setBusy(false);
    }
  };

  const runInitialAdvice = async (n: Node) => {
    setBusy(true);
    if (chat.scaffoldId) {
      const known = scaffolds.find((s) => s.id === chat.scaffoldId);
      if (known) {
        pushTurn({
          id: uid(),
          role: 'assistant',
          text: `已识别为 ${known.name}。${known.disclaimer}`,
          scaffoldId: known.id,
        });
      }
    }
    const turnId = uid();
    pushTurn({ id: turnId, role: 'assistant', text: `分析 ${n.name || n.path} 中…`, pending: true });
    try {
      const totalBytes = n.size || 1;
      const top = (n.top_extensions ?? [])
        .slice(0, 6)
        .map((e) => ({ ext: e.ext, share: e.bytes / totalBytes }));
      const samples = n.is_dir
        ? await api.inspect(n.path, 20).catch(() => [] as string[])
        : [];
      const req: AdvisorRequest = {
        path: n.path,
        size_bytes: n.size,
        file_count: n.file_count,
        top_extensions: top,
        sample_paths: samples,
        neighbors: (n.children ?? []).slice(0, 12).map((c) => c.name),
        scaffold_hint: chat.scaffoldId ?? null,
      };
      const advice = await api.advise(req);
      patchTurn(turnId, {
        text: `${advice.what}\n\n${advice.reasoning}`,
        advice,
        scaffoldId: advice.suggested_scaffold ?? chat.scaffoldId,
        pending: false,
      });
    } catch (e) {
      patchTurn(turnId, { text: `AI 调用失败：${String(e)}`, pending: false });
    } finally {
      setBusy(false);
    }
  };

  const askFollowUp = async () => {
    const text = input.trim();
    if (!text && pendingDrops.length === 0) return;
    if (!root) return;
    setInput('');
    const drops = pendingDrops.slice();
    setPendingDrops([]);

    const userText = drops.length > 0
      ? `${text}${text ? '\n' : ''}（关于：${drops.map((d) => d.path).join('、')}）`
      : text;
    pushTurn({ id: uid(), role: 'user', text: userText });
    setBusy(true);
    const turnId = uid();
    pushTurn({ id: turnId, role: 'assistant', text: '思考中…', pending: true });

    try {
      const targets = drops.length > 0
        ? drops.map((d) => findNodeByPath(root, d.path)).filter(Boolean) as Node[]
        : node ? [node] : [];

      const ctx = targets.map((t) => ({
        path: t.path,
        name: t.name,
        size: formatBytes(t.size),
        is_dir: t.is_dir,
        file_count: t.file_count,
        top_extensions: (t.top_extensions ?? []).slice(0, 6),
        sample_children: (t.children ?? []).slice(0, 8).map((c) => ({ name: c.name, size: formatBytes(c.size), is_dir: c.is_dir })),
      }));
      const reply = await freeChat(`目标对象：${JSON.stringify(ctx, null, 2)}`, text || '这些是什么？能不能删？');
      patchTurn(turnId, { text: reply, pending: false });

      // No refocus — keep the conversation continuous. Dropped items live as pills only.
    } catch (e) {
      patchTurn(turnId, { text: `AI 调用失败：${String(e)}`, pending: false });
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const path = e.dataTransfer.getData('application/x-diskwise-path');
    const name = e.dataTransfer.getData('application/x-diskwise-name') || path.split(/[\\/]/).pop() || path;
    if (!path) return;
    // Just stage a pending pill — do NOT reset the conversation or refocus the
    // chat node. The user keeps one continuous conversation and asks across
    // multiple dropped items.
    setPendingDrops((prev) => (prev.find((p) => p.path === path) ? prev : [...prev, { path, name }]));
  };

  const recycleNode = async (target: Node, reason: string) => {
    try {
      await api.execute({ action: 'recycle', paths: [target.path], reason }, false);
      addReclaimed(target.size);
      pushTurn({ id: uid(), role: 'system', text: `已回收 ${target.path} · 释放 ${formatBytes(target.size)}` });
    } catch (e) {
      pushTurn({ id: uid(), role: 'system', text: `回收失败：${String(e)}` });
    }
  };

  const empty = chat.turns.length === 0;

  return (
    <div
      className={'chat' + (dropping ? ' drop-target' : '')}
      onDragOver={(e) => { e.preventDefault(); setDropping(true); }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      <div className="chat-head">
        <Sparkles size={15} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="chat-title">
            {root ? (root.name || root.path) : 'Diskwise AI'}
          </div>
          <div className="chat-sub">
            {root
              ? `${root.path} · ${formatBytes(root.size)} · ${root.file_count.toLocaleString()} 文件`
              : '扫一个磁盘，AI 自动给整体解析'}
          </div>
        </div>
        {chat.turns.length > 0 && (
          <button className="ghost icon" onClick={resetChat} title="清空"><X size={16} /></button>
        )}
      </div>

      <div className="chat-scroll" ref={scrollerRef}>
        {empty && !root && (
          <div className="chat-hero">
            <MessageSquare size={32} />
            <h3>Diskwise AI</h3>
            <p>选一个磁盘 → 点扫描 → AI 自动给整体解析。<br />扫完之后，可以把左边的任意文件 / 文件夹拖进来问。</p>
            {!isTauri && <p className="muted">浏览器预览模式：扫描数据是模拟的，但 AI 会走真实接口。</p>}
          </div>
        )}
        {empty && root && (
          <div className="chat-hero">
            <Sparkles size={28} />
            <p>AI 正在生成整体解析…</p>
          </div>
        )}
        {chat.turns.map((t) => (
          <div key={t.id} className={'chat-turn ' + t.role + (t.pending ? ' pending' : '')}>
            {t.role === 'assistant' && t.advice && <AdviceCard advice={t.advice} />}
            <div className="chat-bubble">
              {t.role === 'assistant'
                ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{t.text}</ReactMarkdown>
                : t.text}
            </div>
            {t.role === 'assistant' && t.advice?.action === 'recycle' && !t.advice?.needs_inspection && node && (
              <div className="chat-actions">
                <button className="primary" onClick={() => recycleNode(node, t.advice?.reasoning ?? 'AI suggested')}>
                  <Trash2 size={13} /> 回收 {formatBytes(node.size)}
                </button>
              </div>
            )}
          </div>
        ))}
        {chat.busy && <div className="chat-typing">AI 正在打字…</div>}
      </div>

      <div className="chat-input-wrap">
        {pendingDrops.length > 0 && (
          <div className="chat-pills">
            {pendingDrops.map((d) => (
              <span key={d.path} className="chat-pill" title={d.path}>
                {d.path.endsWith(d.name) && d.path !== d.name ? <Folder size={11} /> : <File size={11} />}
                {d.name}
                <button onClick={() => setPendingDrops((prev) => prev.filter((p) => p.path !== d.path))}><X size={11} /></button>
              </span>
            ))}
          </div>
        )}
        <div className="chat-input">
          <textarea
            rows={2}
            placeholder={root ? '问 AI：这是什么？能删吗？把文件拖进来对比…' : '先选一个磁盘开始扫描'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                askFollowUp();
              }
            }}
            disabled={!root}
          />
          <button
            className="primary"
            onClick={askFollowUp}
            disabled={(!input.trim() && pendingDrops.length === 0) || chat.busy || !root}
          >
            <Send size={14} /> 发送
          </button>
        </div>
      </div>
    </div>
  );
}

function AdviceCard({ advice }: { advice: AdvisorResponse }) {
  const Icon = advice.risk === 'low' ? ShieldCheck : advice.risk === 'medium' ? ShieldAlert : ShieldX;
  const color = advice.risk === 'low' ? '#5fcf95' : advice.risk === 'medium' ? '#ffb37a' : '#ff5d7a';
  return (
    <div className="advice-pill" style={{ borderColor: color }}>
      <Icon size={14} style={{ color }} />
      <strong>{advice.category}</strong>
      <span className="badge">{advice.action}</span>
      <span className="muted">风险 {advice.risk}</span>
      {advice.needs_inspection && <span className="badge">需要再看看</span>}
    </div>
  );
}

