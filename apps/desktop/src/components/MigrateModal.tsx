import { useEffect, useRef, useState } from 'react';
import { ArrowRightLeft } from 'lucide-react';
import { api } from '../api';
import { isTauri } from '../env';
import { mockListen } from '../mocks';
import { formatBytes, formatCount } from '../format';
import { MIGRATE_PHASE_LABEL } from '../useMonitor';
import type { MigrateProgressPayload, UndoEntry } from '../types';

// ── 迁移 UI（v26.1.4.0 §2.2）：目标盘选择器 + migrate://progress 进度条 ──────
// 由三处复用：分诊「迁移」判定行（TriageView）、详情卡「迁移到…」（BlockDetailCard）、
// 操作记录「回迁」（RecordsView 反向调 migrate_paths）。
// 安全语义（后端 MoveEngine 承担）：同卷 rename 瞬时；跨盘并行复制 + SHA-256
// 校验 + 校验通过才删源；任意失败回滚已复制目标文件，绝不删源。前端只做选盘、
// 进度展示与结果提示；rolled_back 显示「已回滚 · 源完好」。
// 进度经 CONTRACT 'migrate://progress' 事件（桌面 listen / 浏览器 mockListen）。

type Props = {
  /** 要迁移的目录（当前实现单目录；数组留批量语义） */
  paths: string[];
  /** 动作文案（默认「迁移」；操作记录回迁传「回迁」） */
  actionLabel?: string;
  onClose: () => void;
  /** 迁移完成（含失败/回滚后关闭）回调：RecordsView 用来重拉台账 */
  onDone?: (entries: UndoEntry[] | null) => void;
};

interface VolumeRow {
  letter: string;
  total: number;
  free: number;
}

function driveOf(p: string): string {
  return /^[A-Za-z]:/.test(p) ? `${p[0]}:` : '';
}

/** 枚举本机盘符卷（CONTRACT 无列卷命令：A–Z 逐个 volume_info 探测，失败即无此盘）。 */
async function probeVolumes(): Promise<VolumeRow[]> {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const rows = await Promise.all(
    letters.map((letter) =>
      api
        .volumeInfo(`${letter}:\\`)
        .then((info) => (info ? { letter, total: info.total_bytes, free: info.free_bytes } : null))
        .catch(() => null),
    ),
  );
  return (rows.filter(Boolean) as VolumeRow[]).sort((a, b) => a.letter.localeCompare(b.letter));
}

