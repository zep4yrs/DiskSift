import type { CSSProperties } from 'react';
import ICON_PATHS from '../../../../docs/_icons.json';

// 图标纪律（redesign-spec 硬约束）：一律 Lucide 提取路径，禁止手绘 SVG。
// 数据源 docs/_icons.json —— 从 node_modules/.pnpm/lucide-react@0.577.0*/
// dist/esm/icons 提取（"home" 同样提取自 house.js；NO_NODE 条目不渲染）。
const PATHS = ICON_PATHS as Record<string, string>;

export type IconName = keyof typeof ICON_PATHS;

export function Icon({
  name,
  size = 16,
  style,
}: {
  name: IconName | (string & {});
  size?: number;
  style?: CSSProperties;
}) {
  const d = PATHS[name];
  if (!d || d === 'NO_NODE') return null;
  return (
    <span className="svg" aria-hidden style={style}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        dangerouslySetInnerHTML={{ __html: d }}
      />
    </span>
  );
}
