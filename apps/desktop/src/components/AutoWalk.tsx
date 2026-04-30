import { useEffect } from 'react';
import { ChevronRight, Pause } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store';
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
  const addReclaimed = useStore((s) => s.addReclaimed);
  const scaffolds = useStore((s) => s.scaffolds);

  const item = walk[i];
  const scaffold = item?.scaffoldId ? scaffolds.find((s) => s.id === item.scaffoldId) ?? null : null;

  useEffect(() => {
    if (!item || scaffold || item.advice || item.status === 'advising' || item.status === 'done') return;
    let cancelled = false;
    patch(i, { status: 'advising' });
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
