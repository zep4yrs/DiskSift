import { useEffect, useState } from 'react';
import { Check, Copy, ShieldAlert, X } from 'lucide-react';
import type { Node } from '../types';
import { api } from '../api';
import { freeChat } from '../advisorClient';
import { checkScaffoldRedlines, DRAFT_SYSTEM_PROMPT } from '../triage-ai';

// 「让 AI 起草脚本」弹窗（triage-overlay-spec §5.1）：对可清理但无脚本覆盖的
// 目录，AI 按 14-phase 裁剪版起草用户级 scaffold，自动跑红线检查（CLAUDE.md
// 硬规则 1 的前端实现，见 triage-ai.checkScaffoldRedlines）——过线展示草稿，
// 不过线直接拒绝并逐条说明原因。
// 落盘限制：后端暂无「保存到用户脚本目录」的写盘命令，过线后提供复制内容 +
// 粘贴指引（面板内如实标注），不伪造保存按钮。
// 隐私：发给 AI 的只有目录元数据（路径/大小/文件数/扩展名分布/≤20 条抽样路径）。

type Phase = 'drafting' | 'ready' | 'refused' | 'error';

function stripFence(s: string): string {
  let t = s.trim();
  if (t.startsWith('```toml')) t = t.slice(7);
  else if (t.startsWith('```')) t = t.slice(3);
  if (t.endsWith('```')) t = t.slice(0, -3);
  return t.trim();
}

export function DraftScaffoldModal({ node, onClose }: { node: Node; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('drafting');
  const [toml, setToml] = useState('');
  const [violations, setViolations] = useState<string[]>([]);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const samples = await api.inspect(node.path, 20).catch(() => [] as string[]);
        const totalBytes = node.size || 1;
        const meta = {
          path: node.path,
          size_bytes: node.size,
          file_count: node.file_count,
          top_extensions: node.top_extensions.slice(0, 6).map((e) => ({ ext: e.ext, share: e.bytes / totalBytes })),
          sample_paths: samples,
          neighbors: node.children.slice(0, 6).map((c) => c.name),
        };
        const draft = await freeChat(
          DRAFT_SYSTEM_PROMPT,
          '目录元数据：\n' + JSON.stringify(meta, null, 2) + '\n\n请按上述裁剪版步骤为该目录起草 scaffold，只输出 TOML 源码。',
        );
        if (cancelled) return;
        const stripped = stripFence(draft);
        const v = checkScaffoldRedlines(stripped);
        if (v.length > 0) {
          setViolations(v);
          setPhase('refused');
        } else {
          setToml(stripped);
          setPhase('ready');
        }
      } catch (e) {
        if (!cancelled) {
          setErrMsg(String(e));
          setPhase('error');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [node]);

  const copy = () => {
    navigator.clipboard?.writeText(toml)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="card draft-modal" onClick={(e) => e.stopPropagation()}>
        <div className="draft-head">
          <span className="sec-title">让 AI 起草脚本 · {node.name || node.path}</span>
          <button className="bdc-close" aria-label="关闭起草窗口" title="关闭" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {phase === 'drafting' && (
          <p className="muted">AI 正在按 14-phase 裁剪版起草 scaffold，起草后会自动跑红线检查…</p>
        )}

        {phase === 'error' && (
          <>
            <div className="error">起草失败：{errMsg}</div>
            <p className="muted">可检查 AI 配置后重试；本操作只发送目录元数据，不读文件内容。</p>
          </>
        )}

        {phase === 'refused' && (
          <>
            <div className="draft-refused">
              <ShieldAlert size={15} />
              <b>红线检查未通过，已拒绝保存</b>
            </div>
            <ul className="draft-violations">
              {violations.map((v, i) => <li key={i}>{v}</li>)}
            </ul>
            <p className="muted">
              红线区域（聊天记录 / 账号 / 收藏 / 加密物料）永远不会被任何 scope 命中——
              这是不可逾越的硬约束，与 AI 无关。
            </p>
          </>
        )}

        {phase === 'ready' && (
          <>
            <div className="draft-passed">
              <Check size={15} />
              红线检查通过
            </div>
            <pre className="draft-pre">{toml}</pre>
            <div className="overview-actions">
              <button className="btn" onClick={copy}>
                <Copy size={13} /> {copied ? '已复制' : '复制内容'}
              </button>
            </div>
            <p className="muted">
              保存方式：粘贴为用户脚本目录下的 <code>{'{id}'}.toml</code> 并重启——
              应用内暂无直接写盘的保存命令（后端命令缺位），故不提供一键保存。
            </p>
          </>
        )}

        <div className="overview-actions">
          <button className="btn ghost" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
