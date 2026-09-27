import { Focus } from 'lucide-react';
import { VERDICT_META, type Verdict } from '../triage-cache';

// 图例条（triage-overlay-spec §3：常驻 tab 工具行）。
// migrate / uncertain 在 O1 规则层不产出判定，占位展示保证五判定语义色全站一致；
// 「只看可清理」聚焦开关为 O2 占位（spec §2.1.2：开启后非可清理块淡至 12%）。
const LEGEND_ORDER: Verdict[] = ['safe', 'decide', 'migrate', 'system', 'uncertain'];

export function TriageLegend() {
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
        className="lg-btn"
        disabled
        title="「只看可清理」聚焦模式 · 下一阶段开放"
        aria-label="只看可清理（下一阶段开放）"
      >
        <Focus size={12} /> 只看可清理
      </button>
    </div>
  );
}
