import { useEffect, useRef } from 'react';
import { isTauri } from './env';
import { mockListen } from './mocks';
import { useStore, type MonitorDelta } from './store';
import type { MigratePhase, UsnChangeDir, UsnStatePayload } from './types';

// ── 实时监控接线（v26.1.4.0 §1.2，规格 docs/release-plan-26.1.4.0.md §1）────
// 全应用【只挂一次】（App.tsx）：订阅 'usn://changes' / 'usn://state'（桌面走
// Tauri listen，浏览器走 mocks.mockListen 假事件通道），把聚合变更喂给
// store.applyMonitorChanges（脏目录 size/file_count 增量 + dirty 标记），状态
// 事件写 store（降级原因 / 积压「建议重扫」）。状态行数据（events_per_sec /
// last_refresh）由本 hook 在有卷监控中时每 2s 轮询 monitor_status 刷新。
//
// 事件回调整应用的副作用都走 store / onApplied 回调，本组件零自有 UI。
// 红线：监控只读——这里只改内存树的数值与标记，不动任何文件系统状态。

/** useMonitor 的装配选项：onApplied 在增量写回后同步调用（App 做判定缓存维护：
 *  「判定缓存不失效，跨桶阈值才重算该条」）。 */
type Opts = {
  onApplied?: (deltas: MonitorDelta[]) => void;
};

/** 积压降级的后端 reason 关键词（crates/monitor/src/journal.rs:666）。 */
const BACKLOG_MARK = '建议重扫';

export function useMonitor(opts?: Opts): void {
  const onAppliedRef = useRef(opts?.onApplied);
  onAppliedRef.current = opts?.onApplied;

  useEffect(() => {
    const st = useStore.getState();

    const handleChanges = (payload: { volume: string; dirs: UsnChangeDir[]; dropped: number }) => {
      if (!payload || !Array.isArray(payload.dirs) || payload.dirs.length === 0) return;
      const deltas = st.applyMonitorChanges(payload.dirs);
      onAppliedRef.current?.(deltas);
    };

    const handleState = (payload: UsnStatePayload) => {
      // 红线：监控侧任何失败不弹错误框，只走状态与事件面（emit.rs §usn://state）。
      // backlog = reason 含「建议重扫」（积压 >1000 目录降级）；reason=null = 恢复正常。
      const reason = payload.reason ?? null;
      const backlog = !!reason && reason.includes(BACKLOG_MARK);
      st.setMonitorState({ reason, backlog });
      // 降级/恢复都会反映到 status 快照，立即拉一次（不等轮询）
      void st.refreshMonitorStatus();
    };

    if (isTauri) {
      let un1: (() => void) | null = null;
      let un2: (() => void) | null = null;
      let dead = false;
      void import('@tauri-apps/api/event').then(({ listen }) =>
        listen<{ volume: string; dirs: UsnChangeDir[]; dropped: number }>('usn://changes', (e) => handleChanges(e.payload)),
      ).then((u) => { if (dead) u(); else un1 = u; });
      void import('@tauri-apps/api/event').then(({ listen }) =>
        listen<UsnStatePayload>('usn://state', (e) => handleState(e.payload)),
      ).then((u) => { if (dead) u(); else un2 = u; });
      return () => {
        dead = true;
        un1?.();
        un2?.();
      };
    }

    // 浏览器预览模式：mock 事件通道（假变更序列驱动，:1420 能看到数字动）
    const off1 = mockListen('usn://changes', (p) => handleChanges(p as { volume: string; dirs: UsnChangeDir[]; dropped: number }));
    const off2 = mockListen('usn://state', (p) => handleState(p as UsnStatePayload));
    return () => {
      off1();
      off2();
    };
    // st 快照里的 applyMonitorChanges/setMonitorState 是 zustand 稳定引用，可安全只挂一次
  }, []);

  // 状态行轮询：任一卷监控中时每 2s 拉一次 monitor_status（events_per_sec /
  // last_refresh 是后端滚动值，事件面没有它）。无卷监控时不轮询。
  useEffect(() => {
    let timer: number | null = null;
    const tick = () => {
      void useStore.getState().refreshMonitorStatus();
    };
    const sync = () => {
      const active = useStore.getState().monitorVolumes.some((v) => v.running);
      if (active && timer === null) {
        tick();
        timer = window.setInterval(tick, 2000);
      } else if (!active && timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    sync();
    const unsub = useStore.subscribe(sync);
    return () => {
      unsub();
      if (timer !== null) window.clearInterval(timer);
    };
  }, []);
}

/** migrate://progress 的 phase → 中文标签（迁移进度条用）。 */
export const MIGRATE_PHASE_LABEL: Record<MigratePhase, string> = {
  copying: '复制中',
  verifying: '校验中',
  deleting: '删除源中',
  done: '完成',
  rolled_back: '已回滚',
};
