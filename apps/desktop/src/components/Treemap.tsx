import { useMemo } from 'react';
import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy';
import type { Node } from '../types';
import { formatBytes } from '../format';

type Props = {
  node: Node;
  width: number;
  height: number;
  onSelect: (path: string) => void;
  selectedPath: string | null;
};

const PALETTE = [
  '#ff6fa8', '#f472b6', '#ec4899', '#fb7185', '#e879f9',
  '#c084fc', '#a855f7', '#fda4af', '#f9a8d4', '#ffb3cf',
  '#fb923c', '#facc15',
];

function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

export function Treemap({ node, width, height, onSelect, selectedPath }: Props) {
  const layout = useMemo(() => {
    const root = hierarchy<Node>({ ...node, children: node.children.slice(0, 200) } as Node, (d) =>
      d.children?.filter((c) => c.size > 0),
    )
      .sum((d) => (d.children && d.children.length ? 0 : Math.max(1, d.size)))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const laidOut = treemap<Node>()
      .size([width, height])
      .tile(treemapSquarify)
      .paddingOuter(2)
      .paddingInner(1)(root);
    return laidOut.descendants().filter((n) => n.depth >= 1 && n.depth <= 2);
  }, [node, width, height]);

  return (
    <svg width={width} height={height} className="treemap">
      {layout.map((d, i) => {
        const x = d.x0;
        const y = d.y0;
        const w = d.x1 - d.x0;
        const h = d.y1 - d.y0;
        const isSelected = d.data.path === selectedPath;
        const fill = colorFor(d.data.name);
        return (
          <g key={i} onClick={() => onSelect(d.data.path)} style={{ cursor: 'pointer' }}>
            <rect
              x={x}
              y={y}
              width={w}
              height={h}
              fill={fill}
              fillOpacity={d.depth === 1 ? 0.78 : 0.5}
              stroke={isSelected ? '#fde6ee' : 'rgba(20,8,15,0.55)'}
              strokeWidth={isSelected ? 2 : 1}
            />
            {w > 70 && h > 22 && (
              <text x={x + 6} y={y + 16} fill="rgba(22,10,18,0.92)" fontSize={11} fontWeight={700}>
                {d.data.name}
              </text>
            )}
            {w > 70 && h > 36 && (
              <text x={x + 6} y={y + 30} fill="rgba(22,10,18,0.72)" fontSize={10}>
                {formatBytes(d.data.size)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
