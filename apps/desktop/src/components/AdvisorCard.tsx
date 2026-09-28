import { ShieldCheck, ShieldAlert, ShieldX, Loader2, Trash2, FolderInput, X, Lock } from 'lucide-react';
import { useState } from 'react';
import type { Node, AdvisorResponse, Plan } from '../types';
import { formatBytes } from '../format';
import { isNeverTouch } from '../triage';
import { api } from '../api';
import { useStore } from '../store';

type Props = {
  node: Node;
  advice: AdvisorResponse | null;
  onComplete: (reclaimedBytes: number) => void;
  onSkip: () => void;
  onInspect: () => Promise<void>;
};

export function AdvisorCard({ node, advice, onComplete, onSkip, onInspect }: Props) {
  const [busy, setBusy] = useState(false);
  const [inspectBusy, setInspectBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const addQuarantined = useStore((s) => s.addQuarantined);
  // v26.1.2 高危修复 · UI 守卫：NEVER_TOUCH 目录不给任何破坏性动作。
  // 队列源头已过滤（buildWalkQueue），这里是残留兜底——旧会话的队列、
  // 或未来新增的入队路径漏进来的系统目录，卡片上连「进回收站/隔离/删」
  // 按钮都不渲染，更不发起 advise。
  const protectedDir = isNeverTouch(node.path);

  const ShieldIcon = !advice
    ? Loader2
    : advice.risk === 'low'
      ? ShieldCheck
      : advice.risk === 'medium'
        ? ShieldAlert
        : ShieldX;

  // §1-B：风险色走语义令牌（--risk-* 桥 --ok/--warn/--danger），unknown 落 --fg-muted
  const accent =
    advice?.risk === 'low' ? 'var(--risk-low)' : advice?.risk === 'medium' ? 'var(--risk-med)' : advice?.risk === 'high' ? 'var(--risk-high)' : 'var(--fg-muted)';

  const act = async (action: 'recycle' | 'quarantine' | 'delete') => {
    setBusy(true);
    setErr(null);
    try {
      const plan: Plan = {
        action,
        paths: [node.path],
        reason: advice?.reasoning ?? `DiskSift auto-walk: ${node.path}`,
      };
      await api.execute(plan, false);
      // f2-3：隔离不释放空间——不计入「已释放」字节，改计「已隔离 N 项」。
      if (action === 'quarantine') {
        addQuarantined(1);
        onComplete(0);
      } else {
        onComplete(node.size);
      }
    } catch (e: unknown) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ borderColor: accent }}>
      <div className="card-head">
        <ShieldIcon size={18} className={!advice ? 'spin' : ''} style={{ color: accent }} />
        <div className="card-title">
          <div className="card-name" title={node.path}>{node.name}</div>
          <div className="card-path">{node.path}</div>
        </div>
        <button className="ghost icon" onClick={onSkip} title="Skip"><X size={16} /></button>
      </div>

      <div className="card-meta">
        <strong>{formatBytes(node.size)}</strong>
        <span>· {node.file_count.toLocaleString()} 个文件</span>
        {advice?.suggested_scaffold && <span>· 建议脚本：<code>{advice.suggested_scaffold}</code></span>}
      </div>

      {!protectedDir && !advice ? (
        <div className="card-body muted">AI 思考中…</div>
      ) : !protectedDir && advice ? (
        <>
          <div className="card-what"><strong>这是什么：</strong> {advice.what}</div>
          <div className="card-reason">{advice.reasoning}</div>
          {advice.needs_inspection && (
            <button
              className="ghost full"
              disabled={inspectBusy}
              onClick={async () => {
                // f2-2：深检此前无 busy/错误反馈——AI 复查在途可反复点击，
                // 失败只是未处理的 rejection。busy 锁 + 文案切换 + 错误落卡片
                // （setErr 在本组件，AutoWalk 的 onInspect 保持抛出由这里接）。
                setInspectBusy(true);
                setErr(null);
                try {
                  await onInspect();
                } catch (e) {
                  setErr(`AI 复查失败：${String(e)}`);
                } finally {
                  setInspectBusy(false);
                }
              }}
            >
              {inspectBusy
                ? <><Loader2 size={12} className="spin" /> AI 思考中…</>
                : '让 AI 看更深（抽样子路径再判一次）'}
            </button>
          )}
        </>
      ) : (
        <div className="card-body muted"><Lock size={13} style={{ verticalAlign: -2 }} /> 系统目录，绝对不动（NEVER_TOUCH 保护区）</div>
      )}

      {err && <div className="error">{err}</div>}

      {protectedDir ? (
        <div className="card-actions">
          <button className="ghost" onClick={onSkip}>跳过</button>
        </div>
      ) : (
        <div className="card-actions">
          <button className="primary" disabled={busy || !advice} onClick={() => act('recycle')}>
            <Trash2 size={14} /> 进回收站（{formatBytes(node.size)}）
          </button>
          <button className="secondary" disabled={busy || !advice} onClick={() => act('quarantine')}>
            <FolderInput size={14} /> 隔离
          </button>
          <button className="ghost" disabled={busy} onClick={onSkip}>保留</button>
        </div>
      )}
    </div>
  );
}
