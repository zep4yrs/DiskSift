import { Focus } from 'lucide-react';
import { VERDICT_META, type Verdict } from '../triage-cache';

// 图例条（triage-overlay-spec §3：常驻 tab 工具行）。
// migrate / uncertain 在 O1 规则层不产出判定，占位展示保证五判定语义色全站一致；
// 「只看可清理」聚焦开关（spec §2.1.2）：开启后非可清理块淡至 12%，再点退出。
// 开关状态提升在 App（图例与地图/树视图分处不同子树，经 props 下传）。
const LEGEND_ORDER: Verdict[] = ['safe', 'decide', 'migrate', 'system', 'uncertain'];

type Props = {
  /** 聚焦模式开启中（App 状态） */
  focusClean?: boolean;
  /** 开关回调；不传则按钮退回禁用占位（无消费方的裸图例仍可用） */
  onToggleFocusClean?: () => void;
};

export function TriageLegend({ focusClean = false, onToggleFocusClean }: Props) {
  return (
    <div className="triage-legend" role="list" aria-label="分诊判定图例">
      {LEGEND_ORDER.map((v) => (
        <span key={v} className="lg-item" role="listitem" title={VERDICT_META[v].description}>
          <span className={`lg-sw ${v}`} aria-hidden />
          {VERDICT_META[v].label}
          {v === 'migrate' && <sup className="lg-sup">v2</sup>}
        </span>
      ))}
      <button
        className={'lg-btn' + (focusClean ? ' active' : '')}
        disabled={!onToggleFocusClean}
        aria-pressed={focusClean}
        aria-label={focusClean ? '只看可清理（开启中，再点退出）' : '只看可清理'}
        title={focusClean
          ? '「只看可清理」聚焦模式开启中：非可清理块已淡至 12% · 再点退出'
          : '「只看可清理」聚焦模式（spec §2.1.2）：非可清理块淡至 12%，可清理块保持高亮'}
        onClick={onToggleFocusClean}
      >
        <Focus size={12} /> 只看可清理
      </button>
    </div>
  );
}
