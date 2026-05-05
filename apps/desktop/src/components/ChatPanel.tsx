import { useEffect, useRef, useState } from 'react';
import { Send, Trash2, ShieldCheck, ShieldAlert, ShieldX, X, MessageSquare, Sparkles, Folder, File, ImagePlus } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api';
import { isTauri } from '../env';
import { useStore } from '../store';
import { formatBytes } from '../format';
import { freeChat, overviewChat } from '../advisorClient';
import type { Node, AdvisorResponse, Scaffold } from '../types';

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
  const [pendingImages, setPendingImages] = useState<{ id: string; name: string; dataUrl: string; mimeType: string }[]>([]);
  const [dropping, setDropping] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const overviewFiredFor = useRef<string | null>(null);

  const node = chat.node;

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

  // Walk root, collect ALL nodes tagged with this scaffold. Mirrors Studio's
  // findAllMatchesByScaffold — a scaffold legitimately matches in multiple
  // places (e.g. wechat-pc hits Documents\WeChat Files + AppData\Roaming\Tencent\WeChat
  // + ProgramData\Tencent\WeChat etc.). We don't recurse into a subtree that
  // already matched, so each match is the topmost root of its scaffold-tagged
  // region — sizes/children are disjoint by construction.
  const findAllScaffoldNodes = (sc: Scaffold): Node[] => {
    if (!root) return [];
    const out: Node[] = [];
    const dfs = (n: Node) => {
      if (n.scaffold_id === sc.id) { out.push(n); return; }
      for (const c of n.children ?? []) dfs(c);
    };
    dfs(root);
    out.sort((a, b) => b.size - a.size);
    return out;
  };

  const runStudioPrompt = async (sc: Scaffold) => {
    const matches = findAllScaffoldNodes(sc);
    const totalSize = matches.reduce((s, m) => s + m.size, 0);
    const totalFiles = matches.reduce((s, m) => s + m.file_count, 0);

    // Phrase the question from the user's POV: they're looking at the right-
    // side card and asking "what's actually in this thing across ALL matched
    // locations". Important: don't pick a single path — wechat-pc has 5
    // legitimate locations, and earlier we were sending only the first DFS hit
    // which was sometimes the empty Temp\WeChat Files folder.
    const userText = matches.length === 0
      ? `右侧的【${sc.name}】这次扫描里没扫到。它一般会在哪些路径下？里面通常存什么？`
      : matches.length === 1
        ? `右侧显示扫描里检测到了【${sc.name}】(${formatBytes(totalSize)}, \`${matches[0].path}\`)。这个文件夹里具体都是什么？哪些是可以删的？`
        : `右侧扫描里检测到了【${sc.name}】，分布在 ${matches.length} 个位置，合计 ${formatBytes(totalSize)} / ${totalFiles.toLocaleString()} 文件：\n${matches.map((m) => `- \`${m.path}\` (${formatBytes(m.size)})`).join('\n')}\n\n这些文件夹各自都是什么？哪些是可以删的？`;
    pushTurn({ id: uid(), role: 'user', text: userText });

    setBusy(true);
    const turnId = uid();
    pushTurn({ id: turnId, role: 'assistant', text: `正在分析 ${sc.name}…`, pending: true, scaffoldId: sc.id });
    try {
      // Sample each match (cap 8 paths per match → 24-40 total samples for
      // typical 3-5 location scaffolds). Drop the empty roots so the AI doesn't
      // spend tokens on "and there's an empty folder too".
      const nonEmpty = matches.filter((m) => m.size > 0 || (m.children?.length ?? 0) > 0);
      const sampledMatches = await Promise.all(
        nonEmpty.map(async (m) => {
          const samples = m.is_dir
            ? await api.inspect(m.path, 8).catch(() => [] as string[])
            : [];
          return {
            path: m.path,
            size: formatBytes(m.size),
            file_count: m.file_count,
            top_extensions: (m.top_extensions ?? []).slice(0, 5),
            top_children: (m.children ?? []).slice(0, 8).map((c) => ({
              name: c.name,
              size: formatBytes(c.size),
              is_dir: c.is_dir,
            })),
            sample_paths: samples,
          };
        }),
      );
      const ctx = {
        app: sc.name,
        scaffold_id: sc.id,
        risk: sc.risk,
        disclaimer: sc.disclaimer,
        declared_paths: sc.detect,
        cleanable_scopes: sc.scopes.map((s) => ({ id: s.id, label: s.label, mode: s.mode, glob: s.glob })),
        scanned_matches: sampledMatches,
        scanned_total: matches.length > 0
          ? { location_count: matches.length, total_size: formatBytes(totalSize), total_files: totalFiles }
          : null,
      };
      const reply = await freeChat(
        `用户在 Studio 里点了【${sc.name}】这张卡片。下面是这个清理脚本的元数据，以及本次扫描中匹配到的所有位置（每个位置含 top children + 抽样路径）。请按位置分别说明里面是什么、哪些可以删、用什么方式删——不要只挑一个位置说：\n${JSON.stringify(ctx, null, 2)}`,
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

  const askFollowUp = async () => {
    const text = input.trim();
    if (!text && pendingDrops.length === 0 && pendingImages.length === 0) return;
    if (!root && pendingImages.length === 0) return;
    setInput('');
    const drops = pendingDrops.slice();
    const images = pendingImages.slice();
    setPendingDrops([]);
    setPendingImages([]);

    const dropDesc = drops.length > 0 ? `（关于：${drops.map((d) => d.path).join('、')}）` : '';
    const imgDesc = images.length > 0 ? `（带 ${images.length} 张图片）` : '';
    const userText = [text, dropDesc, imgDesc].filter(Boolean).join('\n');
    pushTurn({ id: uid(), role: 'user', text: userText });
    setBusy(true);
    const turnId = uid();
    pushTurn({ id: turnId, role: 'assistant', text: '思考中…', pending: true });

    try {
      const targets = drops.length > 0 && root
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
      const contextLine = ctx.length > 0 ? `目标对象：${JSON.stringify(ctx, null, 2)}` : '';
      const reply = await freeChat(
        contextLine,
        text || (images.length > 0 ? '看看这张图，告诉我是什么、能不能删。' : '这些是什么？能不能删？'),
        images.length > 0 ? images.map((i) => ({ dataUrl: i.dataUrl, mimeType: i.mimeType })) : undefined,
      );
      patchTurn(turnId, { text: reply, pending: false });
    } catch (e) {
      patchTurn(turnId, { text: `AI 调用失败：${String(e)}`, pending: false });
    } finally {
      setBusy(false);
    }
  };

  const fileToDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(r.error);
      r.onload = () => resolve(r.result as string);
      r.readAsDataURL(file);
    });

  const addImageFile = async (file: File) => {
    if (!file.type.startsWith('image/')) return;
    if (file.size > 20 * 1024 * 1024) {
      pushTurn({ id: uid(), role: 'system', text: `图片 ${file.name} 太大（>20MB），跳过` });
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      setPendingImages((prev) => [
        ...prev,
        { id: uid(), name: file.name || 'image', dataUrl, mimeType: file.type || 'image/png' },
      ]);
    } catch (e) {
      pushTurn({ id: uid(), role: 'system', text: `读取图片失败：${String(e)}` });
    }
  };

  const onPaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f && f.type.startsWith('image/')) {
          e.preventDefault();
          await addImageFile(f);
        }
      }
    }
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropping(false);
    // Image file drop (from filesystem / browser): take precedence over the
    // internal Pinkbin path drop, since paths come with our custom mime type.
    const files = Array.from(e.dataTransfer.files ?? []).filter((f) => f.type.startsWith('image/'));
    if (files.length > 0) {
      for (const f of files) await addImageFile(f);
      return;
    }
    const path = e.dataTransfer.getData('application/x-pinkbin-path');
    const name = e.dataTransfer.getData('application/x-pinkbin-name') || path.split(/[\\/]/).pop() || path;
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
            {root ? (root.name || root.path) : 'Pinkbin AI'}
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
            <h3>Pinkbin AI</h3>
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
        {pendingImages.length > 0 && (
          <div className="chat-image-pills">
            {pendingImages.map((img) => (
              <span key={img.id} className="chat-image-pill" title={img.name}>
                <img src={img.dataUrl} alt={img.name} />
                <button
                  type="button"
                  onClick={() => setPendingImages((prev) => prev.filter((p) => p.id !== img.id))}
                ><X size={11} /></button>
              </span>
            ))}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={async (e) => {
            const files = Array.from(e.target.files ?? []);
            for (const f of files) await addImageFile(f);
            if (fileInputRef.current) fileInputRef.current.value = '';
          }}
        />
        <div className="chat-input">
          <button
            type="button"
            className="ghost icon chat-attach"
            onClick={() => fileInputRef.current?.click()}
            title="加图片（也可以粘贴/拖进来）"
            disabled={chat.busy}
          >
            <ImagePlus size={15} />
          </button>
          <textarea
            rows={2}
            placeholder={root ? '问 AI：这是什么？能删吗？把文件 / 图片拖进来…（图片粘贴也行）' : '先选一个磁盘开始扫描，或贴张图片直接问'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                askFollowUp();
              }
            }}
            disabled={!root && pendingImages.length === 0}
          />
          <button
            className="primary"
            onClick={askFollowUp}
            disabled={
              (!input.trim() && pendingDrops.length === 0 && pendingImages.length === 0) ||
              chat.busy ||
              (!root && pendingImages.length === 0)
            }
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

