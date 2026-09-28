import { useEffect } from 'react';
import { ChevronRight, Pause } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store';
import { isNeverTouch } from '../triage';
import { AdvisorCard } from './AdvisorCard';
import { ScaffoldPanel } from './ScaffoldPanel';
import { formatBytes } from '../format';
import type { AdvisorRequest } from '../types';

export function AutoWalk() {
  const walk = useStore((s) => s.walkQueue);
  const i = useStore((s) => s.walkIndex);
  const advance = useStore((s) => s.advanceWalk);
  const patch = useStore((s) => s.patchWalkItem);
  const reclaimed = useStore((s) => s.reclaimedBytes);
  const quarantinedCount = useStore((s) => s.quarantinedCount);
  const addReclaimed = useStore((s) => s.addReclaimed);
  const scaffolds = useStore((s) => s.scaffolds);

  const item = walk[i];
  const scaffold = item?.scaffoldId ? scaffolds.find((s) => s.id === item.scaffoldId) ?? null : null;

  useEffect(() => {
    if (!item || scaffold || item.advice || item.status === 'done') return;
    // v26.1.2 高危修复：NEVER_TOUCH 保护区不发起 advise（元数据也不外发），
    // 卡片由 AdvisorCard 的 protected 分支接管。
    if (isNeverTouch(item.node.path)) return;
    let cancelled = false;
    // 为什么不在请求前 patch status = 'advising'：那会改掉 walkQueue[i] 的对象
    // 身份，触发本 effect 重跑并把在途请求 cleanup 掉（cancelled = true），
    // 结果永远无法落地，卡片停在「AI 思考中…」。
    (async () => {
      try {
        const totalBytes = item.node.size || 1;
        const top = item.node.top_extensions
          .slice(0, 6)
          .map((e) => ({ ext: e.ext, share: e.bytes / totalBytes }));
        const samples = await api.inspect(item.node.path, 20).catch(() => [] as string[]);
        const req: AdvisorRequest = {
          path: item.node.path,
          size_bytes: item.node.size,
          file_count: item.node.file_count,
          top_extensions: top,
          sample_paths: samples,
          neighbors: item.node.children.slice(0, 6).map((c) => c.name),
          scaffold_hint: item.scaffoldId ?? null,
        };
        const advice = await api.advise(req);
        if (!cancelled) patch(i, { advice, status: 'ready' });
      } catch (e) {
        if (!cancelled) patch(i, { status: 'ready', advice: { what: 'Advisor unavailable', category: 'unknown', safe_to_delete: false, risk: 'medium', action: 'keep', reasoning: String(e), needs_inspection: false } });
      }
    })();
    return () => { cancelled = true; };
  }, [i, item, scaffold]);

  if (!item) {
    return (
      <div className="walk empty">
        <div className="empty-title">巡查待启动</div>
        <div className="empty-sub">先扫描，然后点 <strong>开始巡查</strong>。</div>
      </div>
    );
  }

  const progress = `${i + 1} / ${walk.length}`;

  return (
    <div className="walk">
      <div className="walk-bar">
        <div>正在审阅 <strong>{progress}</strong></div>
        <div>已释放 <strong>{formatBytes(reclaimed)}</strong></div>
        {/* f2-3：隔离不释放空间，按件数单独展示 */}
        {quarantinedCount > 0 && <div>已隔离 <strong>{quarantinedCount}</strong> 项</div>}
        <button className="ghost" onClick={() => advance()} title="Skip">
          <Pause size={14} /> 跳过
        </button>
      </div>

      {scaffold ? (
        <ScaffoldPanel
          node={item.node}
          scaffold={scaffold}
          onComplete={(b) => { addReclaimed(b); patch(i, { status: 'done' }); advance(); }}
          onSkip={() => { patch(i, { status: 'skipped' }); advance(); }}
        />
      ) : (
        <AdvisorCard
          node={item.node}
          advice={item.advice ?? null}
          onComplete={(b) => { addReclaimed(b); patch(i, { status: 'done' }); advance(); }}
          onSkip={() => { patch(i, { status: 'skipped' }); advance(); }}
          onInspect={async () => {
            const samples = await api.inspect(item.node.path, 50);
            const totalBytes = item.node.size || 1;
            const advice = await api.advise({
              path: item.node.path,
              size_bytes: item.node.size,
              file_count: item.node.file_count,
              top_extensions: item.node.top_extensions.slice(0, 6).map((e) => ({ ext: e.ext, share: e.bytes / totalBytes })),
              sample_paths: samples,
              neighbors: item.node.children.slice(0, 12).map((c) => c.name),
              scaffold_hint: item.scaffoldId ?? null,
            });
            patch(i, { advice });
          }}
        />
      )}

      <div className="walk-foot">
        <button className="ghost" onClick={() => advance()}>
          下一个 <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}
