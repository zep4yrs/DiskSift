import logoUrl from '../assets/logo.png';

// DiskSift 品牌标记：渲染 AI 生成的品牌图（磁盘+漏斗，logo-source.png 全套图标的同源）。
// 图标纪律说明：品牌 logo 是定制图形（Lucide-only 规则约束的是 UI 功能图标，不含品牌标）。
export function Logo({ size = 18 }: { size?: number }) {
  return (
    <img
      src={logoUrl}
      width={size}
      height={size}
      alt=""
      aria-hidden
      style={{ borderRadius: 3, display: 'block', flexShrink: 0 }}
    />
  );
}