export function MigrateModal({ paths, actionLabel = '迁移', onClose, onDone }: Props) {
  const src = paths[0] ?? '';
  const srcDrive = driveOf(src);
  const [volumes, setVolumes] = useState<VolumeRow[] | null>(null);
  const [phase, setPhase] = useState<'pick' | 'running' | 'done' | 'error'>('pick');
  const [progress, setProgress] = useState<MigrateProgressPayload | null>(null);
  const [finalMsg, setFinalMsg] = useState<string | null>(null);
  const busyRef = useRef(false);

  // 打开即枚举卷（探测失败 = 无此盘符，静默跳过）
  useEffect(() => {
    let dead = false;
    probeVolumes()
      .then((rows) => { if (!dead) setVolumes(rows); })
      .catch(() => { if (!dead) setVolumes([]); });
    return () => { dead = true; };
  }, []);

  // rolled_back 判定读最新 progress（闭包里的 state 是旧的，走 ref）
  const progressRef = useRef<MigrateProgressPayload | null>(null);
  progressRef.current = progress;
  const rolledBackNow = (p: MigrateProgressPayload | null) => p?.phase === 'rolled_back';

  // 迁移执行：订阅进度 → 调 migrate_paths → 完成收尾（unsub 在 finally 前同步摘除）
  const run = (letter: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setPhase('running');
    setProgress(null);
    setFinalMsg(null);
    let off: (() => void) | null = null;
    const unsub = () => { off?.(); off = null; };
    if (isTauri) {
      void import('@tauri-apps/api/event').then(({ listen }) =>
        listen<MigrateProgressPayload>('migrate://progress', (e) => setProgress(e.payload)),
      ).then((u) => { off = u; });
    } else {
      off = mockListen('migrate://progress', (p) => setProgress(p as MigrateProgressPayload));
    }
    api
      .migratePaths(paths, `${letter}:`)
      .then((entries) => {
        setPhase('done');
        setFinalMsg(rolledBackNow(progressRef.current)
          ? '迁移失败，已回滚 · 源完好'
          : `${actionLabel}完成：${src} → ${entries[0]?.destination ?? `${letter}:`}`);
        onDone?.(entries);
      })
      .catch((e) => {
        setPhase('error');
        setFinalMsg(rolledBackNow(progressRef.current)
          ? `${actionLabel}失败，已回滚 · 源完好：${String(e)}`
          : `${actionLabel}失败：${String(e)}`);
        onDone?.(null);
      })
      .finally(unsub);
  };

  const pct = progress && progress.bytes_total > 0
    ? Math.min(100, Math.round((progress.bytes_done / progress.bytes_total) * 100))
    : null;

  return (
    <div className="modal-bg" onClick={phase === 'running' ? undefined : onClose}>
      <div className="card migrate-modal" onClick={(e) => e.stopPropagation()}>
        <span className="sec-title">
          <ArrowRightLeft size={14} /> {actionLabel}到…
        </span>
        <div className="cell">
          <span className="cell-label">源目录</span>
          <span className="cell-value path-clip" title={src}>{src}</span>
        </div>
        <div className="cell">
          <span className="cell-label">体量</span>
          <span className="cell-value">{progress ? formatBytes(progress.bytes_total) : '—'}</span>
        </div>

        {phase === 'pick' && (
          <div className="migrate-volumes" role="listbox" aria-label="目标盘选择">
            {volumes === null ? (
              <div className="muted small">正在枚举本机卷…</div>
            ) : volumes.length === 0 ? (
              <div className="muted small">没有枚举到任何可用卷。</div>
            ) : (
              volumes.map((v) => {
                const same = srcDrive === `${v.letter}:`;
                return (
                  <button
                    key={v.letter}
                    className="migrate-volume"
                    role="option"
                    aria-selected={false}
                    title={same ? '同盘迁移：改名瞬时完成' : '跨盘迁移：并行复制 + 校验，通过才删源'}
                    onClick={() => run(v.letter)}
                  >
                    <span className="migrate-vol-letter mono">{v.letter}:</span>
                    <span className="migrate-vol-meta">
                      剩余 {formatBytes(v.free)} / 共 {formatBytes(v.total)}
                    </span>
                    <span className={'badge ' + (same ? '' : 'info')}>{same ? '同盘 · 瞬时改名' : '跨盘 · 复制+校验'}</span>
                  </button>
                );
              })
            )}
            <p className="muted small" style={{ margin: '6px 0 0' }}>
              跨盘迁移会先复制再校验（SHA-256），校验通过才删源；任何一步失败都会回滚，源目录完好无损。
            </p>
          </div>
        )}

        {phase === 'running' && (
          <div className="migrate-progress">
            <div className="scan-bar">
              <div
                className={'scan-bar-fill' + (pct !== null ? ' determinate' : ' indeterminate')}
                style={pct !== null ? { width: `${pct}%` } : undefined}
              />
              <div className="scan-bar-label">
                {progress
                  ? `${MIGRATE_PHASE_LABEL[progress.phase]} · ${pct ?? 0}% · ${formatBytes(progress.bytes_done)} / ${formatBytes(progress.bytes_total)} · ${formatCount(progress.files_done)} / ${formatCount(progress.files_total)} 文件`
                  : '准备迁移…'}
              </div>
            </div>
          </div>
        )}

        {(phase === 'done' || phase === 'error') && finalMsg && (
          <div className={phase === 'done' ? 'ok' : 'error'}>{finalMsg}</div>
        )}

        <div className="overview-actions">
          <button className="btn ghost" onClick={onClose} disabled={phase === 'running'}>
            {phase === 'running' ? '迁移中…' : '关闭'}
          </button>
        </div>
      </div>
    </div>
  );
}
