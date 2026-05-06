import { useEffect, useRef, useState, type ReactNode } from 'react';

type Mode = 'recycle' | 'quarantine' | 'delete';
type Granularity = 'file' | 'directory';

type Props = {
  className?: string;
  disabled?: boolean;
  title?: string;
  /** Number of items the action will process. Interpretation depends on
   *  `granularity`: 'file' = individual file entries; 'directory' = whole
   *  directory trees moved as a single shell operation. Used only to shape
   *  the duration estimate. */
  estimatedCount: number;
  granularity?: Granularity;
  mode?: Mode;
  onAction: () => Promise<void>;
  idleContent: ReactNode;
  runningLabel?: string;
};

// Throughput rates (entries/sec). The product of mode × granularity is the
// dominant cost shape. File-level recycle pays a per-file shell + Defender
// tax; directory-level recycle is a single same-volume rename (~instant)
// with cross-volume copy fallback as the worst case. Over-estimating just
// makes the bar climb slower; under-estimating pins it at 92% sooner — the
// real promise resolution always jumps to 100% regardless.
const RATE_TABLE: Record<Mode, Record<Granularity, number>> = {
  recycle:    { file: 700,  directory: 8 },
  quarantine: { file: 60,   directory: 8 },
  delete:     { file: 1500, directory: 12 },
};

// Don't render the progress visual unless the action is still running after
// this delay. Sub-second cleans never reveal — there's nothing to
// communicate when work is already done. Errors are exempt: a failure
// always reveals, even if it happened in the grace period.
const REVEAL_AFTER_MS = 800;

// Once revealed, hold the bar on screen at least this long even if onAction
// resolves immediately afterward. Prevents a flash where the bar pops to
// 100% and disappears before the eye can register it.
const MIN_VISIBLE_MS = 700;

type State = 'idle' | 'pending' | 'revealing' | 'success' | 'error';

export function ProgressButton({
  className,
  disabled,
  title,
  estimatedCount,
  granularity = 'file',
  mode = 'recycle',
  onAction,
  idleContent,
  runningLabel = '清理中',
}: Props) {
  const [state, setState] = useState<State>('idle');
  const [progress, setProgress] = useState(0);
  const revealedAtRef = useRef<number>(0);
  const revealTimerRef = useRef<number | null>(null);
  const progressIntervalRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (revealTimerRef.current !== null) window.clearTimeout(revealTimerRef.current);
    if (progressIntervalRef.current !== null) window.clearInterval(progressIntervalRef.current);
  }, []);

  const stopReveal = () => {
    if (revealTimerRef.current !== null) {
      window.clearTimeout(revealTimerRef.current);
      revealTimerRef.current = null;
    }
  };
  const stopProgress = () => {
    if (progressIntervalRef.current !== null) {
      window.clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
  };

  const click = async () => {
    if (state !== 'idle' || disabled) return;

    const rate = RATE_TABLE[mode][granularity];
    const estimatedMs = Math.max(200, (estimatedCount / rate) * 1000);

    setState('pending');
    setProgress(0);

    revealTimerRef.current = window.setTimeout(() => {
      revealTimerRef.current = null;
      revealedAtRef.current = performance.now();
      setState('revealing');
      progressIntervalRef.current = window.setInterval(() => {
        const elapsed = performance.now() - revealedAtRef.current;
        // Asymptotic curve over the time remaining after reveal. 92% cap
        // ensures the bar never claims completion ahead of the real promise.
        const remaining = Math.max(400, estimatedMs - REVEAL_AFTER_MS);
        const ratio = elapsed / remaining;
        const next = Math.min(0.92, 1 - Math.exp(-1.6 * ratio));
        setProgress(next);
      }, 50);
    }, REVEAL_AFTER_MS);

    try {
      await onAction();
      if (revealTimerRef.current !== null) {
        // Resolved before reveal — sub-second clean, skip visual entirely.
        stopReveal();
        setState('idle');
        return;
      }
      stopProgress();
      const visibleFor = performance.now() - revealedAtRef.current;
      const remainingHold = Math.max(0, MIN_VISIBLE_MS - visibleFor);
      if (remainingHold > 0) await new Promise((r) => setTimeout(r, remainingHold));
      setProgress(1);
      setState('success');
      window.setTimeout(() => {
        setState('idle');
        setProgress(0);
      }, 280);
    } catch (e) {
      // Errors always surface, even sub-reveal failures.
      stopReveal();
      stopProgress();
      setProgress(1);
      setState('error');
      window.setTimeout(() => {
        setState('idle');
        setProgress(0);
      }, 1600);
      throw e;
    }
  };

  const pct = Math.round(progress * 100);
  const showProgress = state === 'revealing' || state === 'success' || state === 'error';

  const cls = [
    className ?? '',
    'progress-button',
    showProgress ? 'is-progressing' : '',
    state === 'success' ? 'is-success' : '',
    state === 'error' ? 'is-error' : '',
  ].filter(Boolean).join(' ');

  return (
    <button
      type="button"
      className={cls}
      disabled={disabled || state !== 'idle'}
      title={title}
      onClick={click}
    >
      <span
        className="progress-button-fill"
        style={{ width: `${pct}%` }}
        aria-hidden
      />
      <span className="progress-button-content">
        {state === 'revealing' ? (
          <>
            {runningLabel}… <span className="progress-button-pct">{pct}%</span>
          </>
        ) : state === 'error' ? (
          <>失败</>
        ) : (
          idleContent
        )}
      </span>
    </button>
  );
}
